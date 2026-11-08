import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  goodsReceiptLines,
  goodsReceipts,
  items,
  orgCounters,
  packs,
  purchaseOrderLines,
  purchaseOrders,
  sites,
  spendLimits,
  supplierItems,
  supplierSiteSettings,
  tradingRelationships,
  type Tx,
} from '@boh/db';
import { Decimal, localParts, nextDeliveryDate, orderTotals } from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';
import { emitEvent } from '../agents/events.js';
import { StockModule, StockService } from './stock.js';
import { SuppliersModule, SuppliersService } from './suppliers.js';

const uuid = new ParseUUIDPipe({ version: '4' });
const OPEN_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'partially_received'] as const;
type PoRow = typeof purchaseOrders.$inferSelect;
type PoStatus = PoRow['status'];

const LineInput = z
  .object({
    supplierItemId: z.string().uuid().optional(),
    itemId: z.string().uuid().optional(),
    packId: z.string().uuid().optional(),
    qty: z.coerce.number().positive().max(100_000),
    unitPrice: z.coerce.number().min(0).max(10_000_000).optional(),
  })
  .refine((l) => l.supplierItemId || (l.itemId && l.packId), { message: 'Give supplierItemId, or itemId and packId' });
export type LineInputT = z.infer<typeof LineInput>;

const CreatePoSchema = z.object({
  siteId: z.string().uuid(),
  relationshipId: z.string().uuid(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  notes: z.string().max(2000).nullish(),
  lines: z.array(LineInput).min(1).max(300),
  /** Submit straight away (spend limits decide whether approval is needed). */
  submit: z.boolean().default(false),
});
class CreatePoDto extends createZodDto(CreatePoSchema) {}
export type CreatePoInput = z.infer<typeof CreatePoSchema>;

const UpdatePoSchema = z.object({
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  notes: z.string().max(2000).nullish(),
  lines: z.array(LineInput).min(1).max(300).optional(),
});
class UpdatePoDto extends createZodDto(UpdatePoSchema) {}

const ListSchema = z.object({
  status: z.enum(['open', 'all', 'draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled']).default('open'),
  siteId: z.string().uuid().optional(),
  relationshipId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
class ListDto extends createZodDto(ListSchema) {}

const SendSchema = z.object({ via: z.enum(['email', 'whatsapp', 'portal', 'manual']).optional() });
class SendDto extends createZodDto(SendSchema) {}

const ReceiveSchema = z.object({
  documentNo: z.string().max(60).nullish(),
  note: z.string().max(1000).nullish(),
  lines: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        qty: z.coerce.number().min(0).max(100_000),
        /** Price on the delivery note / invoice, per pack. Defaults to the ordered price. */
        unitPrice: z.coerce.number().min(0).max(10_000_000).optional(),
      }),
    )
    .min(1),
  /** When the delivered price differs, record it as the supplier's new price. */
  updatePrices: z.boolean().default(true),
});
class ReceiveDto extends createZodDto(ReceiveSchema) {}

const LimitSchema = z.object({
  siteId: z.string().uuid().nullish(),
  relationshipId: z.string().uuid().nullish(),
  period: z.enum(['order', 'month']),
  amount: z.coerce.number().min(0).max(100_000_000),
});
class LimitDto extends createZodDto(LimitSchema) {}

const NoteSchema = z.object({ note: z.string().max(1000).nullish() });
class NoteDto extends createZodDto(NoteSchema) {}

@Injectable()
export class ProcurementService {
  constructor(
    private readonly db: DbService,
    private readonly stock: StockService,
    private readonly suppliers: SuppliersService,
  ) {}

  private async nextNumber(tx: Tx, orgId: string, key: 'po' | 'grn'): Promise<string> {
    const [row] = await tx
      .insert(orgCounters)
      .values({ orgId, key, value: 1 })
      .onConflictDoUpdate({ target: [orgCounters.orgId, orgCounters.key], set: { value: sql`${orgCounters.value} + 1` } })
      .returning();
    return `${key === 'po' ? 'PO' : 'GRN'}-${String(row!.value).padStart(5, '0')}`;
  }

  private async load(tx: Tx, id: string): Promise<PoRow> {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for('update');
    if (!po) throw new NotFoundException('purchase order not found');
    return po;
  }

  private mustSite(a: AccessContext, perm: string, siteId: string) {
    if (!a.can(perm, siteId)) throw new ForbiddenException(`Missing permission ${perm} for this site`);
  }

  private async setStatus(tx: Tx, a: AccessContext, po: PoRow, status: PoStatus, extra: Partial<typeof purchaseOrders.$inferInsert> = {}) {
    const [after] = await tx.update(purchaseOrders).set({ status, ...extra }).where(eq(purchaseOrders.id, po.id)).returning();
    await emitEvent(tx, a, 'po.status_changed', { type: 'purchase_order', id: po.id }, { poId: po.id, number: po.number, siteId: po.siteId, relationshipId: po.relationshipId, from: po.status, to: status });
    await audit(tx, a, { action: `purchase_order.${status}`, entityType: 'purchase_order', entityId: po.id, before: { status: po.status }, after: { status, ...extra } });
    return after!;
  }

  /** Resolve lines to item/pack/price from the supplier's catalogue. */
  private async resolveLines(tx: Tx, relationshipId: string, lines: LineInputT[]) {
    const out: { itemId: string; packId: string; supplierItemId: string | null; qty: string; unitPrice: string }[] = [];
    for (const l of lines) {
      let si: typeof supplierItems.$inferSelect | undefined;
      if (l.supplierItemId) {
        [si] = await tx.select().from(supplierItems).where(and(eq(supplierItems.id, l.supplierItemId), eq(supplierItems.relationshipId, relationshipId)));
        if (!si) throw new BadRequestException('A line refers to an item this supplier does not sell');
      } else {
        const [pack] = await tx.select().from(packs).where(and(eq(packs.id, l.packId!), eq(packs.itemId, l.itemId!)));
        if (!pack) throw new BadRequestException('packId is not a pack of itemId');
        [si] = await tx.select().from(supplierItems).where(and(eq(supplierItems.relationshipId, relationshipId), eq(supplierItems.packId, l.packId!)));
        if (!si && l.unitPrice === undefined) throw new BadRequestException('unitPrice is needed for items not in this supplier’s catalogue');
      }
      const price = l.unitPrice !== undefined ? new Decimal(l.unitPrice) : new Decimal(si!.currentPrice);
      out.push({
        itemId: si?.itemId ?? l.itemId!,
        packId: si?.packId ?? l.packId!,
        supplierItemId: si?.id ?? null,
        qty: new Decimal(l.qty).toFixed(3),
        unitPrice: price.toFixed(4),
      });
    }
    return out;
  }

  private async writeLines(tx: Tx, orgId: string, poId: string, lines: Awaited<ReturnType<ProcurementService['resolveLines']>>, taxRate: string) {
    const totals = orderTotals(lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice })), taxRate);
    await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
    await tx.insert(purchaseOrderLines).values(lines.map((l, i) => ({ ...l, orgId, poId, lineTotal: totals.lineTotals[i]!, sortOrder: i })));
    await tx.update(purchaseOrders).set({ subtotal: totals.subtotal, taxTotal: totals.tax, total: totals.total }).where(eq(purchaseOrders.id, poId));
    return totals;
  }

  /** Earliest delivery date from the supplier's schedule for the site. */
  async suggestDeliveryDate(tx: Tx, relationshipId: string, siteId: string, now = new Date()): Promise<string> {
    const [site] = await tx.select({ tz: sites.timezone }).from(sites).where(eq(sites.id, siteId));
    const [sched] = await tx
      .select()
      .from(supplierSiteSettings)
      .where(and(eq(supplierSiteSettings.relationshipId, relationshipId), eq(supplierSiteSettings.siteId, siteId)));
    return nextDeliveryDate(now, site?.tz ?? 'Asia/Riyadh', {
      deliveryDays: sched?.deliveryDays ?? [],
      cutoffTime: sched?.cutoffTime,
      leadTimeDays: sched?.leadTimeDays ?? 1,
    });
  }

  /** Create a PO in the caller's transaction (used by the API and by agents). */
  async createInTx(tx: Tx, a: AccessContext, dto: CreatePoInput, opts: { source?: string; agentTaskId?: string } = {}) {
    this.mustSite(a, 'po:manage', dto.siteId);
    const [rel] = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, dto.relationshipId));
    if (!rel) throw new NotFoundException('supplier not found');
    if (!rel.isActive) throw new BadRequestException('This supplier is inactive');
    const [site] = await tx.select().from(sites).where(eq(sites.id, dto.siteId));
    if (!site) throw new NotFoundException('site not found');
    const lines = await this.resolveLines(tx, rel.id, dto.lines);
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        orgId: a.orgId,
        number: await this.nextNumber(tx, a.orgId, 'po'),
        siteId: dto.siteId,
        relationshipId: rel.id,
        deliveryDate: dto.deliveryDate ?? (await this.suggestDeliveryDate(tx, rel.id, dto.siteId)),
        currency: rel.currency,
        taxRate: rel.taxRate,
        notes: dto.notes ?? null,
        source: opts.source ?? 'manual',
        agentTaskId: opts.agentTaskId ?? null,
        createdBy: a.userId,
      })
      .returning();
    await this.writeLines(tx, a.orgId, po!.id, lines, rel.taxRate);
    await audit(tx, a, { action: 'purchase_order.created', entityType: 'purchase_order', entityId: po!.id, after: { number: po!.number, source: po!.source, lines: lines.length } });
    let result = (await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, po!.id)))[0]!;
    if (dto.submit) result = await this.submitInTx(tx, a, result);
    return result;
  }

  create(a: AccessContext, dto: CreatePoDto) {
    return this.db.tenant(a.tenant, (tx) => this.createInTx(tx, a, dto));
  }

  async update(a: AccessContext, id: string, dto: UpdatePoDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const po = await this.load(tx, id);
      this.mustSite(a, 'po:manage', po.siteId);
      if (po.status !== 'draft') throw new BadRequestException('Only draft orders can be edited');
      if (dto.lines) await this.writeLines(tx, a.orgId, po.id, await this.resolveLines(tx, po.relationshipId, dto.lines), po.taxRate);
      const values: Partial<typeof purchaseOrders.$inferInsert> = {};
      if (dto.deliveryDate !== undefined) values.deliveryDate = dto.deliveryDate;
      if (dto.notes !== undefined) values.notes = dto.notes;
      if (Object.keys(values).length) await tx.update(purchaseOrders).set(values).where(eq(purchaseOrders.id, po.id));
      await audit(tx, a, { action: 'purchase_order.updated', entityType: 'purchase_order', entityId: po.id, after: { ...values, lines: dto.lines?.length } });
      return this.detailInTx(tx, a, po.id);
    });
  }

  /** Which spend limits does this order break? Returns a reason, or null if none. */
  async limitBreach(tx: Tx, po: PoRow): Promise<string | null> {
    const limits = await tx
      .select()
      .from(spendLimits)
      .where(
        and(
          or(isNull(spendLimits.siteId), eq(spendLimits.siteId, po.siteId)),
          or(isNull(spendLimits.relationshipId), eq(spendLimits.relationshipId, po.relationshipId)),
        ),
      );
    const total = new Decimal(po.total);
    for (const l of limits.filter((x) => x.period === 'order')) {
      if (total.gt(l.amount)) return `Order total SAR ${total.toFixed(2)} is above the per-order limit of SAR ${new Decimal(l.amount).toFixed(2)}\nإجمالي الطلب ${total.toFixed(2)} ر.س أعلى من حد الطلب الواحد ${new Decimal(l.amount).toFixed(2)} ر.س`;
    }
    const monthly = limits.filter((x) => x.period === 'month');
    if (monthly.length) {
      const [site] = await tx.select({ tz: sites.timezone }).from(sites).where(eq(sites.id, po.siteId));
      const monthStart = `${localParts(new Date(), site?.tz ?? 'Asia/Riyadh').date.slice(0, 7)}-01`;
      for (const l of monthly) {
        const [spent] = await tx
          .select({ s: sql<string>`coalesce(sum(${purchaseOrders.total}), 0)::text` })
          .from(purchaseOrders)
          .where(
            and(
              eq(purchaseOrders.siteId, po.siteId),
              l.relationshipId ? eq(purchaseOrders.relationshipId, l.relationshipId) : undefined,
              inArray(purchaseOrders.status, ['approved', 'sent', 'partially_received', 'received', 'closed']),
              gte(purchaseOrders.approvedAt, new Date(`${monthStart}T00:00:00+03:00`)),
              ne(purchaseOrders.id, po.id),
            ),
          );
        const after = new Decimal(spent?.s ?? 0).plus(total);
        if (after.gt(l.amount)) return `This order takes month-to-date spend to SAR ${after.toFixed(2)}, above the monthly limit of SAR ${new Decimal(l.amount).toFixed(2)}\nهذا الطلب يرفع إنفاق الشهر إلى ${after.toFixed(2)} ر.س، أعلى من الحد الشهري ${new Decimal(l.amount).toFixed(2)} ر.س`;
      }
    }
    return null;
  }

  async submitInTx(tx: Tx, a: AccessContext, po: PoRow) {
    if (po.status !== 'draft') throw new BadRequestException(`Order is already ${po.status}`);
    const breach = await this.limitBreach(tx, po);
    if (breach) return this.setStatus(tx, a, po, 'pending_approval', { submittedAt: new Date(), approvalReason: breach });
    return this.setStatus(tx, a, po, 'approved', { submittedAt: new Date(), approvedAt: new Date(), approvedBy: a.userId, approvalReason: null });
  }

  submit(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const po = await this.load(tx, id);
      this.mustSite(a, 'po:manage', po.siteId);
      return this.submitInTx(tx, a, po);
    });
  }

  approve(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const po = await this.load(tx, id);
      this.mustSite(a, 'po:approve', po.siteId);
      if (po.status !== 'pending_approval') throw new BadRequestException(`Order is ${po.status}, not waiting for approval`);
      // Separation of duties: you can't approve an order you created (org admins excepted).
      if (po.createdBy === a.userId && !a.grants.some((g) => g.permissions.includes('*'))) throw new ForbiddenException('Someone else must approve an order you created');
      return this.setStatus(tx, a, po, 'approved', { approvedAt: new Date(), approvedBy: a.userId });
    });
  }

  returnToDraft(a: AccessContext, id: string, note: string | null) {
    return this.db.tenant(a.tenant, async (tx) => {
      const po = await this.load(tx, id);
      this.mustSite(a, 'po:manage', po.siteId);
      if (!['pending_approval', 'approved'].includes(po.status)) throw new BadRequestException(`Order is ${po.status}`);
      return this.setStatus(tx, a, po, 'draft', { approvedAt: null, approvedBy: null, approvalReason: note ?? po.approvalReason });
    });
  }

  /** Mark as sent and return a ready-to-send message (email/WhatsApp links). */
  send(a: AccessContext, id: string, via?: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const po = await this.load(tx, id);
      this.mustSite(a, 'po:manage', po.siteId);
      if (po.status !== 'approved') throw new BadRequestException(po.status === 'pending_approval' ? 'This order is waiting for approval' : `Order is ${po.status}`);
      const detail = await this.detailInTx(tx, a, po.id);
      const message = this.orderMessage(detail);
      const channel = via ?? detail.supplier.orderChannel;
      const after = await this.setStatus(tx, a, po, 'sent', { sentAt: new Date(), sentVia: channel });
      return { ...after, message, links: this.links(detail, message) };
    });
  }

  cancel(a: AccessContext, id: string, note: string | null) {
    return this.db.tenant(a.tenant, async (tx) => {
      const po = await this.load(tx, id);
      this.mustSite(a, 'po:manage', po.siteId);
      if (!['draft', 'pending_approval', 'approved', 'sent'].includes(po.status)) throw new BadRequestException(`A ${po.status} order can't be cancelled`);
      return this.setStatus(tx, a, po, 'cancelled', { cancelledAt: new Date(), notes: note ? `${po.notes ? `${po.notes}\n` : ''}Cancelled: ${note}` : po.notes });
    });
  }

  close(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const po = await this.load(tx, id);
      this.mustSite(a, 'po:manage', po.siteId);
      if (!['partially_received', 'received'].includes(po.status)) throw new BadRequestException(`A ${po.status} order can't be closed`);
      return this.setStatus(tx, a, po, 'closed');
    });
  }

  /**
   * Receive a delivery: creates a goods receipt, adds stock at the delivered
   * price (weighted average cost), updates received quantities and status,
   * and records any price change with the supplier (which Price Watch sees).
   */
  receive(a: AccessContext, id: string, dto: ReceiveDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const po = await this.load(tx, id);
      this.mustSite(a, 'stock:manage', po.siteId);
      if (!['approved', 'sent', 'partially_received'].includes(po.status)) throw new BadRequestException(`A ${po.status} order can't be received`);
      const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, po.id));
      const byId = new Map(lines.map((l) => [l.id, l]));
      const incoming = dto.lines.filter((l) => l.qty > 0);
      if (!incoming.length) throw new BadRequestException('Enter at least one received quantity');
      for (const l of incoming) if (!byId.has(l.lineId)) throw new BadRequestException('A line does not belong to this order');

      // Receipts are immutable once written, so the total is computed before inserting.
      const total = incoming.reduce((sum, r) => {
        const line = byId.get(r.lineId)!;
        return sum.plus(new Decimal(r.unitPrice ?? line.unitPrice).mul(r.qty));
      }, new Decimal(0));
      const [grn] = await tx
        .insert(goodsReceipts)
        .values({
          orgId: a.orgId,
          number: await this.nextNumber(tx, a.orgId, 'grn'),
          poId: po.id,
          siteId: po.siteId,
          receivedBy: a.userId,
          documentNo: dto.documentNo ?? null,
          note: dto.note ?? null,
          total: total.toFixed(2),
        })
        .returning();
      const priceChanges: { supplierItemId: string; from: string; to: string }[] = [];
      for (const r of incoming) {
        const line = byId.get(r.lineId)!;
        const [pack] = await tx.select().from(packs).where(eq(packs.id, line.packId));
        const price = r.unitPrice !== undefined ? new Decimal(r.unitPrice) : new Decimal(line.unitPrice);
        const qtyBase = new Decimal(r.qty).mul(pack!.baseQty);
        await tx.insert(goodsReceiptLines).values({
          orgId: a.orgId,
          receiptId: grn!.id,
          poLineId: line.id,
          itemId: line.itemId,
          qty: new Decimal(r.qty).toFixed(3),
          qtyBase: qtyBase.toFixed(6),
          unitPrice: price.toFixed(4),
          orderedUnitPrice: line.unitPrice,
        });
        await this.stock.post(tx, a, {
          siteId: po.siteId,
          itemId: line.itemId,
          type: 'receipt',
          qtyBase,
          unitCost: price.div(pack!.baseQty),
          sourceType: 'goods_receipt',
          sourceId: grn!.id,
        });
        await tx
          .update(purchaseOrderLines)
          .set({ receivedQty: new Decimal(line.receivedQty).plus(r.qty).toFixed(3) })
          .where(eq(purchaseOrderLines.id, line.id));
        if (dto.updatePrices && line.supplierItemId && !price.eq(line.unitPrice)) {
          const [si] = await tx.select().from(supplierItems).where(eq(supplierItems.id, line.supplierItemId));
          if (si && !price.eq(si.currentPrice)) {
            await this.suppliers.writePrice(tx, a, si, price.toFixed(4), 'invoice');
            priceChanges.push({ supplierItemId: si.id, from: si.currentPrice, to: price.toFixed(4) });
          }
        }
      }
      // Status: fully received when every line has at least its ordered quantity.
      const updated = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, po.id));
      const complete = updated.every((l) => new Decimal(l.receivedQty).gte(l.qty));
      await this.setStatus(tx, a, po, complete ? 'received' : 'partially_received');
      await emitEvent(tx, a, 'po.received', { type: 'purchase_order', id: po.id }, { poId: po.id, receiptId: grn!.id, siteId: po.siteId, complete });
      await audit(tx, a, { action: 'goods_receipt.posted', entityType: 'goods_receipt', entityId: grn!.id, after: { po: po.number, lines: incoming.length, total: total.toFixed(2), priceChanges } });
      return { receipt: { ...grn!, total: total.toFixed(2) }, status: complete ? 'received' : 'partially_received', priceChanges };
    });
  }

  // ---------- reading ----------

  list(a: AccessContext, q: ListDto) {
    const scope = a.sitesFor('po:read');
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select({
          id: purchaseOrders.id,
          number: purchaseOrders.number,
          status: purchaseOrders.status,
          siteId: purchaseOrders.siteId,
          siteName: sites.name,
          siteNameAr: sites.nameAr,
          relationshipId: purchaseOrders.relationshipId,
          supplierName: tradingRelationships.displayName,
          supplierNameAr: tradingRelationships.displayNameAr,
          deliveryDate: purchaseOrders.deliveryDate,
          total: purchaseOrders.total,
          source: purchaseOrders.source,
          approvalReason: purchaseOrders.approvalReason,
          createdAt: purchaseOrders.createdAt,
          lineCount: sql<number>`(select count(*)::int from purchase_order_lines l where l.po_id = "purchase_orders"."id")`,
        })
        .from(purchaseOrders)
        .innerJoin(sites, eq(sites.id, purchaseOrders.siteId))
        .innerJoin(tradingRelationships, eq(tradingRelationships.id, purchaseOrders.relationshipId))
        .where(
          and(
            q.status === 'open' ? inArray(purchaseOrders.status, [...OPEN_STATUSES]) : q.status === 'all' ? undefined : eq(purchaseOrders.status, q.status),
            q.siteId ? eq(purchaseOrders.siteId, q.siteId) : undefined,
            q.relationshipId ? eq(purchaseOrders.relationshipId, q.relationshipId) : undefined,
            scope === 'all' ? undefined : inArray(purchaseOrders.siteId, scope.length ? scope : ['00000000-0000-0000-0000-000000000000']),
          ),
        )
        .orderBy(desc(purchaseOrders.createdAt))
        .limit(q.limit),
    );
  }

  async detailInTx(tx: Tx, a: AccessContext, id: string) {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    if (!po) throw new NotFoundException('purchase order not found');
    if (!a.can('po:read', po.siteId)) throw new NotFoundException('purchase order not found');
    const [rel] = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, po.relationshipId));
    const [site] = await tx.select().from(sites).where(eq(sites.id, po.siteId));
    const lines = await tx
      .select({
        id: purchaseOrderLines.id,
        itemId: purchaseOrderLines.itemId,
        itemCode: items.code,
        itemName: items.name,
        itemNameAr: items.nameAr,
        baseUnit: items.baseUnit,
        packId: purchaseOrderLines.packId,
        packName: packs.name,
        packNameAr: packs.nameAr,
        packBaseQty: packs.baseQty,
        supplierItemId: purchaseOrderLines.supplierItemId,
        supplierSku: supplierItems.supplierSku,
        qty: purchaseOrderLines.qty,
        unitPrice: purchaseOrderLines.unitPrice,
        lineTotal: purchaseOrderLines.lineTotal,
        receivedQty: purchaseOrderLines.receivedQty,
      })
      .from(purchaseOrderLines)
      .innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
      .innerJoin(packs, eq(packs.id, purchaseOrderLines.packId))
      .leftJoin(supplierItems, eq(supplierItems.id, purchaseOrderLines.supplierItemId))
      .where(eq(purchaseOrderLines.poId, po.id))
      .orderBy(asc(purchaseOrderLines.sortOrder));
    const receipts = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.poId, po.id)).orderBy(asc(goodsReceipts.receivedAt));
    return {
      ...po,
      site: { id: site!.id, name: site!.name, nameAr: site!.nameAr },
      supplier: {
        id: rel!.id,
        name: rel!.displayName,
        nameAr: rel!.displayNameAr,
        orderChannel: rel!.orderChannel,
        contactEmail: rel!.contactEmail,
        contactPhone: rel!.contactPhone,
        minOrderValue: rel!.minOrderValue,
        hidePricesOnPo: rel!.hidePricesOnPo,
      },
      lines,
      receipts,
    };
  }

  detail(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, (tx) => this.detailInTx(tx, a, id));
  }

  /** Bilingual order message for the supplier (Arabic first). */
  orderMessage(d: Awaited<ReturnType<ProcurementService['detailInTx']>>) {
    const showPrices = !d.supplier.hidePricesOnPo;
    const ar = [
      `طلب شراء ${d.number} من ${d.site.nameAr ?? d.site.name}`,
      `التوصيل المطلوب: ${d.deliveryDate ?? '—'}`,
      ...d.lines.map((l) => `• ${l.itemNameAr ?? l.itemName} — ${Number(l.qty)} × ${l.packNameAr ?? l.packName}${l.supplierSku ? ` (${l.supplierSku})` : ''}${showPrices ? ` — ${new Decimal(l.unitPrice).toFixed(2)} ر.س` : ''}`),
      showPrices ? `الإجمالي شامل الضريبة: ${new Decimal(d.total).toFixed(2)} ر.س` : '',
      d.notes ? `ملاحظات: ${d.notes}` : '',
    ];
    const en = [
      `Purchase order ${d.number} from ${d.site.name}`,
      `Delivery requested: ${d.deliveryDate ?? '—'}`,
      ...d.lines.map((l) => `• ${l.itemName} — ${Number(l.qty)} × ${l.packName}${l.supplierSku ? ` (${l.supplierSku})` : ''}${showPrices ? ` — SAR ${new Decimal(l.unitPrice).toFixed(2)}` : ''}`),
      showPrices ? `Total incl. VAT: SAR ${new Decimal(d.total).toFixed(2)}` : '',
      d.notes ? `Notes: ${d.notes}` : '',
      'Please confirm receipt of this order. Thank you.',
    ];
    return [...ar.filter(Boolean), '', ...en.filter(Boolean)].join('\n');
  }

  links(d: Awaited<ReturnType<ProcurementService['detailInTx']>>, message: string) {
    return {
      mailto: d.supplier.contactEmail ? `mailto:${d.supplier.contactEmail}?subject=${encodeURIComponent(`${d.number} — طلب شراء / Purchase order`)}&body=${encodeURIComponent(message)}` : null,
      whatsapp: d.supplier.contactPhone ? `https://wa.me/${d.supplier.contactPhone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}` : null,
    };
  }

  /** Open quantity on order (base units) per site and item, from open POs. */
  async onOrder(tx: Tx, siteIds: string[]) {
    if (!siteIds.length) return [];
    return tx
      .select({
        siteId: purchaseOrders.siteId,
        itemId: purchaseOrderLines.itemId,
        qtyBase: sql<string>`sum(greatest(${purchaseOrderLines.qty} - ${purchaseOrderLines.receivedQty}, 0) * ${packs.baseQty})::text`,
      })
      .from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
      .innerJoin(packs, eq(packs.id, purchaseOrderLines.packId))
      .where(and(inArray(purchaseOrders.siteId, siteIds), inArray(purchaseOrders.status, [...OPEN_STATUSES])))
      .groupBy(purchaseOrders.siteId, purchaseOrderLines.itemId);
  }

  // ---------- spend limits ----------
  listLimits(a: AccessContext) {
    return this.db.tenant(a.tenant, (tx) => tx.select().from(spendLimits).orderBy(asc(spendLimits.createdAt)));
  }
  createLimit(a: AccessContext, dto: LimitDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [row] = await tx
        .insert(spendLimits)
        .values({ orgId: a.orgId, siteId: dto.siteId ?? null, relationshipId: dto.relationshipId ?? null, period: dto.period, amount: new Decimal(dto.amount).toFixed(2) })
        .returning();
      await audit(tx, a, { action: 'spend_limit.created', entityType: 'spend_limit', entityId: row!.id, after: row });
      return row;
    });
  }
  deleteLimit(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [row] = await tx.delete(spendLimits).where(eq(spendLimits.id, id)).returning();
      if (!row) throw new NotFoundException('limit not found');
      await audit(tx, a, { action: 'spend_limit.deleted', entityType: 'spend_limit', entityId: id, before: row });
    });
  }
}

@ApiTags('purchasing')
@ApiBearerAuth()
@Controller()
export class ProcurementController {
  constructor(private readonly svc: ProcurementService) {}

  @Get('purchase-orders') @Requires('po:read')
  list(@Access() a: AccessContext, @Query() q: ListDto) { return this.svc.list(a, q); }

  @Post('purchase-orders') @Requires('po:manage')
  create(@Access() a: AccessContext, @Body() dto: CreatePoDto) { return this.svc.create(a, dto); }

  @Get('purchase-orders/:id') @Requires('po:read')
  get(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.detail(a, id); }

  @Patch('purchase-orders/:id') @Requires('po:manage')
  update(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdatePoDto) { return this.svc.update(a, id, dto); }

  @Post('purchase-orders/:id/submit') @Requires('po:manage') @HttpCode(200)
  submit(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.submit(a, id); }

  @Post('purchase-orders/:id/approve') @Requires('po:approve') @HttpCode(200)
  approve(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.approve(a, id); }

  @Post('purchase-orders/:id/return') @Requires('po:manage') @HttpCode(200)
  back(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: NoteDto) { return this.svc.returnToDraft(a, id, dto.note ?? null); }

  @Post('purchase-orders/:id/send') @Requires('po:manage') @HttpCode(200)
  send(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: SendDto) { return this.svc.send(a, id, dto.via); }

  @Post('purchase-orders/:id/cancel') @Requires('po:manage') @HttpCode(200)
  cancel(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: NoteDto) { return this.svc.cancel(a, id, dto.note ?? null); }

  @Post('purchase-orders/:id/close') @Requires('po:manage') @HttpCode(200)
  close(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.close(a, id); }

  @Post('purchase-orders/:id/receive') @Requires('stock:manage') @HttpCode(200)
  receive(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: ReceiveDto) { return this.svc.receive(a, id, dto); }

  @Get('spend-limits') @Requires('po:read')
  limits(@Access() a: AccessContext) { return this.svc.listLimits(a); }

  @Post('spend-limits') @Requires('spend_limit:manage')
  createLimit(@Access() a: AccessContext, @Body() dto: LimitDto) { return this.svc.createLimit(a, dto); }

  @Delete('spend-limits/:id') @Requires('spend_limit:manage') @HttpCode(204)
  deleteLimit(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.deleteLimit(a, id); }
}

@Module({ imports: [StockModule, SuppliersModule], controllers: [ProcurementController], providers: [ProcurementService], exports: [ProcurementService] })
export class ProcurementModule {}
