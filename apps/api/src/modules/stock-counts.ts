import {
  BadRequestException,
  Body,
  Controller,
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
import { and, asc, desc, eq, inArray, or, isNull, sql } from 'drizzle-orm';
import { itemSiteSettings, items, orgCounters, organizations, packs, sites, stockBalances, stockCountLines, stockCounts, users, type Tx } from '@boh/db';
import { Decimal, UNITS, countAdjustment, parseCountText, toBase, type CountableItem, type PackDef, type ParsedEntry } from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';
import { emitEvent } from '../agents/events.js';
import { StockModule, StockService, baseQty } from './stock.js';

const uuid = new ParseUUIDPipe({ version: '4' });
type CountRow = typeof stockCounts.$inferSelect;
type LineRow = typeof stockCountLines.$inferSelect;
type ItemRow = typeof items.$inferSelect;
type PackRow = typeof packs.$inferSelect;

/** Default for OrgSettings.countApprovalValue. */
export const DEFAULT_COUNT_APPROVAL_VALUE = 500;

const CreateSchema = z.object({
  scope: z.enum(['full', 'partial']).default('full'),
  /** For a partial count: the items to count (more can be added while counting). */
  itemIds: z.array(z.string().uuid()).max(2000).optional(),
  blind: z.boolean().default(true),
  note: z.string().max(500).nullish(),
});
class CreateDto extends createZodDto(CreateSchema) {}
export type CreateCountInput = z.infer<typeof CreateSchema>;

const LineSchema = z
  .object({
    itemId: z.string().uuid(),
    qty: z.coerce.number().min(0).max(1e9).optional(),
    unit: z.string().refine((u) => u in UNITS, 'Unknown unit').optional(),
    packId: z.string().uuid().optional(),
    /** 'set' replaces the counted quantity; 'add' adds to it (the same item counted in several places). */
    mode: z.enum(['set', 'add']).default('set'),
    /** Clear the line back to "not counted". */
    clear: z.boolean().optional(),
    text: z.string().max(200).optional(),
  })
  .refine((l) => l.clear || l.qty !== undefined, { message: 'Give qty, or clear' });
const LinesSchema = z.object({ lines: z.array(LineSchema).min(1).max(500) });
class LinesDto extends createZodDto(LinesSchema) {}
export type LineInput = z.infer<typeof LineSchema>;

const EntriesSchema = z.object({
  text: z.string().min(1).max(5000),
  /** Record the entries that were read clearly; otherwise only show what was understood. */
  apply: z.boolean().default(false),
  mode: z.enum(['set', 'add']).default('set'),
});
class EntriesDto extends createZodDto(EntriesSchema) {}

const ListSchema = z.object({
  siteId: z.string().uuid().optional(),
  status: z.enum(['active', 'all', 'open', 'submitted', 'posted', 'cancelled']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
class ListDto extends createZodDto(ListSchema) {}

const SettingsSchema = z.object({ countApprovalValue: z.coerce.number().min(0).max(10_000_000) });
class SettingsDto extends createZodDto(SettingsSchema) {}

const NoteSchema = z.object({ note: z.string().max(500).nullish() });
class NoteDto extends createZodDto(NoteSchema) {}

/**
 * Stock counts. Lines are counted in any order (by several people, by tapping or by
 * typing or saying "tomatoes 12 kg"); each line's expected quantity is what was on hand
 * when it was counted. Submitting works out the variances; posting writes them to the
 * stock ledger as adjustments. Large variances need someone with stock:approve who
 * didn't count or submit it.
 */
@Injectable()
export class StockCountsService {
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
      .values({ orgId, key: 'stock_count', value: 1 })
      .onConflictDoUpdate({ target: [orgCounters.orgId, orgCounters.key], set: { value: sql`${orgCounters.value} + 1` } })
      .returning();
    return `SC-${String(row!.value).padStart(5, '0')}`;
  }

  private async load(tx: Tx, id: string, lock = true): Promise<CountRow> {
    const q = tx.select().from(stockCounts).where(eq(stockCounts.id, id));
    const [c] = lock ? await q.for('update') : await q;
    if (!c) throw new NotFoundException('stock count not found');
    return c;
  }

  private async onHand(tx: Tx, siteId: string, itemIds: string[]) {
    if (!itemIds.length) return new Map<string, typeof stockBalances.$inferSelect>();
    const rows = await tx.select().from(stockBalances).where(and(eq(stockBalances.siteId, siteId), inArray(stockBalances.itemId, itemIds)));
    return new Map(rows.map((r) => [r.itemId, r]));
  }

  /** Items that belong in a full count at a site: active, stockable, not switched off for the site. */
  private async stockedItemIds(tx: Tx, siteId: string) {
    const rows = await tx
      .select({ id: items.id })
      .from(items)
      .leftJoin(itemSiteSettings, and(eq(itemSiteSettings.itemId, items.id), eq(itemSiteSettings.siteId, siteId)))
      .where(and(eq(items.isActive, true), eq(items.isStockable, true), or(isNull(itemSiteSettings.isStocked), eq(itemSiteSettings.isStocked, true))));
    return rows.map((r) => r.id);
  }

  private async addLines(tx: Tx, a: AccessContext, count: CountRow, itemIds: string[]) {
    if (!itemIds.length) return;
    const bal = await this.onHand(tx, count.siteId, itemIds);
    await tx
      .insert(stockCountLines)
      .values(itemIds.map((itemId) => ({ orgId: a.orgId, countId: count.id, itemId, snapshotQty: bal.get(itemId)?.qtyOnHand ?? '0' })))
      .onConflictDoNothing();
  }

  async createInTx(tx: Tx, a: AccessContext, siteId: string, dto: CreateCountInput, source = 'app') {
    this.must(a, 'stock:manage', siteId);
    const [site] = await tx.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId));
    if (!site) throw new NotFoundException('site not found');
    if (dto.scope === 'partial' && !dto.itemIds?.length) throw new BadRequestException('Choose the items for a partial count');
    let itemIds = dto.scope === 'full' ? await this.stockedItemIds(tx, siteId) : [...new Set(dto.itemIds)];
    if (dto.scope === 'partial') {
      const found = await tx.select({ id: items.id }).from(items).where(and(inArray(items.id, itemIds), eq(items.isStockable, true)));
      if (found.length !== itemIds.length) throw new BadRequestException('Some items are unknown or not stockable');
      itemIds = found.map((f) => f.id);
    }
    const [count] = await tx
      .insert(stockCounts)
      .values({ orgId: a.orgId, siteId, ref: await this.nextRef(tx, a.orgId), scope: dto.scope, blind: dto.blind, note: dto.note ?? null, source, createdBy: a.userId })
      .returning();
    await this.addLines(tx, a, count!, itemIds);
    await audit(tx, a, { action: 'stock_count.created', entityType: 'stock_count', entityId: count!.id, after: { ref: count!.ref, siteId, scope: dto.scope, items: itemIds.length } });
    return count!;
  }

  create(a: AccessContext, siteId: string, dto: CreateDto) {
    return this.db.tenant(a.tenant, async (tx) => this.detailInTx(tx, a, (await this.createInTx(tx, a, siteId, dto)).id));
  }

  list(a: AccessContext, q: ListDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const allowed = a.sitesFor('stock:read');
      if (allowed !== 'all' && !allowed.length) return [];
      if (q.siteId && !a.can('stock:read', q.siteId)) throw new ForbiddenException('Missing permission stock:read for this site');
      const status =
        q.status === 'all' ? undefined : q.status === 'active' ? inArray(stockCounts.status, ['open', 'submitted']) : eq(stockCounts.status, q.status);
      const rows = await tx
        .select({
          count: stockCounts,
          siteName: sites.name,
          siteNameAr: sites.nameAr,
          lines: sql<number>`(select count(*)::int from ${stockCountLines} l where l.count_id = ${stockCounts.id})`,
          counted: sql<number>`(select count(*)::int from ${stockCountLines} l where l.count_id = ${stockCounts.id} and l.counted_qty is not null)`,
        })
        .from(stockCounts)
        .innerJoin(sites, eq(sites.id, stockCounts.siteId))
        .where(and(status, q.siteId ? eq(stockCounts.siteId, q.siteId) : undefined, allowed === 'all' ? undefined : inArray(stockCounts.siteId, allowed)))
        .orderBy(desc(stockCounts.createdAt))
        .limit(q.limit);
      const showCost = a.can('price:read');
      return rows.map((r) => ({
        ...r.count,
        varianceValue: showCost ? r.count.varianceValue : undefined,
        absVarianceValue: showCost ? r.count.absVarianceValue : undefined,
        siteName: r.siteName,
        siteNameAr: r.siteNameAr,
        lines: r.lines,
        counted: r.counted,
      }));
    });
  }

  /** Whether this person may see expected quantities: not while a blind count is open, unless they approve counts. */
  private seesExpected(a: AccessContext, c: CountRow) {
    return !c.blind || c.status !== 'open' || a.can('stock:approve', c.siteId);
  }

  async detailInTx(tx: Tx, a: AccessContext, id: string) {
    const c = await this.load(tx, id, false);
    this.must(a, 'stock:read', c.siteId);
    const lines = await tx
      .select({ line: stockCountLines, item: items, countedByName: users.fullName })
      .from(stockCountLines)
      .innerJoin(items, eq(items.id, stockCountLines.itemId))
      .leftJoin(users, eq(users.id, stockCountLines.countedBy))
      .where(eq(stockCountLines.countId, c.id))
      .orderBy(asc(items.category), asc(items.name));
    const itemIds = lines.map((l) => l.item.id);
    const packRows = itemIds.length ? await tx.select().from(packs).where(inArray(packs.itemId, itemIds)).orderBy(asc(packs.baseQty)) : [];
    const [site] = await tx.select({ name: sites.name, nameAr: sites.nameAr }).from(sites).where(eq(sites.id, c.siteId));
    const expected = this.seesExpected(a, c);
    const showCost = a.can('price:read');
    // While open, show the live variance for counted lines (to those who may see expected quantities).
    const bal = c.status === 'open' && expected ? await this.onHand(tx, c.siteId, itemIds) : new Map();
    return {
      ...c,
      varianceValue: showCost ? c.varianceValue : undefined,
      absVarianceValue: showCost ? c.absVarianceValue : undefined,
      siteName: site?.name,
      siteNameAr: site?.nameAr,
      expectedVisible: expected,
      canApprove: a.can('stock:approve', c.siteId),
      lines: lines.map(({ line: l, item, countedByName }) => {
        const avg = bal.get(item.id)?.avgCost;
        const adjustment = l.adjustmentQty ?? (l.countedQty !== null && l.expectedQty !== null ? new Decimal(l.countedQty).minus(l.expectedQty).toFixed(6) : null);
        const value = l.varianceValue ?? (adjustment !== null && avg ? new Decimal(adjustment).mul(avg).toFixed(2) : null);
        return {
          id: l.id,
          itemId: item.id,
          code: item.code,
          name: item.name,
          nameAr: item.nameAr,
          category: item.category,
          baseUnit: item.baseUnit,
          packs: packRows
            .filter((p) => p.itemId === item.id && p.isCountable)
            .map((p) => ({ id: p.id, name: p.name, nameAr: p.nameAr, baseQty: p.baseQty })),
          countedQty: l.countedQty,
          entryQty: l.entryQty,
          entryUnit: l.entryUnit,
          entryPackId: l.entryPackId,
          entryText: l.entryText,
          countedAt: l.countedAt,
          countedBy: l.countedBy,
          countedByName,
          snapshotQty: expected ? l.snapshotQty : undefined,
          expectedQty: expected ? l.expectedQty : undefined,
          adjustmentQty: expected ? adjustment : undefined,
          unitCost: showCost ? l.unitCost : undefined,
          varianceValue: showCost && expected ? value : undefined,
        };
      }),
    };
  }

  detail(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, (tx) => this.detailInTx(tx, a, id));
  }

  /** Record counted quantities. Items not yet in the count are added to it. */
  async recordInTx(tx: Tx, a: AccessContext, c: CountRow, input: LineInput[]) {
    this.must(a, 'stock:manage', c.siteId);
    if (c.status !== 'open') throw new BadRequestException(`This count is ${c.status}`);
    const itemIds = [...new Set(input.map((l) => l.itemId))];
    const itemRows = await tx.select().from(items).where(inArray(items.id, itemIds));
    if (itemRows.length !== itemIds.length) throw new BadRequestException('Unknown item');
    if (itemRows.some((i) => !i.isStockable)) throw new BadRequestException('Some items are not stockable');
    const packRows = await tx.select().from(packs).where(inArray(packs.itemId, itemIds));
    await this.addLines(tx, a, c, itemIds);
    const existing = await tx.select().from(stockCountLines).where(and(eq(stockCountLines.countId, c.id), inArray(stockCountLines.itemId, itemIds))).for('update');
    const byItem = new Map(existing.map((l) => [l.itemId, l]));
    const bal = await this.onHand(tx, c.siteId, itemIds);
    const now = new Date();
    for (const l of input) {
      const line = byItem.get(l.itemId)!;
      if (l.clear) {
        const [after] = await tx
          .update(stockCountLines)
          .set({ countedQty: null, expectedQty: null, entryQty: null, entryUnit: null, entryPackId: null, entryText: null, countedAt: null, countedBy: null })
          .where(eq(stockCountLines.id, line.id))
          .returning();
        byItem.set(l.itemId, after!);
        continue;
      }
      const item = itemRows.find((i) => i.id === l.itemId)!;
      const base = baseQty(item, packRows.filter((p) => p.itemId === item.id), { qty: l.qty!, unit: l.unit, packId: l.packId });
      const counted = l.mode === 'add' && line.countedQty !== null ? base.plus(line.countedQty) : base;
      const [after] = await tx
        .update(stockCountLines)
        .set({
          countedQty: counted.toFixed(6),
          expectedQty: bal.get(item.id)?.qtyOnHand ?? '0',
          entryQty: new Decimal(l.qty!).toFixed(6),
          entryUnit: l.packId ? null : (l.unit ?? item.baseUnit),
          entryPackId: l.packId ?? null,
          entryText: l.text ?? null,
          countedAt: now,
          countedBy: a.userId,
        })
        .where(eq(stockCountLines.id, line.id))
        .returning();
      byItem.set(l.itemId, after!);
    }
    await tx.update(stockCounts).set({ updatedAt: now }).where(eq(stockCounts.id, c.id));
    return [...byItem.values()];
  }

  recordLines(a: AccessContext, id: string, dto: LinesDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.load(tx, id);
      await this.recordInTx(tx, a, c, dto.lines);
      return this.detailInTx(tx, a, c.id);
    });
  }

  /** The items a count's text can name: the count's own items, then every other stockable item. */
  async countableItems(tx: Tx, c: CountRow): Promise<CountableItem[]> {
    const rows = await tx.select().from(items).where(and(eq(items.isActive, true), eq(items.isStockable, true)));
    const packRows = rows.length ? await tx.select().from(packs).where(inArray(packs.itemId, rows.map((r) => r.id))) : [];
    const inCount = new Set((await tx.select({ itemId: stockCountLines.itemId }).from(stockCountLines).where(eq(stockCountLines.countId, c.id))).map((r) => r.itemId));
    const list = rows.map((r) => ({
      id: r.id,
      name: r.name,
      nameAr: r.nameAr,
      code: r.code,
      baseUnit: r.baseUnit,
      packs: packRows.filter((p) => p.itemId === r.id).map((p) => ({ id: p.id, name: p.name, nameAr: p.nameAr, isCountable: p.isCountable })),
    }));
    // Prefer items already in the count when a name is unclear.
    const own = list.filter((i) => inCount.has(i.id));
    return own.length && c.scope === 'full' ? own : list;
  }

  /**
   * Read typed or spoken counts ("tomatoes 12 kg, chicken 3 cartons"). Returns how each
   * piece was understood; with apply, records the pieces that were read clearly.
   */
  async entriesInTx(tx: Tx, a: AccessContext, c: CountRow, text: string, apply: boolean, mode: 'set' | 'add' = 'set') {
    this.must(a, 'stock:manage', c.siteId);
    if (c.status !== 'open') throw new BadRequestException(`This count is ${c.status}`);
    const catalogue = await this.countableItems(tx, c);
    let entries = parseCountText(text, catalogue);
    // An item outside a full count's list can still be counted: retry unclear names against everything.
    if (c.scope === 'full' && entries.some((e) => e.problem === 'no_item')) {
      const rows = await tx.select().from(items).where(and(eq(items.isActive, true), eq(items.isStockable, true)));
      if (rows.length > catalogue.length) {
        const all = await this.countableItems(tx, { ...c, scope: 'partial' });
        entries = entries.map((e) => (e.problem === 'no_item' ? parseCountText(e.raw, all)[0] ?? e : e));
      }
    }
    const names = new Map((c.scope === 'full' ? await this.countableItems(tx, { ...c, scope: 'partial' }) : catalogue).map((i) => [i.id, i]));
    const clear = entries.filter((e) => !e.problem && e.itemId && e.qty !== null);
    const recorded: string[] = [];
    if (apply && clear.length) {
      // One line per item: the last mention wins (or they add up in 'add' mode).
      const input: LineInput[] = clear.map((e) => ({ itemId: e.itemId!, qty: Number(e.qty), unit: e.unit ?? undefined, packId: e.packId ?? undefined, mode, text: e.raw }));
      const merged = mode === 'add' ? input : [...new Map(input.map((l) => [l.itemId, l])).values()];
      for (const l of merged) await this.recordInTx(tx, a, c, [l]);
      recorded.push(...merged.map((l) => l.itemId));
    }
    return {
      entries: entries.map((e: ParsedEntry) => ({
        ...e,
        itemName: e.itemId ? names.get(e.itemId)?.name ?? null : null,
        itemNameAr: e.itemId ? names.get(e.itemId)?.nameAr ?? null : null,
        packName: e.packId ? names.get(e.itemId!)?.packs.find((p) => p.id === e.packId)?.name ?? null : null,
        packNameAr: e.packId ? names.get(e.itemId!)?.packs.find((p) => p.id === e.packId)?.nameAr ?? null : null,
        candidateNames: e.candidates.map((id) => ({ id, name: names.get(id)?.name, nameAr: names.get(id)?.nameAr })),
        recorded: apply && recorded.includes(e.itemId ?? ''),
      })),
      recorded: recorded.length,
      unclear: entries.length - clear.length,
    };
  }

  entries(a: AccessContext, id: string, dto: EntriesDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.load(tx, id);
      return this.entriesInTx(tx, a, c, dto.text, dto.apply, dto.mode);
    });
  }

  /** Work out each counted line's variance and value, and the totals. Doesn't write stock. */
  private async computeVariances(tx: Tx, c: CountRow) {
    const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, c.id));
    const counted = lines.filter((l) => l.countedQty !== null);
    const bal = await this.onHand(tx, c.siteId, counted.map((l) => l.itemId));
    let total = new Decimal(0);
    let abs = new Decimal(0);
    const out: { line: LineRow; unitCost: Decimal; adjustment: string; value: string }[] = [];
    for (const l of counted) {
      const avg = new Decimal(bal.get(l.itemId)?.avgCost ?? 0);
      const unitCost = avg.isZero() ? ((await this.stock.fallbackCost(tx, l.itemId)) ?? avg) : avg;
      const expected = new Decimal(l.expectedQty ?? 0);
      const r = countAdjustment({ snapshotQty: l.snapshotQty, movedSinceSnapshot: expected.minus(l.snapshotQty), countedQty: l.countedQty!, unitCost });
      total = total.plus(r.value);
      abs = abs.plus(new Decimal(r.value).abs());
      out.push({ line: l, unitCost, adjustment: r.adjustment, value: r.value });
    }
    return { lines: out, uncounted: lines.length - counted.length, total, abs };
  }

  private async approvalLimit(tx: Tx, orgId: string) {
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
    return new Decimal(org?.settings?.countApprovalValue ?? DEFAULT_COUNT_APPROVAL_VALUE);
  }

  async submitInTx(tx: Tx, a: AccessContext, c: CountRow) {
    this.must(a, 'stock:manage', c.siteId);
    if (c.status !== 'open') throw new BadRequestException(`This count is ${c.status}`);
    const v = await this.computeVariances(tx, c);
    if (!v.lines.length) throw new BadRequestException('Nothing has been counted yet');
    for (const l of v.lines) {
      await tx.update(stockCountLines).set({ unitCost: l.unitCost.toFixed(8), adjustmentQty: l.adjustment, varianceValue: l.value }).where(eq(stockCountLines.id, l.line.id));
    }
    const needsApproval = v.abs.gt(await this.approvalLimit(tx, a.orgId));
    const [after] = await tx
      .update(stockCounts)
      .set({ status: 'submitted', submittedAt: new Date(), submittedBy: a.userId, varianceValue: v.total.toFixed(2), absVarianceValue: v.abs.toFixed(2), needsApproval, updatedAt: new Date() })
      .where(eq(stockCounts.id, c.id))
      .returning();
    await audit(tx, a, { action: 'stock_count.submitted', entityType: 'stock_count', entityId: c.id, before: { status: c.status }, after: { status: 'submitted', varianceValue: v.total.toFixed(2), needsApproval, counted: v.lines.length, uncounted: v.uncounted } });
    return after!;
  }

  submit(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      await this.submitInTx(tx, a, await this.load(tx, id));
      return this.detailInTx(tx, a, id);
    });
  }

  /** Write the variances to the stock ledger. Uncounted lines are left as they are. */
  async postInTx(tx: Tx, a: AccessContext, c: CountRow) {
    if (c.status !== 'submitted') throw new BadRequestException(c.status === 'open' ? 'Submit the count first' : `This count is ${c.status}`);
    if (c.needsApproval) {
      if (!a.can('stock:approve', c.siteId)) throw new ForbiddenException(`The variances are over the approval limit; someone with stock:approve must post this count`);
      const isAdmin = a.grants.some((g) => g.permissions.includes('*'));
      if (!isAdmin) {
        const [mine] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(stockCountLines)
          .where(and(eq(stockCountLines.countId, c.id), eq(stockCountLines.countedBy, a.userId)));
        if (c.submittedBy === a.userId || (mine?.n ?? 0) > 0) throw new ForbiddenException('Someone who didn\'t count or submit this count must approve it');
      }
    } else this.must(a, 'stock:manage', c.siteId);
    // Recompute costs now (a delivery may have changed the average cost since submitting).
    const v = await this.computeVariances(tx, c);
    let posted = 0;
    for (const l of v.lines) {
      await tx.update(stockCountLines).set({ unitCost: l.unitCost.toFixed(8), adjustmentQty: l.adjustment, varianceValue: l.value }).where(eq(stockCountLines.id, l.line.id));
      const qty = new Decimal(l.adjustment);
      if (qty.isZero()) continue;
      const [bal] = await tx.select({ avgCost: stockBalances.avgCost }).from(stockBalances).where(and(eq(stockBalances.siteId, c.siteId), eq(stockBalances.itemId, l.line.itemId)));
      await this.stock.post(tx, a, {
        siteId: c.siteId,
        itemId: l.line.itemId,
        type: bal ? 'adjustment' : 'opening',
        qtyBase: qty,
        // Only set a cost for stock that appears with no cost history; otherwise the average cost applies.
        unitCost: qty.gt(0) && (!bal || new Decimal(bal.avgCost).isZero()) && !l.unitCost.isZero() ? l.unitCost : null,
        sourceType: 'stock_count',
        sourceId: c.id,
        note: c.ref,
      });
      posted++;
    }
    const [after] = await tx
      .update(stockCounts)
      .set({ status: 'posted', postedAt: new Date(), postedBy: a.userId, varianceValue: v.total.toFixed(2), absVarianceValue: v.abs.toFixed(2), updatedAt: new Date() })
      .where(eq(stockCounts.id, c.id))
      .returning();
    await emitEvent(tx, a, 'stock.counted', { type: 'stock_count', id: c.id }, { countId: c.id, ref: c.ref, siteId: c.siteId, counted: v.lines.length, adjusted: posted, varianceValue: v.total.toFixed(2), absVarianceValue: v.abs.toFixed(2) });
    await audit(tx, a, { action: 'stock_count.posted', entityType: 'stock_count', entityId: c.id, before: { status: c.status }, after: { status: 'posted', adjusted: posted, varianceValue: v.total.toFixed(2) } });
    return after!;
  }

  post(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      await this.postInTx(tx, a, await this.load(tx, id));
      return this.detailInTx(tx, a, id);
    });
  }

  reopen(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.load(tx, id);
      this.must(a, 'stock:manage', c.siteId);
      if (c.status !== 'submitted') throw new BadRequestException(`This count is ${c.status}`);
      await tx.update(stockCountLines).set({ adjustmentQty: null, varianceValue: null, unitCost: null }).where(eq(stockCountLines.countId, c.id));
      await tx
        .update(stockCounts)
        .set({ status: 'open', submittedAt: null, submittedBy: null, varianceValue: null, absVarianceValue: null, needsApproval: false, updatedAt: new Date() })
        .where(eq(stockCounts.id, c.id));
      await audit(tx, a, { action: 'stock_count.reopened', entityType: 'stock_count', entityId: c.id, before: { status: c.status }, after: { status: 'open' } });
      return this.detailInTx(tx, a, id);
    });
  }

  cancel(a: AccessContext, id: string, note: string | null) {
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.load(tx, id);
      this.must(a, 'stock:manage', c.siteId);
      if (!['open', 'submitted'].includes(c.status)) throw new BadRequestException(`A ${c.status} count can't be cancelled`);
      await tx
        .update(stockCounts)
        .set({ status: 'cancelled', cancelledAt: new Date(), note: note ? `${c.note ? `${c.note}\n` : ''}Cancelled: ${note}` : c.note, updatedAt: new Date() })
        .where(eq(stockCounts.id, c.id));
      await audit(tx, a, { action: 'stock_count.cancelled', entityType: 'stock_count', entityId: c.id, before: { status: c.status }, after: { status: 'cancelled', note } });
      return this.detailInTx(tx, a, id);
    });
  }

  settings(a: AccessContext) {
    return this.db.tenant(a.tenant, async (tx) => ({ countApprovalValue: (await this.approvalLimit(tx, a.orgId)).toNumber() }));
  }

  updateSettings(a: AccessContext, dto: SettingsDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [before] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, a.orgId));
      const settings = { ...before!.settings, countApprovalValue: dto.countApprovalValue };
      await tx.update(organizations).set({ settings, updatedAt: new Date() }).where(eq(organizations.id, a.orgId));
      await audit(tx, a, { action: 'org.count_settings', entityType: 'organization', entityId: a.orgId, before: { countApprovalValue: before!.settings.countApprovalValue ?? null }, after: { countApprovalValue: dto.countApprovalValue } });
      return { countApprovalValue: dto.countApprovalValue };
    });
  }

  /** Open count at a site, if any (the newest). */
  async openAt(tx: Tx, siteId: string) {
    const [c] = await tx
      .select()
      .from(stockCounts)
      .where(and(eq(stockCounts.siteId, siteId), eq(stockCounts.status, 'open')))
      .orderBy(desc(stockCounts.createdAt))
      .limit(1);
    return c ?? null;
  }
}

@ApiTags('stock')
@ApiBearerAuth()
@Controller()
export class StockCountsController {
  constructor(private readonly svc: StockCountsService) {}

  @Get('settings/stock-counts') @Requires('stock:read')
  getSettings(@Access() a: AccessContext) { return this.svc.settings(a); }

  @Patch('settings/stock-counts') @Requires('org:manage')
  setSettings(@Access() a: AccessContext, @Body() dto: SettingsDto) { return this.svc.updateSettings(a, dto); }

  @Post('sites/:siteId/stock-counts') @Requires('stock:manage', { siteParam: 'siteId' })
  create(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string, @Body() dto: CreateDto) { return this.svc.create(a, siteId, dto); }

  @Get('stock-counts') @Requires('stock:read')
  list(@Access() a: AccessContext, @Query() q: ListDto) { return this.svc.list(a, q); }

  @Get('stock-counts/:id') @Requires('stock:read')
  detail(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.detail(a, id); }

  @Patch('stock-counts/:id/lines') @Requires('stock:manage')
  lines(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: LinesDto) { return this.svc.recordLines(a, id, dto); }

  @Post('stock-counts/:id/entries') @Requires('stock:manage') @HttpCode(200)
  entries(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: EntriesDto) { return this.svc.entries(a, id, dto); }

  @Post('stock-counts/:id/submit') @Requires('stock:manage') @HttpCode(200)
  submit(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.submit(a, id); }

  @Post('stock-counts/:id/post') @Requires('stock:manage') @HttpCode(200)
  post(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.post(a, id); }

  @Post('stock-counts/:id/reopen') @Requires('stock:manage') @HttpCode(200)
  reopen(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.reopen(a, id); }

  @Post('stock-counts/:id/cancel') @Requires('stock:manage') @HttpCode(200)
  cancel(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: NoteDto) { return this.svc.cancel(a, id, dto.note ?? null); }
}

@Module({ imports: [StockModule], controllers: [StockCountsController], providers: [StockCountsService], exports: [StockCountsService] })
export class StockCountsModule {}
