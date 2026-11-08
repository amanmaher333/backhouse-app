import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  canonicalIngredients,
  itemSiteSettings,
  items,
  orgCounters,
  packs,
  supplierItems,
  tradingRelationships,
  type Tx,
} from '@boh/db';
import {
  ALLERGENS,
  BASE_UNITS,
  ITEM_CATEGORIES,
  UNITS,
  Decimal,
  normalizeName,
  packToBase,
  parseCsvObjects,
  toBase,
  writeCsv,
  type ItemConversion,
  type PackDef,
} from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';
import { MatchingModule, MatchingService, type MatchResult } from './matching.js';

const uuid = new ParseUUIDPipe({ version: '4' });
const unitCode = z.string().refine((u) => u in UNITS, (u) => ({ message: `Unknown unit "${u}"` }));
const qty = z.coerce.number().positive().max(1e9);

const ConversionSchema = z.object({
  from: z.object({ qty, unit: unitCode }),
  to: z.object({ qty, unit: unitCode }),
});

const PackInput = z
  .object({
    name: z.string().min(1).max(100),
    nameAr: z.string().max(100).nullish(),
    qty,
    unit: unitCode.nullish(),
    parentPackId: z.string().uuid().nullish(),
    barcode: z.string().max(64).nullish(),
    isOrderable: z.boolean().default(true),
    isCountable: z.boolean().default(true),
  })
  .refine((p) => Boolean(p.unit) !== Boolean(p.parentPackId), { message: 'Give either unit or parentPackId', path: ['unit'] });
class CreatePackDto extends createZodDto(PackInput) {}
const UpdatePackSchema = z
  .object({
    name: z.string().min(1).max(100),
    nameAr: z.string().max(100).nullish(),
    qty,
    unit: unitCode.nullish(),
    parentPackId: z.string().uuid().nullish(),
    barcode: z.string().max(64).nullish(),
    isOrderable: z.boolean(),
    isCountable: z.boolean(),
  })
  .partial();
class UpdatePackDto extends createZodDto(UpdatePackSchema) {}

const ItemBase = {
  name: z.string().trim().min(1).max(200),
  nameAr: z.string().trim().max(200).nullish(),
  category: z.enum(ITEM_CATEGORIES),
  allergens: z.array(z.enum(ALLERGENS)).max(14),
  conversions: z.array(ConversionSchema).max(5),
  isStockable: z.boolean(),
  trackLots: z.boolean(),
  notes: z.string().max(2000).nullish(),
};
const CreateItemSchema = z.object({
  ...ItemBase,
  category: ItemBase.category.optional(),
  allergens: ItemBase.allergens.optional(),
  conversions: ItemBase.conversions.default([]),
  isStockable: ItemBase.isStockable.default(true),
  trackLots: ItemBase.trackLots.default(false),
  baseUnit: z.enum(BASE_UNITS).optional(),
  /** Explicit link to the shared map (a person chose it). Omit to auto-match; null for "no match". */
  canonicalId: z.string().uuid().nullish(),
  /** Create a default pack (1 kg / 1 L / 1 each). */
  defaultPack: z.boolean().default(true),
});
class CreateItemDto extends createZodDto(CreateItemSchema) {}
const UpdateItemSchema = z.object({ ...ItemBase, isActive: z.boolean() }).partial();
class UpdateItemDto extends createZodDto(UpdateItemSchema) {}

const LinkSchema = z.object({ canonicalId: z.string().uuid().nullable() });
class LinkDto extends createZodDto(LinkSchema) {}

const ListSchema = z.object({
  q: z.string().max(200).optional(),
  category: z.enum(ITEM_CATEGORIES).optional(),
  active: z.enum(['true', 'false', 'all']).default('true'),
  unmatched: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
class ListDto extends createZodDto(ListSchema) {}

const DupSchema = z.object({ name: z.string().min(1).max(200), excludeId: z.string().uuid().optional() });
class DupDto extends createZodDto(DupSchema) {}

const SiteSettingsSchema = z.object({
  parLevel: z.coerce.number().min(0).max(1e9).nullable().optional(),
  reorderPoint: z.coerce.number().min(0).max(1e9).nullable().optional(),
  isStocked: z.boolean().optional(),
  /** Quantities above are in this unit or pack; base unit when omitted. */
  unit: unitCode.optional(),
  packId: z.string().uuid().optional(),
});
class SiteSettingsDto extends createZodDto(SiteSettingsSchema) {}

const ImportSchema = z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) });
class ImportDto extends createZodDto(ImportSchema) {}

const DEFAULT_PACK: Record<string, { name: string; nameAr: string; unit: string }> = {
  g: { name: '1 kg', nameAr: '1 كجم', unit: 'kg' },
  ml: { name: '1 L', nameAr: '1 لتر', unit: 'l' },
  each: { name: '1 each', nameAr: '1 حبة', unit: 'each' },
};

type ItemRow = typeof items.$inferSelect;
type PackRow = typeof packs.$inferSelect;

function asPackDefs(rows: PackRow[]): PackDef[] {
  return rows.map((p) => ({ id: p.id, name: p.name, qty: p.qty, unit: p.unit ?? undefined, packId: p.parentPackId ?? undefined }));
}

/** Physical data from the shared map becomes item conversions (density, piece weight). */
function conversionsFromCanonical(c: { baseUnit: string; densityGPerMl: string | null; eachWeightG: string | null }): ItemConversion[] {
  const out: ItemConversion[] = [];
  if (c.densityGPerMl) out.push({ from: { qty: 1, unit: 'ml' }, to: { qty: c.densityGPerMl, unit: 'g' } });
  if (c.eachWeightG) out.push({ from: { qty: 1, unit: 'each' }, to: { qty: c.eachWeightG, unit: 'g' } });
  return out;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly db: DbService,
    private readonly matching: MatchingService,
  ) {}

  private async nextCode(tx: Tx, orgId: string, key = 'item', prefix = 'ITM'): Promise<string> {
    const [row] = await tx
      .insert(orgCounters)
      .values({ orgId, key, value: 1 })
      .onConflictDoUpdate({ target: [orgCounters.orgId, orgCounters.key], set: { value: sql`${orgCounters.value} + 1` } })
      .returning();
    return `${prefix}-${String(row!.value).padStart(5, '0')}`;
  }

  private async loadItem(tx: Tx, id: string): Promise<ItemRow> {
    const [item] = await tx.select().from(items).where(eq(items.id, id));
    if (!item) throw new NotFoundException('item not found');
    return item;
  }

  /** Recompute base_qty for every pack of an item (nested packs depend on each other). */
  private async recomputePacks(tx: Tx, item: ItemRow): Promise<PackRow[]> {
    const rows = await tx.select().from(packs).where(eq(packs.itemId, item.id));
    const defs = asPackDefs(rows);
    for (const p of rows) {
      const baseQty = packToBase(p.id, defs, item.baseUnit, item.conversions).toFixed(6);
      if (baseQty !== new Decimal(p.baseQty).toFixed(6)) {
        await tx.update(packs).set({ baseQty }).where(eq(packs.id, p.id));
        p.baseQty = baseQty;
      }
    }
    return rows;
  }

  async list(a: AccessContext, q: ListDto) {
    const showPrices = a.can('price:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const conds = [eq(items.orgId, a.orgId)];
      if (q.active !== 'all') conds.push(eq(items.isActive, q.active === 'true'));
      if (q.category) conds.push(eq(items.category, q.category));
      if (q.unmatched === 'true') conds.push(sql`${items.canonicalId} is null`);
      if (q.q?.trim()) {
        const norm = normalizeName(q.q);
        const like = `%${q.q.trim()}%`;
        conds.push(
          or(ilike(items.name, like), ilike(items.nameAr, like), ilike(items.code, like), norm ? sql`${items.nameNorm} % ${norm}` : sql`false`)!,
        );
      }
      const rows = await tx
        .select({
          id: items.id,
          code: items.code,
          name: items.name,
          nameAr: items.nameAr,
          category: items.category,
          baseUnit: items.baseUnit,
          isActive: items.isActive,
          canonicalId: items.canonicalId,
          canonicalSource: items.canonicalSource,
          canonicalNameEn: canonicalIngredients.nameEn,
          canonicalNameAr: canonicalIngredients.nameAr,
          allergens: items.allergens,
          packCount: sql<number>`(select count(*)::int from ${packs} where ${packs.itemId} = ${items.id})`,
          supplierCount: sql<number>`(select count(*)::int from ${supplierItems} where ${supplierItems.itemId} = ${items.id} and ${supplierItems.isActive})`,
          bestCostPerBase: sql<string | null>`(select min(${supplierItems.currentPrice} / nullif(${packs.baseQty}, 0))::text
              from ${supplierItems} join ${packs} on ${packs.id} = ${supplierItems.packId}
              where ${supplierItems.itemId} = ${items.id} and ${supplierItems.isActive})`,
        })
        .from(items)
        .leftJoin(canonicalIngredients, eq(canonicalIngredients.id, items.canonicalId))
        .where(and(...conds))
        .orderBy(asc(items.name))
        .limit(q.limit)
        .offset(q.offset);
      return showPrices ? rows : rows.map(({ bestCostPerBase: _b, ...r }) => r);
    });
  }

  async get(a: AccessContext, id: string) {
    const showPrices = a.can('price:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const item = await this.loadItem(tx, id);
      const [canonical] = item.canonicalId
        ? await tx.select().from(canonicalIngredients).where(eq(canonicalIngredients.id, item.canonicalId))
        : [];
      const itemPacks = await tx.select().from(packs).where(eq(packs.itemId, id)).orderBy(asc(packs.baseQty));
      const siteSettings = await tx.select().from(itemSiteSettings).where(eq(itemSiteSettings.itemId, id));
      const sup = await tx
        .select({
          id: supplierItems.id,
          relationshipId: supplierItems.relationshipId,
          supplierName: tradingRelationships.displayName,
          supplierNameAr: tradingRelationships.displayNameAr,
          packId: supplierItems.packId,
          supplierSku: supplierItems.supplierSku,
          supplierItemName: supplierItems.supplierName,
          currentPrice: supplierItems.currentPrice,
          currency: supplierItems.currency,
          priceUpdatedAt: supplierItems.priceUpdatedAt,
          isPreferred: supplierItems.isPreferred,
          isActive: supplierItems.isActive,
          packBaseQty: packs.baseQty,
        })
        .from(supplierItems)
        .innerJoin(tradingRelationships, eq(tradingRelationships.id, supplierItems.relationshipId))
        .innerJoin(packs, eq(packs.id, supplierItems.packId))
        .where(eq(supplierItems.itemId, id))
        .orderBy(asc(tradingRelationships.displayName));
      const supplierLines = sup.map((s) => {
        const costPerBase = new Decimal(s.currentPrice).div(s.packBaseQty).toString();
        return showPrices ? { ...s, costPerBase } : { ...s, currentPrice: undefined, costPerBase: undefined };
      });
      return { ...item, canonical: canonical ?? null, packs: itemPacks, siteSettings, supplierItems: supplierLines };
    });
  }

  async duplicates(a: AccessContext, name: string, excludeId?: string) {
    const norm = normalizeName(name);
    if (!norm) return [];
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select({ id: items.id, code: items.code, name: items.name, nameAr: items.nameAr, score: sql<number>`similarity(${items.nameNorm}, ${norm})` })
        .from(items)
        .where(
          and(
            eq(items.orgId, a.orgId),
            sql`(${items.nameNorm} % ${norm} or lower(${items.name}) = lower(${name}))`,
            excludeId ? sql`${items.id} <> ${excludeId}` : undefined,
          ),
        )
        .orderBy(sql`4 desc`)
        .limit(5),
    );
  }

  /** Shared by create and import. Returns the item and the match it was based on. */
  private async createInTx(tx: Tx, a: AccessContext, dto: CreateItemDto): Promise<{ item: ItemRow; match: MatchResult | null; packs: PackRow[] }> {
    let canonical: typeof canonicalIngredients.$inferSelect | undefined;
    let match: MatchResult | null = null;
    let source: 'auto' | 'human' | null = null;
    let score: string | null = null;

    if (dto.canonicalId) {
      [canonical] = await tx.select().from(canonicalIngredients).where(eq(canonicalIngredients.id, dto.canonicalId));
      if (!canonical) throw new BadRequestException('canonicalId not found');
      source = 'human';
    } else if (dto.canonicalId === undefined) {
      match = await this.matching.match(tx, dto.nameAr ? `${dto.name} ${dto.nameAr}` : dto.name);
      if (!match.auto) match = dto.nameAr ? await this.matching.match(tx, dto.name) : match;
      if (match.auto) {
        [canonical] = await tx.select().from(canonicalIngredients).where(eq(canonicalIngredients.id, match.auto.canonicalId));
        source = 'auto';
        score = String(match.auto.score);
      }
    }

    const baseUnit = dto.baseUnit ?? canonical?.baseUnit;
    if (!baseUnit) throw new BadRequestException('baseUnit is required when the item does not match a known ingredient');
    const conversions = dto.conversions.length ? dto.conversions : canonical ? conversionsFromCanonical(canonical) : [];

    const [item] = await tx
      .insert(items)
      .values({
        orgId: a.orgId,
        code: await this.nextCode(tx, a.orgId),
        name: dto.name,
        nameAr: dto.nameAr ?? (canonical && source ? canonical.nameAr : null),
        nameNorm: normalizeName(dto.name) || dto.name.toLowerCase(),
        category: dto.category ?? (canonical?.category as ItemRow['category']) ?? 'other',
        baseUnit,
        canonicalId: canonical?.id ?? null,
        canonicalScore: score,
        canonicalSource: source,
        allergens: dto.allergens ?? canonical?.allergens ?? [],
        conversions,
        isStockable: dto.isStockable,
        trackLots: dto.trackLots,
        notes: dto.notes ?? null,
      })
      .returning();

    const created: PackRow[] = [];
    if (dto.defaultPack) {
      const d = DEFAULT_PACK[baseUnit]!;
      const [p] = await tx
        .insert(packs)
        .values({ orgId: a.orgId, itemId: item!.id, name: d.name, nameAr: d.nameAr, qty: '1', unit: d.unit, baseQty: toBase(1, { unit: d.unit }, { baseUnit }).toFixed(6) })
        .returning();
      created.push(p!);
    }
    await audit(tx, a, { action: 'item.created', entityType: 'item', entityId: item!.id, after: { ...item, match: match?.auto ?? null } });
    if (source === 'human') {
      await this.matching.recordHumanMatch(tx, a, { type: 'item', id: item!.id, name: dto.name }, null, canonical!.id);
    }
    return { item: item!, match, packs: created };
  }

  async create(a: AccessContext, dto: CreateItemDto) {
    const result = await this.db.tenant(a.tenant, (tx) => this.createInTx(tx, a, dto));
    if (result.item.canonicalSource === 'human' && result.item.canonicalId) {
      await this.matching.learnAlias(a.orgId, result.item.name, result.item.canonicalId);
    }
    return { ...result.item, packs: result.packs, match: result.match };
  }

  async update(a: AccessContext, id: string, dto: UpdateItemDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const before = await this.loadItem(tx, id);
      if (Object.keys(dto).length === 0) return before;
      const values: Partial<typeof items.$inferInsert> = { ...dto };
      if (dto.name) values.nameNorm = normalizeName(dto.name) || dto.name.toLowerCase();
      const [after] = await tx.update(items).set(values).where(eq(items.id, id)).returning();
      if (dto.conversions) await this.recomputePacks(tx, after!);
      await audit(tx, a, { action: 'item.updated', entityType: 'item', entityId: id, before, after });
      return after;
    });
  }

  /** A person links (or unlinks) the item to the shared ingredient map. */
  async link(a: AccessContext, id: string, canonicalId: string | null) {
    const after = await this.db.tenant(a.tenant, async (tx) => {
      const before = await this.loadItem(tx, id);
      if (canonicalId) {
        const [c] = await tx.select({ id: canonicalIngredients.id }).from(canonicalIngredients).where(eq(canonicalIngredients.id, canonicalId));
        if (!c) throw new BadRequestException('canonicalId not found');
      }
      const [row] = await tx
        .update(items)
        .set({ canonicalId, canonicalSource: canonicalId ? 'human' : null, canonicalScore: null })
        .where(eq(items.id, id))
        .returning();
      await this.matching.recordHumanMatch(
        tx,
        a,
        { type: 'item', id, name: before.name },
        { canonicalId: before.canonicalId, source: before.canonicalSource, score: before.canonicalScore },
        canonicalId,
      );
      await audit(tx, a, { action: 'item.canonical_linked', entityType: 'item', entityId: id, before: { canonicalId: before.canonicalId }, after: { canonicalId } });
      return row!;
    });
    if (canonicalId) await this.matching.learnAlias(a.orgId, after.name, canonicalId);
    return after;
  }

  // ---------- Packs ----------
  async createPack(a: AccessContext, itemId: string, dto: CreatePackDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const item = await this.loadItem(tx, itemId);
      const existing = await tx.select().from(packs).where(eq(packs.itemId, itemId));
      if (dto.parentPackId && !existing.some((p) => p.id === dto.parentPackId)) throw new BadRequestException('parentPackId is not a pack of this item');
      const tmpId = 'new';
      const baseQty = packToBase(tmpId, [...asPackDefs(existing), { id: tmpId, name: dto.name, qty: dto.qty, unit: dto.unit ?? undefined, packId: dto.parentPackId ?? undefined }], item.baseUnit, item.conversions).toFixed(6);
      const [p] = await tx
        .insert(packs)
        .values({ ...dto, qty: String(dto.qty), orgId: a.orgId, itemId, baseQty, unit: dto.unit ?? null, parentPackId: dto.parentPackId ?? null })
        .returning();
      await audit(tx, a, { action: 'pack.created', entityType: 'pack', entityId: p!.id, after: p });
      return p;
    });
  }

  async updatePack(a: AccessContext, itemId: string, packId: string, dto: UpdatePackDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const item = await this.loadItem(tx, itemId);
      const [before] = await tx.select().from(packs).where(and(eq(packs.id, packId), eq(packs.itemId, itemId)));
      if (!before) throw new NotFoundException('pack not found');
      const values = Object.fromEntries(
        Object.entries({ ...dto, qty: dto.qty !== undefined ? String(dto.qty) : undefined }).filter(([, v]) => v !== undefined),
      ) as Partial<typeof packs.$inferInsert>;
      if (dto.unit) values.parentPackId = null;
      if (dto.parentPackId) values.unit = null;
      // Validate the whole pack tree with the change applied before writing.
      const all = await tx.select().from(packs).where(eq(packs.itemId, itemId));
      const defs = asPackDefs(all.map((p) => (p.id === packId ? { ...p, ...values } as PackRow : p)));
      for (const d of defs) packToBase(d.id, defs, item.baseUnit, item.conversions);
      const [after] = await tx.update(packs).set(values).where(eq(packs.id, packId)).returning();
      await this.recomputePacks(tx, item);
      await audit(tx, a, { action: 'pack.updated', entityType: 'pack', entityId: packId, before, after });
      return after;
    });
  }

  async deletePack(a: AccessContext, itemId: string, packId: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const children = await tx.select({ id: packs.id }).from(packs).where(eq(packs.parentPackId, packId)).limit(1);
      if (children.length) throw new BadRequestException('Other packs are built from this pack; change them first');
      const used = await tx.select({ id: supplierItems.id }).from(supplierItems).where(eq(supplierItems.packId, packId)).limit(1);
      if (used.length) throw new BadRequestException('A supplier sells this pack; remove it from their catalogue first');
      const [before] = await tx.delete(packs).where(and(eq(packs.id, packId), eq(packs.itemId, itemId))).returning();
      if (!before) throw new NotFoundException('pack not found');
      await audit(tx, a, { action: 'pack.deleted', entityType: 'pack', entityId: packId, before });
    });
  }

  // ---------- Site settings (par levels) ----------
  async setSiteSettings(a: AccessContext, itemId: string, siteId: string, dto: SiteSettingsDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const item = await this.loadItem(tx, itemId);
      const itemPacks = dto.packId ? await tx.select().from(packs).where(eq(packs.itemId, itemId)) : [];
      if (dto.packId && !itemPacks.some((p) => p.id === dto.packId)) throw new BadRequestException('packId is not a pack of this item');
      const conv = (v: number | null | undefined) => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        const of = dto.packId ? { packId: dto.packId } : { unit: dto.unit ?? item.baseUnit };
        return toBase(v, of, { baseUnit: item.baseUnit, packs: asPackDefs(itemPacks), conversions: item.conversions }).toFixed(6);
      };
      const values = { parLevel: conv(dto.parLevel), reorderPoint: conv(dto.reorderPoint), isStocked: dto.isStocked };
      const [before] = await tx.select().from(itemSiteSettings).where(and(eq(itemSiteSettings.itemId, itemId), eq(itemSiteSettings.siteId, siteId)));
      const [after] = await tx
        .insert(itemSiteSettings)
        .values({ orgId: a.orgId, itemId, siteId, ...values })
        .onConflictDoUpdate({ target: [itemSiteSettings.itemId, itemSiteSettings.siteId], set: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) })
        .returning();
      await audit(tx, a, { action: 'item_site.updated', entityType: 'item', entityId: itemId, before: before ?? null, after });
      return after;
    });
  }

  // ---------- CSV ----------
  async exportCsv(a: AccessContext) {
    const rows = await this.db.tenant(a.tenant, (tx) =>
      tx
        .select({ item: items, slug: canonicalIngredients.slug })
        .from(items)
        .leftJoin(canonicalIngredients, eq(canonicalIngredients.id, items.canonicalId))
        .where(eq(items.orgId, a.orgId))
        .orderBy(asc(items.code)),
    );
    return writeCsv(
      ['code', 'name', 'name_ar', 'category', 'base_unit', 'allergens', 'ingredient', 'active'],
      rows.map(({ item, slug }) => ({
        code: item.code,
        name: item.name,
        name_ar: item.nameAr ?? '',
        category: item.category,
        base_unit: item.baseUnit,
        allergens: item.allergens.join(';'),
        ingredient: slug ?? '',
        active: item.isActive ? 'yes' : 'no',
      })),
    );
  }

  /**
   * Import items. Columns: code (optional), name, name_ar, category, base_unit,
   * allergens (";"-separated), ingredient (shared-map slug, optional), active.
   * Existing items are matched by code, then by exact name. Dry run by default.
   */
  async importCsv(a: AccessContext, dto: ImportDto) {
    const { headers, rows } = parseCsvObjects(dto.csv);
    if (!headers.includes('name')) throw new BadRequestException('CSV needs at least a "name" column');
    if (rows.length > 5000) throw new BadRequestException('At most 5000 rows per import');

    type Outcome = { row: number; action: 'create' | 'update' | 'skip' | 'error'; name: string; errors: string[]; match?: { slug: string; nameEn: string; score: number } | null; id?: string };
    const learned: { name: string; canonicalId: string }[] = [];

    const run = async (tx: Tx) => {
      const out: Outcome[] = [];
      const existing = await tx.select().from(items).where(eq(items.orgId, a.orgId));
      const byCode = new Map(existing.map((i) => [i.code.toLowerCase(), i]));
      const byName = new Map(existing.map((i) => [i.name.toLowerCase(), i]));
      const slugs = await tx.select({ id: canonicalIngredients.id, slug: canonicalIngredients.slug }).from(canonicalIngredients);
      const bySlug = new Map(slugs.map((s) => [s.slug, s.id]));
      const seenNames = new Set<string>();

      for (const [i, r] of rows.entries()) {
        const rowNo = i + 2; // header is row 1
        const name = r.name ?? '';
        const errors: string[] = [];
        if (!name) errors.push('name is required');
        const lname = name.toLowerCase();
        if (seenNames.has(lname)) errors.push('duplicate name in this file');
        seenNames.add(lname);
        const category = r.category || undefined;
        if (category && !(ITEM_CATEGORIES as readonly string[]).includes(category)) errors.push(`unknown category "${category}"`);
        const baseUnit = r.base_unit || undefined;
        if (baseUnit && !(BASE_UNITS as readonly string[]).includes(baseUnit)) errors.push(`base_unit must be g, ml or each`);
        const allergens = (r.allergens ?? '').split(/[;|]/).map((s) => s.trim()).filter(Boolean);
        const badAllergen = allergens.find((x) => !(ALLERGENS as readonly string[]).includes(x));
        if (badAllergen) errors.push(`unknown allergen "${badAllergen}"`);
        const slug = r.ingredient || undefined;
        if (slug && !bySlug.has(slug)) errors.push(`unknown ingredient "${slug}"`);
        const active = r.active ? !['no', 'false', '0', 'لا'].includes(r.active.toLowerCase()) : undefined;
        if (errors.length) {
          out.push({ row: rowNo, action: 'error', name, errors });
          continue;
        }

        const target = (r.code && byCode.get(r.code.toLowerCase())) || byName.get(lname);
        if (target) {
          const values: Partial<typeof items.$inferInsert> = {};
          if (name !== target.name) Object.assign(values, { name, nameNorm: normalizeName(name) || lname });
          // Empty cells mean "leave as is" on update.
          if (r.name_ar && r.name_ar !== target.nameAr) values.nameAr = r.name_ar;
          if (category && category !== target.category) values.category = category;
          if (r.allergens && allergens.join(';') !== target.allergens.join(';')) values.allergens = allergens;
          if (active !== undefined && active !== target.isActive) values.isActive = active;
          if (slug && bySlug.get(slug) !== target.canonicalId) Object.assign(values, { canonicalId: bySlug.get(slug), canonicalSource: 'human', canonicalScore: null });
          if (baseUnit && baseUnit !== target.baseUnit) {
            out.push({ row: rowNo, action: 'error', name, errors: ['base_unit cannot change for an existing item'] });
            continue;
          }
          if (Object.keys(values).length === 0) {
            out.push({ row: rowNo, action: 'skip', name, errors: [], id: target.id });
            continue;
          }
          if (!dto.dryRun) {
            const [after] = await tx.update(items).set(values).where(eq(items.id, target.id)).returning();
            await audit(tx, a, { action: 'item.updated', entityType: 'item', entityId: target.id, before: target, after: { ...after, via: 'csv' } });
            if (values.canonicalId) learned.push({ name, canonicalId: values.canonicalId as string });
          }
          out.push({ row: rowNo, action: 'update', name, errors: [], id: target.id });
          continue;
        }

        // New item: preview the match so people can see what will be linked.
        const m = slug ? null : await this.matching.match(tx, r.name_ar ? `${name} ${r.name_ar}` : name);
        const match = slug ? { slug, nameEn: slug, score: 1 } : m?.auto ? { slug: m.auto.slug, nameEn: m.auto.nameEn, score: m.auto.score } : null;
        if (!baseUnit && !match) {
          out.push({ row: rowNo, action: 'error', name, errors: ['base_unit is required (no confident ingredient match)'], match: null });
          continue;
        }
        if (!dto.dryRun) {
          const res = await this.createInTx(tx, a, {
            name,
            nameAr: r.name_ar || null,
            category: category as CreateItemDto['category'],
            baseUnit: baseUnit as CreateItemDto['baseUnit'],
            allergens: r.allergens !== undefined && r.allergens !== '' ? (allergens as CreateItemDto['allergens']) : undefined,
            canonicalId: slug ? bySlug.get(slug)! : undefined,
            conversions: [],
            isStockable: true,
            trackLots: false,
            defaultPack: true,
          });
          if (active === false) await tx.update(items).set({ isActive: false }).where(eq(items.id, res.item.id));
          if (slug) learned.push({ name, canonicalId: bySlug.get(slug)! });
          out.push({ row: rowNo, action: 'create', name, errors: [], match, id: res.item.id });
        } else {
          out.push({ row: rowNo, action: 'create', name, errors: [], match });
        }
      }
      return out;
    };

    const results = await this.db.tenant(a.tenant, async (tx) => {
      const out = await run(tx);
      // All or nothing: if any row has an error, nothing is written.
      if (!dto.dryRun && out.some((o) => o.action === 'error')) {
        throw new BadRequestException({ statusCode: 400, message: 'Fix the rows with errors and try again', results: out });
      }
      return out;
    });
    if (!dto.dryRun) for (const l of learned) await this.matching.learnAlias(a.orgId, l.name, l.canonicalId);
    const count = (k: string) => results.filter((r) => r.action === k).length;
    return { dryRun: dto.dryRun, summary: { create: count('create'), update: count('update'), skip: count('skip'), error: count('error') }, results };
  }
}

@ApiTags('items')
@ApiBearerAuth()
@Controller('items')
export class ItemsController {
  constructor(private readonly svc: ItemsService) {}

  @Get() @Requires('item:read')
  list(@Access() a: AccessContext, @Query() q: ListDto) { return this.svc.list(a, q); }

  @Get('duplicates') @Requires('item:read')
  duplicates(@Access() a: AccessContext, @Query() q: DupDto) { return this.svc.duplicates(a, q.name, q.excludeId); }

  @Get('export') @Requires('item:read')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="items.csv"')
  export(@Access() a: AccessContext) { return this.svc.exportCsv(a); }

  @Post('import') @Requires('item:manage') @HttpCode(200)
  import(@Access() a: AccessContext, @Body() dto: ImportDto) { return this.svc.importCsv(a, dto); }

  @Post() @Requires('item:manage')
  create(@Access() a: AccessContext, @Body() dto: CreateItemDto) { return this.svc.create(a, dto); }

  @Get(':id') @Requires('item:read')
  get(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.get(a, id); }

  @Patch(':id') @Requires('item:manage')
  update(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateItemDto) { return this.svc.update(a, id, dto); }

  @Put(':id/canonical') @Requires('item:manage')
  link(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: LinkDto) { return this.svc.link(a, id, dto.canonicalId); }

  @Post(':id/packs') @Requires('item:manage')
  createPack(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: CreatePackDto) { return this.svc.createPack(a, id, dto); }

  @Patch(':id/packs/:packId') @Requires('item:manage')
  updatePack(@Access() a: AccessContext, @Param('id', uuid) id: string, @Param('packId', uuid) packId: string, @Body() dto: UpdatePackDto) {
    return this.svc.updatePack(a, id, packId, dto);
  }

  @Delete(':id/packs/:packId') @Requires('item:manage') @HttpCode(204)
  deletePack(@Access() a: AccessContext, @Param('id', uuid) id: string, @Param('packId', uuid) packId: string) {
    return this.svc.deletePack(a, id, packId);
  }

  @Put(':id/sites/:siteId') @Requires('par:manage', { siteParam: 'siteId' })
  siteSettings(@Access() a: AccessContext, @Param('id', uuid) id: string, @Param('siteId', uuid) siteId: string, @Body() dto: SiteSettingsDto) {
    return this.svc.setSiteSettings(a, id, siteId, dto);
  }
}

@Module({ imports: [MatchingModule], controllers: [ItemsController], providers: [ItemsService], exports: [ItemsService] })
export class ItemsModule {}

