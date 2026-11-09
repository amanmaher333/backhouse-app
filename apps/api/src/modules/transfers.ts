import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { items, orgCounters, packs, sites, stockBalances, stockTransferLines, stockTransfers, type Tx } from '@boh/db';
import { Decimal, UNITS } from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';
import { emitEvent } from '../agents/events.js';
import { StockModule, StockService, baseQty, stockableItems } from './stock.js';

const uuid = new ParseUUIDPipe({ version: '4' });
type TransferRow = typeof stockTransfers.$inferSelect;

const QtySchema = {
  qty: z.coerce.number().min(0).max(1e9),
  unit: z.string().refine((u) => u in UNITS, 'Unknown unit').optional(),
  packId: z.string().uuid().optional(),
};
const LineSchema = z.object({ itemId: z.string().uuid(), ...QtySchema, qty: z.coerce.number().positive().max(1e9) });
const CreateSchema = z
  .object({
    fromSiteId: z.string().uuid(),
    toSiteId: z.string().uuid(),
    lines: z.array(LineSchema).min(1).max(300),
    note: z.string().max(500).nullish(),
    /** Send straight away (takes the stock out of the source). */
    send: z.boolean().default(false),
  })
  .refine((t) => t.fromSiteId !== t.toSiteId, { message: 'Choose two different sites' });
class CreateDto extends createZodDto(CreateSchema) {}
export type CreateTransferInput = z.infer<typeof CreateSchema>;

const UpdateSchema = z.object({ lines: z.array(LineSchema).min(1).max(300).optional(), note: z.string().max(500).nullish() });
class UpdateDto extends createZodDto(UpdateSchema) {}

const ReceiveSchema = z.object({
  /** Lines that arrived differently from what was sent; lines not listed arrived in full. */
  lines: z.array(z.object({ lineId: z.string().uuid(), ...QtySchema })).max(300).default([]),
  note: z.string().max(500).nullish(),
});
class ReceiveDto extends createZodDto(ReceiveSchema) {}

const ListSchema = z.object({
  siteId: z.string().uuid().optional(),
  direction: z.enum(['in', 'out', 'both']).default('both'),
  status: z.enum(['active', 'all', 'draft', 'sent', 'received', 'cancelled']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
class ListDto extends createZodDto(ListSchema) {}

const NoteSchema = z.object({ note: z.string().max(500).nullish() });
class NoteDto extends createZodDto(NoteSchema) {}

const fromSite = alias(sites, 'from_site');
const toSite = alias(sites, 'to_site');

/**
 * Transfers between sites. Sending takes the stock out of the source at its average
 * cost; receiving adds it to the destination at that same cost, so value moves with the
 * stock. What doesn't arrive is recorded as a shortage on the transfer. A sent transfer
 * that is cancelled puts the stock back at the source.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly db: DbService,
    private readonly stock: StockService,
  ) {}

  private must(a: AccessContext, perm: string, siteId: string) {
    if (!a.can(perm, siteId)) throw new ForbiddenException(`Missing permission ${perm} for this site`);
  }

  private async nextRef(tx: Tx, orgId: string) {
    const [row] = await tx
      .insert(orgCounters)
      .values({ orgId, key: 'transfer', value: 1 })
      .onConflictDoUpdate({ target: [orgCounters.orgId, orgCounters.key], set: { value: sql`${orgCounters.value} + 1` } })
      .returning();
    return `TR-${String(row!.value).padStart(5, '0')}`;
  }

  private async load(tx: Tx, id: string): Promise<TransferRow> {
    const [t] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, id)).for('update');
    if (!t) throw new NotFoundException('transfer not found');
    return t;
  }

  private async writeLines(tx: Tx, a: AccessContext, transferId: string, lines: z.infer<typeof LineSchema>[]) {
    if (new Set(lines.map((l) => l.itemId)).size !== lines.length) throw new BadRequestException('Each item can appear once');
    const catalogue = await stockableItems(tx, lines.map((l) => l.itemId));
    await tx.delete(stockTransferLines).where(eq(stockTransferLines.transferId, transferId));
    await tx.insert(stockTransferLines).values(
      lines.map((l) => {
        const { item, packs } = catalogue.get(l.itemId)!;
        return {
          orgId: a.orgId,
          transferId,
          itemId: item.id,
          qtyBase: baseQty(item, packs, l).toFixed(6),
          entryQty: new Decimal(l.qty).toFixed(6),
          entryUnit: l.packId ? null : (l.unit ?? item.baseUnit),
          entryPackId: l.packId ?? null,
        };
      }),
    );
  }

  async createInTx(tx: Tx, a: AccessContext, dto: CreateTransferInput, source = 'app') {
    this.must(a, 'stock:manage', dto.fromSiteId);
    const found = await tx.select({ id: sites.id }).from(sites).where(inArray(sites.id, [dto.fromSiteId, dto.toSiteId]));
    if (found.length !== 2) throw new NotFoundException('site not found');
    const [t] = await tx
      .insert(stockTransfers)
      .values({ orgId: a.orgId, ref: await this.nextRef(tx, a.orgId), fromSiteId: dto.fromSiteId, toSiteId: dto.toSiteId, note: dto.note ?? null, source, createdBy: a.userId })
      .returning();
    await this.writeLines(tx, a, t!.id, dto.lines);
    await audit(tx, a, { action: 'transfer.created', entityType: 'stock_transfer', entityId: t!.id, after: { ref: t!.ref, fromSiteId: dto.fromSiteId, toSiteId: dto.toSiteId, lines: dto.lines.length } });
    return dto.send ? this.sendInTx(tx, a, t!) : t!;
  }

  create(a: AccessContext, dto: CreateDto) {
    return this.db.tenant(a.tenant, async (tx) => this.detailInTx(tx, a, (await this.createInTx(tx, a, dto)).id));
  }

  update(a: AccessContext, id: string, dto: UpdateDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const t = await this.load(tx, id);
      this.must(a, 'stock:manage', t.fromSiteId);
      if (t.status !== 'draft') throw new BadRequestException(`A ${t.status} transfer can't be edited`);
      if (dto.lines) await this.writeLines(tx, a, t.id, dto.lines);
      await tx.update(stockTransfers).set({ note: dto.note === undefined ? t.note : dto.note, updatedAt: new Date() }).where(eq(stockTransfers.id, t.id));
      return this.detailInTx(tx, a, t.id);
    });
  }

  async sendInTx(tx: Tx, a: AccessContext, t: TransferRow) {
    this.must(a, 'stock:manage', t.fromSiteId);
    if (t.status !== 'draft') throw new BadRequestException(`This transfer is ${t.status}`);
    const lines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, t.id));
    const bal = new Map(
      (await tx.select().from(stockBalances).where(and(eq(stockBalances.siteId, t.fromSiteId), inArray(stockBalances.itemId, lines.map((l) => l.itemId))))).map((b) => [b.itemId, b]),
    );
    let value = new Decimal(0);
    for (const l of lines) {
      const avg = new Decimal(bal.get(l.itemId)?.avgCost ?? 0);
      const unitCost = avg.isZero() ? ((await this.stock.fallbackCost(tx, l.itemId)) ?? avg) : avg;
      await tx.update(stockTransferLines).set({ unitCost: unitCost.toFixed(8) }).where(eq(stockTransferLines.id, l.id));
      await this.stock.post(tx, a, { siteId: t.fromSiteId, itemId: l.itemId, type: 'transfer_out', qtyBase: new Decimal(l.qtyBase).neg(), sourceType: 'transfer', sourceId: t.id, note: t.ref });
      value = value.plus(new Decimal(l.qtyBase).mul(unitCost));
    }
    const [after] = await tx
      .update(stockTransfers)
      .set({ status: 'sent', sentAt: new Date(), sentBy: a.userId, value: value.toFixed(2), updatedAt: new Date() })
      .where(eq(stockTransfers.id, t.id))
      .returning();
    await emitEvent(tx, a, 'transfer.sent', { type: 'stock_transfer', id: t.id }, { transferId: t.id, ref: t.ref, fromSiteId: t.fromSiteId, toSiteId: t.toSiteId, value: value.toFixed(2) });
    await audit(tx, a, { action: 'transfer.sent', entityType: 'stock_transfer', entityId: t.id, before: { status: t.status }, after: { status: 'sent', value: value.toFixed(2) } });
    return after!;
  }

  send(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      await this.sendInTx(tx, a, await this.load(tx, id));
      return this.detailInTx(tx, a, id);
    });
  }

  async receiveInTx(tx: Tx, a: AccessContext, t: TransferRow, dto: z.infer<typeof ReceiveSchema>) {
    this.must(a, 'stock:manage', t.toSiteId);
    if (t.status !== 'sent') throw new BadRequestException(t.status === 'draft' ? 'This transfer hasn\'t been sent yet' : `This transfer is ${t.status}`);
    const lines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, t.id));
    const unknown = dto.lines.find((d) => !lines.some((l) => l.id === d.lineId));
    if (unknown) throw new BadRequestException('Unknown line');
    const catalogue = await stockableItems(tx, lines.map((l) => l.itemId));
    let short = new Decimal(0);
    for (const l of lines) {
      const given = dto.lines.find((d) => d.lineId === l.id);
      const { item, packs } = catalogue.get(l.itemId)!;
      const received = given ? (given.qty === 0 ? new Decimal(0) : baseQty(item, packs, given)) : new Decimal(l.qtyBase);
      const unitCost = new Decimal(l.unitCost ?? 0);
      await tx.update(stockTransferLines).set({ receivedQty: received.toFixed(6) }).where(eq(stockTransferLines.id, l.id));
      await this.stock.post(tx, a, { siteId: t.toSiteId, itemId: l.itemId, type: 'transfer_in', qtyBase: received, unitCost: unitCost.isZero() ? null : unitCost, sourceType: 'transfer', sourceId: t.id, note: t.ref });
      short = short.plus(new Decimal(l.qtyBase).minus(received).mul(unitCost));
    }
    const note = dto.note ? `${t.note ? `${t.note}\n` : ''}Received: ${dto.note}` : t.note;
    const [after] = await tx
      .update(stockTransfers)
      .set({ status: 'received', receivedAt: new Date(), receivedBy: a.userId, shortValue: short.toFixed(2), note, updatedAt: new Date() })
      .where(eq(stockTransfers.id, t.id))
      .returning();
    await emitEvent(tx, a, 'transfer.received', { type: 'stock_transfer', id: t.id }, { transferId: t.id, ref: t.ref, fromSiteId: t.fromSiteId, toSiteId: t.toSiteId, shortValue: short.toFixed(2) });
    await audit(tx, a, { action: 'transfer.received', entityType: 'stock_transfer', entityId: t.id, before: { status: t.status }, after: { status: 'received', shortValue: short.toFixed(2) } });
    return after!;
  }

  receive(a: AccessContext, id: string, dto: ReceiveDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      await this.receiveInTx(tx, a, await this.load(tx, id), dto);
      return this.detailInTx(tx, a, id);
    });
  }

  cancel(a: AccessContext, id: string, note: string | null) {
    return this.db.tenant(a.tenant, async (tx) => {
      const t = await this.load(tx, id);
      this.must(a, 'stock:manage', t.fromSiteId);
      if (!['draft', 'sent'].includes(t.status)) throw new BadRequestException(`A ${t.status} transfer can't be cancelled`);
      if (t.status === 'sent') {
        // The stock never left: put it back at the source, at the cost it went out at.
        const lines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, t.id));
        for (const l of lines) {
          const cost = new Decimal(l.unitCost ?? 0);
          await this.stock.post(tx, a, { siteId: t.fromSiteId, itemId: l.itemId, type: 'transfer_in', qtyBase: l.qtyBase, unitCost: cost.isZero() ? null : cost, sourceType: 'transfer_cancel', sourceId: t.id, note: t.ref });
        }
      }
      await tx
        .update(stockTransfers)
        .set({ status: 'cancelled', cancelledAt: new Date(), note: note ? `${t.note ? `${t.note}\n` : ''}Cancelled: ${note}` : t.note, updatedAt: new Date() })
        .where(eq(stockTransfers.id, t.id));
      await audit(tx, a, { action: 'transfer.cancelled', entityType: 'stock_transfer', entityId: t.id, before: { status: t.status }, after: { status: 'cancelled', note } });
      return this.detailInTx(tx, a, id);
    });
  }

  /** Transfers someone may see: stock:read at either end. */
  private visible(a: AccessContext) {
    const allowed = a.sitesFor('stock:read');
    if (allowed === 'all') return undefined;
    if (!allowed.length) return sql`false`;
    return or(inArray(stockTransfers.fromSiteId, allowed), inArray(stockTransfers.toSiteId, allowed));
  }

  list(a: AccessContext, q: ListDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      if (q.siteId && !a.can('stock:read', q.siteId)) throw new ForbiddenException('Missing permission stock:read for this site');
      const status = q.status === 'all' ? undefined : q.status === 'active' ? inArray(stockTransfers.status, ['draft', 'sent']) : eq(stockTransfers.status, q.status);
      const site = q.siteId
        ? q.direction === 'in'
          ? eq(stockTransfers.toSiteId, q.siteId)
          : q.direction === 'out'
            ? eq(stockTransfers.fromSiteId, q.siteId)
            : or(eq(stockTransfers.fromSiteId, q.siteId), eq(stockTransfers.toSiteId, q.siteId))
        : undefined;
      const rows = await tx
        .select({
          t: stockTransfers,
          fromName: fromSite.name,
          fromNameAr: fromSite.nameAr,
          toName: toSite.name,
          toNameAr: toSite.nameAr,
          lines: sql<number>`(select count(*)::int from ${stockTransferLines} l where l.transfer_id = ${stockTransfers.id})`,
        })
        .from(stockTransfers)
        .innerJoin(fromSite, eq(fromSite.id, stockTransfers.fromSiteId))
        .innerJoin(toSite, eq(toSite.id, stockTransfers.toSiteId))
        .where(and(status, site, this.visible(a)))
        .orderBy(desc(stockTransfers.createdAt))
        .limit(q.limit);
      const showCost = a.can('price:read');
      return rows.map(({ t, ...r }) => ({ ...t, ...r, value: showCost ? t.value : undefined, shortValue: showCost ? t.shortValue : undefined }));
    });
  }

  async detailInTx(tx: Tx, a: AccessContext, id: string) {
    const [row] = await tx
      .select({ t: stockTransfers, fromName: fromSite.name, fromNameAr: fromSite.nameAr, toName: toSite.name, toNameAr: toSite.nameAr })
      .from(stockTransfers)
      .innerJoin(fromSite, eq(fromSite.id, stockTransfers.fromSiteId))
      .innerJoin(toSite, eq(toSite.id, stockTransfers.toSiteId))
      .where(eq(stockTransfers.id, id));
    if (!row) throw new NotFoundException('transfer not found');
    const t = row.t;
    if (!a.can('stock:read', t.fromSiteId) && !a.can('stock:read', t.toSiteId)) throw new ForbiddenException('Missing permission stock:read for these sites');
    const lines = await tx
      .select({ l: stockTransferLines, name: items.name, nameAr: items.nameAr, code: items.code, baseUnit: items.baseUnit })
      .from(stockTransferLines)
      .innerJoin(items, eq(items.id, stockTransferLines.itemId))
      .where(eq(stockTransferLines.transferId, t.id))
      .orderBy(asc(items.name));
    const packRows = lines.length ? await tx.select().from(packs).where(inArray(packs.itemId, lines.map((l) => l.l.itemId))).orderBy(asc(packs.baseQty)) : [];
    const showCost = a.can('price:read');
    return {
      ...t,
      fromName: row.fromName,
      fromNameAr: row.fromNameAr,
      toName: row.toName,
      toNameAr: row.toNameAr,
      value: showCost ? t.value : undefined,
      shortValue: showCost ? t.shortValue : undefined,
      canSend: a.can('stock:manage', t.fromSiteId),
      canReceive: a.can('stock:manage', t.toSiteId),
      lines: lines.map(({ l, ...i }) => ({
        id: l.id,
        itemId: l.itemId,
        ...i,
        qtyBase: l.qtyBase,
        entryQty: l.entryQty,
        entryUnit: l.entryUnit,
        entryPackId: l.entryPackId,
        receivedQty: l.receivedQty,
        unitCost: showCost ? l.unitCost : undefined,
        packs: packRows.filter((p) => p.itemId === l.itemId).map((p) => ({ id: p.id, name: p.name, nameAr: p.nameAr, baseQty: p.baseQty })),
      })),
    };
  }

  detail(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, (tx) => this.detailInTx(tx, a, id));
  }
}

@ApiTags('stock')
@ApiBearerAuth()
@Controller('stock-transfers')
export class TransfersController {
  constructor(private readonly svc: TransfersService) {}

  @Get() @Requires('stock:read')
  list(@Access() a: AccessContext, @Query() q: ListDto) { return this.svc.list(a, q); }

  @Post() @Requires('stock:manage')
  create(@Access() a: AccessContext, @Body() dto: CreateDto) { return this.svc.create(a, dto); }

  @Get(':id') @Requires('stock:read')
  detail(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.detail(a, id); }

  @Patch(':id') @Requires('stock:manage')
  update(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateDto) { return this.svc.update(a, id, dto); }

  @Post(':id/send') @Requires('stock:manage') @HttpCode(200)
  send(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.send(a, id); }

  @Post(':id/receive') @Requires('stock:manage') @HttpCode(200)
  receive(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: ReceiveDto) { return this.svc.receive(a, id, dto); }

  @Post(':id/cancel') @Requires('stock:manage') @HttpCode(200)
  cancel(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: NoteDto) { return this.svc.cancel(a, id, dto.note ?? null); }
}

@Module({ imports: [StockModule], controllers: [TransfersController], providers: [TransfersService], exports: [TransfersService] })
export class TransfersModule {}
