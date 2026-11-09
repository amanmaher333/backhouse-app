import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { items, sites, stockBalances, users, wasteEntries, type Tx } from '@boh/db';
import { Decimal, UNITS, WASTE_REASONS, parseWasteText, type WasteReason } from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';
import { emitEvent } from '../agents/events.js';
import { StockModule, StockService, baseQty, countableCatalogue, stockableItems } from './stock.js';

const uuid = new ParseUUIDPipe({ version: '4' });
/** Someone may void their own entry for this long; after that (or for someone else's) it takes stock:approve. */
const OWN_VOID_HOURS = 24;

const EntrySchema = z.object({
  itemId: z.string().uuid(),
  qty: z.coerce.number().positive().max(1e9),
  unit: z.string().refine((u) => u in UNITS, 'Unknown unit').optional(),
  packId: z.string().uuid().optional(),
  reason: z.enum(WASTE_REASONS),
  note: z.string().max(500).nullish(),
  text: z.string().max(200).optional(),
});
const RecordSchema = z.object({ entries: z.array(EntrySchema).min(1).max(200) });
class RecordDto extends createZodDto(RecordSchema) {}
export type WasteInput = z.infer<typeof EntrySchema>;

const ReadSchema = z.object({
  text: z.string().min(1).max(5000),
  apply: z.boolean().default(false),
  /** Used for entries that don't say why. */
  defaultReason: z.enum(WASTE_REASONS).default('other'),
});
class ReadDto extends createZodDto(ReadSchema) {}

const ListSchema = z.object({
  siteId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  reason: z.enum(WASTE_REASONS).optional(),
  itemId: z.string().uuid().optional(),
  includeVoided: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
class ListDto extends createZodDto(ListSchema) {}

const VoidSchema = z.object({ reason: z.string().min(2).max(300) });
class VoidDto extends createZodDto(VoidSchema) {}

/**
 * Waste: stock thrown away, with why. Each entry takes the stock off at its average
 * cost (a 'waste' movement). Entries are never edited or deleted; a mistake is voided,
 * which puts the stock back.
 */
@Injectable()
export class WasteService {
  constructor(
    private readonly db: DbService,
    private readonly stock: StockService,
  ) {}

  private must(a: AccessContext, perm: string, siteId: string) {
    if (!a.can(perm, siteId)) throw new ForbiddenException(`Missing permission ${perm} for this site`);
  }

  async recordInTx(tx: Tx, a: AccessContext, siteId: string, input: WasteInput[], source = 'app') {
    this.must(a, 'stock:manage', siteId);
    const [site] = await tx.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId));
    if (!site) throw new NotFoundException('site not found');
    const catalogue = await stockableItems(tx, input.map((e) => e.itemId));
    const out = [];
    for (const e of input) {
      const { item, packs } = catalogue.get(e.itemId)!;
      const qty = baseQty(item, packs, e);
      if (qty.lte(0)) throw new BadRequestException(`${item.name}: quantity must be more than zero`);
      const [bal] = await tx.select({ avgCost: stockBalances.avgCost }).from(stockBalances).where(and(eq(stockBalances.siteId, siteId), eq(stockBalances.itemId, item.id)));
      const avg = new Decimal(bal?.avgCost ?? 0);
      const unitCost = avg.isZero() ? ((await this.stock.fallbackCost(tx, item.id)) ?? avg) : avg;
      const [row] = await tx
        .insert(wasteEntries)
        .values({
          orgId: a.orgId,
          siteId,
          itemId: item.id,
          qtyBase: qty.toFixed(6),
          entryQty: new Decimal(e.qty).toFixed(6),
          entryUnit: e.packId ? null : (e.unit ?? item.baseUnit),
          entryPackId: e.packId ?? null,
          entryText: e.text ?? null,
          reason: e.reason,
          note: e.note ?? null,
          unitCost: unitCost.toFixed(8),
          value: qty.mul(unitCost).toFixed(2),
          source,
          recordedBy: a.userId,
        })
        .returning();
      await this.stock.post(tx, a, { siteId, itemId: item.id, type: 'waste', qtyBase: qty.neg(), sourceType: 'waste', sourceId: row!.id, note: e.reason });
      await emitEvent(tx, a, 'stock.wasted', { type: 'waste_entry', id: row!.id }, { siteId, itemId: item.id, qtyBase: row!.qtyBase, reason: e.reason, value: row!.value });
      out.push({ ...row!, itemName: item.name, itemNameAr: item.nameAr, baseUnit: item.baseUnit });
    }
    await audit(tx, a, { action: 'waste.recorded', entityType: 'site', entityId: siteId, after: { entries: out.map((r) => ({ id: r.id, itemId: r.itemId, qtyBase: r.qtyBase, reason: r.reason, value: r.value })) } });
    return out;
  }

  record(a: AccessContext, siteId: string, dto: RecordDto) {
    return this.db.tenant(a.tenant, async (tx) => this.hideCost(a, await this.recordInTx(tx, a, siteId, dto.entries)));
  }

  /** Read typed or spoken waste ("tomatoes 2 kg spoiled, milk 3 l expired"); with apply, record the clear entries. */
  async readInTx(tx: Tx, a: AccessContext, siteId: string, text: string, apply: boolean, defaultReason: WasteReason, source = 'app') {
    this.must(a, 'stock:manage', siteId);
    const catalogue = await countableCatalogue(tx);
    const byId = new Map(catalogue.map((i) => [i.id, i]));
    const entries = parseWasteText(text, catalogue);
    const clear = entries.filter((e) => !e.problem && e.itemId && e.qty !== null);
    const recorded = apply && clear.length
      ? await this.recordInTx(
          tx,
          a,
          siteId,
          clear.map((e) => ({ itemId: e.itemId!, qty: Number(e.qty), unit: e.unit ?? undefined, packId: e.packId ?? undefined, reason: e.reason ?? defaultReason, text: e.raw })),
          source,
        )
      : [];
    return {
      entries: entries.map((e) => {
        const item = e.itemId ? byId.get(e.itemId) : undefined;
        const pack = item?.packs.find((p) => p.id === e.packId);
        return {
          ...e,
          itemName: item?.name ?? null,
          itemNameAr: item?.nameAr ?? null,
          packName: pack?.name ?? null,
          packNameAr: pack?.nameAr ?? null,
          candidateNames: e.candidates.map((id) => ({ id, name: byId.get(id)?.name, nameAr: byId.get(id)?.nameAr })),
          recorded: apply && !e.problem && !!e.itemId && e.qty !== null,
        };
      }),
      recorded: recorded.length,
      value: a.can('price:read') ? recorded.reduce((s, r) => s.plus(r.value), new Decimal(0)).toFixed(2) : undefined,
      unclear: entries.length - clear.length,
    };
  }

  read(a: AccessContext, siteId: string, dto: ReadDto) {
    return this.db.tenant(a.tenant, (tx) => this.readInTx(tx, a, siteId, dto.text, dto.apply, dto.defaultReason));
  }

  private hideCost<T extends { unitCost?: string; value?: string }>(a: AccessContext, rows: T[]) {
    return a.can('price:read') ? rows : rows.map((r) => ({ ...r, unitCost: undefined, value: undefined }));
  }

  private filters(a: AccessContext, q: Pick<ListDto, 'siteId' | 'from' | 'to' | 'reason' | 'itemId' | 'includeVoided'>) {
    const allowed = a.sitesFor('stock:read');
    if (q.siteId && !a.can('stock:read', q.siteId)) throw new ForbiddenException('Missing permission stock:read for this site');
    if (allowed !== 'all' && !allowed.length) return null;
    return and(
      q.siteId ? eq(wasteEntries.siteId, q.siteId) : allowed === 'all' ? undefined : inArray(wasteEntries.siteId, allowed),
      q.from ? gte(wasteEntries.recordedAt, new Date(q.from)) : undefined,
      q.to ? lt(wasteEntries.recordedAt, new Date(q.to.length === 10 ? `${q.to}T23:59:59.999Z` : q.to)) : undefined,
      q.reason ? eq(wasteEntries.reason, q.reason) : undefined,
      q.itemId ? eq(wasteEntries.itemId, q.itemId) : undefined,
      q.includeVoided ? undefined : isNull(wasteEntries.voidedAt),
    );
  }

  list(a: AccessContext, q: ListDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const where = this.filters(a, q);
      if (where === null) return [];
      const rows = await tx
        .select({ w: wasteEntries, itemName: items.name, itemNameAr: items.nameAr, baseUnit: items.baseUnit, siteName: sites.name, siteNameAr: sites.nameAr, recordedByName: users.fullName })
        .from(wasteEntries)
        .innerJoin(items, eq(items.id, wasteEntries.itemId))
        .innerJoin(sites, eq(sites.id, wasteEntries.siteId))
        .leftJoin(users, eq(users.id, wasteEntries.recordedBy))
        .where(where)
        .orderBy(desc(wasteEntries.recordedAt))
        .limit(q.limit);
      return this.hideCost(
        a,
        rows.map(({ w, ...r }) => ({ ...w, ...r })),
      );
    });
  }

  /** Totals by reason and the items wasted most, for a period. */
  summary(a: AccessContext, q: ListDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const where = this.filters(a, { ...q, includeVoided: false });
      if (where === null) return { total: '0.00', entries: 0, byReason: [], topItems: [] };
      const byReason = await tx
        .select({ reason: wasteEntries.reason, entries: sql<number>`count(*)::int`, value: sql<string>`coalesce(sum(${wasteEntries.value}), 0)::numeric(16,2)::text` })
        .from(wasteEntries)
        .where(where)
        .groupBy(wasteEntries.reason)
        .orderBy(desc(sql`sum(${wasteEntries.value})`));
      const topItems = await tx
        .select({
          itemId: items.id,
          name: items.name,
          nameAr: items.nameAr,
          baseUnit: items.baseUnit,
          qtyBase: sql<string>`sum(${wasteEntries.qtyBase})::text`,
          entries: sql<number>`count(*)::int`,
          value: sql<string>`coalesce(sum(${wasteEntries.value}), 0)::numeric(16,2)::text`,
        })
        .from(wasteEntries)
        .innerJoin(items, eq(items.id, wasteEntries.itemId))
        .where(where)
        .groupBy(items.id, items.name, items.nameAr, items.baseUnit)
        .orderBy(desc(sql`sum(${wasteEntries.value})`), desc(sql`count(*)`))
        .limit(10);
      const showCost = a.can('price:read');
      const total = byReason.reduce((s, r) => s.plus(r.value), new Decimal(0));
      return {
        total: showCost ? total.toFixed(2) : undefined,
        entries: byReason.reduce((s, r) => s + r.entries, 0),
        byReason: byReason.map((r) => ({ ...r, value: showCost ? r.value : undefined })),
        topItems: topItems.map((r) => ({ ...r, value: showCost ? r.value : undefined })),
      };
    });
  }

  /** Undo an entry: the stock goes back at the cost it was taken off at. */
  void(a: AccessContext, id: string, reason: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [w] = await tx.select().from(wasteEntries).where(eq(wasteEntries.id, id)).for('update');
      if (!w) throw new NotFoundException('waste entry not found');
      this.must(a, 'stock:manage', w.siteId);
      if (w.voidedAt) throw new BadRequestException('Already voided');
      const own = w.recordedBy === a.userId && Date.now() - w.recordedAt.getTime() < OWN_VOID_HOURS * 3600_000;
      if (!own && !a.can('stock:approve', w.siteId)) throw new ForbiddenException(`Only the person who recorded it can void it within ${OWN_VOID_HOURS} hours; otherwise it takes stock:approve`);
      const [after] = await tx.update(wasteEntries).set({ voidedAt: new Date(), voidedBy: a.userId, voidReason: reason }).where(eq(wasteEntries.id, id)).returning();
      await this.stock.post(tx, a, { siteId: w.siteId, itemId: w.itemId, type: 'waste', qtyBase: w.qtyBase, unitCost: w.unitCost, sourceType: 'waste_void', sourceId: w.id, note: reason });
      await audit(tx, a, { action: 'waste.voided', entityType: 'waste_entry', entityId: id, before: { voidedAt: null }, after: { voidReason: reason } });
      return this.hideCost(a, [after!])[0];
    });
  }
}

@ApiTags('stock')
@ApiBearerAuth()
@Controller()
export class WasteController {
  constructor(private readonly svc: WasteService) {}

  @Post('sites/:siteId/waste') @Requires('stock:manage', { siteParam: 'siteId' })
  record(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string, @Body() dto: RecordDto) { return this.svc.record(a, siteId, dto); }

  @Post('sites/:siteId/waste/read') @Requires('stock:manage', { siteParam: 'siteId' }) @HttpCode(200)
  read(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string, @Body() dto: ReadDto) { return this.svc.read(a, siteId, dto); }

  @Get('waste') @Requires('stock:read')
  list(@Access() a: AccessContext, @Query() q: ListDto) { return this.svc.list(a, q); }

  @Get('waste/summary') @Requires('stock:read')
  summary(@Access() a: AccessContext, @Query() q: ListDto) { return this.svc.summary(a, q); }

  @Post('waste/:id/void') @Requires('stock:manage') @HttpCode(200)
  void(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: VoidDto) { return this.svc.void(a, id, dto.reason); }
}

@Module({ imports: [StockModule], controllers: [WasteController], providers: [WasteService], exports: [WasteService] })
export class WasteModule {}
