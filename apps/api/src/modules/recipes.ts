import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { items, organizations, packs, posConnections, posItems, posProducts, recipeLines, recipes, stockBalances, supplierItems, type Tx } from '@boh/db';
import {
  Decimal,
  UNITS,
  costRecipes,
  country,
  foodCostPct,
  posUnitToBase,
  priceExVat,
  toBase,
  wouldCycle,
  type CostingItem,
  type PackDef,
  type RecipeCost,
  type RecipeDef,
} from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';

const uuid = new ParseUUIDPipe({ version: '4' });
type RecipeRow = typeof recipes.$inferSelect;
type LineRow = typeof recipeLines.$inferSelect;

/** Which cost to use for ingredients: supplier price (preferred, else cheapest) or the stock average across sites. */
const Basis = z.enum(['supplier', 'average']).default('supplier');
export type CostBasis = z.infer<typeof Basis>;

const LineSchema = z
  .object({
    itemId: z.string().uuid().nullish(),
    subRecipeId: z.string().uuid().nullish(),
    qty: z.coerce.number().positive().max(1e7),
    unit: z.string().refine((u) => u in UNITS, 'Unknown unit').nullish(),
    packId: z.string().uuid().nullish(),
    yieldPct: z.coerce.number().gt(0).max(100).default(100),
    note: z.string().max(200).nullish(),
  })
  .refine((l) => Boolean(l.itemId) !== Boolean(l.subRecipeId), { message: 'Each line uses an item or a prep recipe' });
/** The fields, without defaults (an update must only change what it sends). */
const RecipeFields = z.object({
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).nullish(),
  kind: z.enum(['menu', 'prep']),
  category: z.string().trim().max(60).nullish(),
  yieldQty: z.coerce.number().positive().max(1e6),
  yieldUnit: z.string().refine((u) => u in UNITS, 'Unknown unit'),
  sellingPrice: z.coerce.number().min(0).max(1e6).nullish(),
  priceIncludesVat: z.boolean(),
  targetCostPct: z.coerce.number().min(0).max(100).nullish(),
  posProductId: z.string().uuid().nullish(),
  notes: z.string().max(2000).nullish(),
  lines: z.array(LineSchema).max(100),
});
const RecipeSchema = RecipeFields.extend({
  kind: RecipeFields.shape.kind.default('menu'),
  yieldQty: RecipeFields.shape.yieldQty.default(1),
  yieldUnit: RecipeFields.shape.yieldUnit.default('each'),
  priceIncludesVat: RecipeFields.shape.priceIncludesVat.default(true),
  lines: RecipeFields.shape.lines.default([]),
});
class RecipeDto extends createZodDto(RecipeSchema) {}
class UpdateRecipeDto extends createZodDto(RecipeFields.partial()) {}
export type RecipeInput = z.infer<typeof RecipeSchema>;

const ListSchema = z.object({ kind: z.enum(['menu', 'prep']).optional(), q: z.string().max(80).optional(), basis: Basis });
class ListDto extends createZodDto(ListSchema) {}
class BasisDto extends createZodDto(z.object({ basis: Basis })) {}
class PreviewDto extends createZodDto(RecipeFields.partial().extend({ recipeId: z.string().uuid().nullish(), basis: Basis.optional() })) {}
class FromPosDto extends createZodDto(z.object({ productIds: z.array(z.string().uuid()).max(500).optional() })) {}

/**
 * Recipes and costing. Costs are worked out on read from the chosen basis, so they follow
 * supplier prices and stock costs without anything to recalculate.
 */
@Injectable()
export class RecipesService {
  constructor(private readonly db: DbService) {}

  private must(a: AccessContext, perm: 'recipe:read' | 'recipe:manage') {
    if (!a.holdsOrgWide(perm) && !a.can(perm)) throw new ForbiddenException(`Missing permission ${perm}`);
  }

  /** Cost per base unit for each item, on the chosen basis (falling back to supplier price). */
  async itemCosts(tx: Tx, itemIds: string[], basis: CostBasis): Promise<Map<string, Decimal>> {
    const out = new Map<string, Decimal>();
    if (!itemIds.length) return out;
    const offers = await tx
      .select({ itemId: supplierItems.itemId, price: supplierItems.currentPrice, isPreferred: supplierItems.isPreferred, baseQty: packs.baseQty })
      .from(supplierItems)
      .innerJoin(packs, eq(packs.id, supplierItems.packId))
      .where(and(inArray(supplierItems.itemId, itemIds), eq(supplierItems.isActive, true)));
    for (const id of itemIds) {
      const mine = offers.filter((o) => o.itemId === id && o.price !== null && new Decimal(o.baseQty).gt(0));
      const pick = mine.find((o) => o.isPreferred) ?? mine.sort((x, y) => new Decimal(x.price!).div(x.baseQty).cmp(new Decimal(y.price!).div(y.baseQty)))[0];
      if (pick) out.set(id, new Decimal(pick.price!).div(pick.baseQty));
    }
    if (basis === 'average') {
      const avgs = await tx
        .select({ itemId: stockBalances.itemId, value: sql<string>`sum(${stockBalances.qtyOnHand} * ${stockBalances.avgCost})::text`, qty: sql<string>`sum(${stockBalances.qtyOnHand})::text` })
        .from(stockBalances)
        .where(and(inArray(stockBalances.itemId, itemIds), gt(stockBalances.qtyOnHand, '0'), gt(stockBalances.avgCost, '0')))
        .groupBy(stockBalances.itemId);
      for (const r of avgs) if (new Decimal(r.qty).gt(0)) out.set(r.itemId, new Decimal(r.value).div(r.qty));
    }
    return out;
  }

  /** Every active recipe costed, plus what's needed to show them. */
  private async costAll(tx: Tx, basis: CostBasis, draft?: { id: string; input: Partial<RecipeInput> }) {
    let rs = await tx.select().from(recipes).where(eq(recipes.isActive, true)).orderBy(asc(recipes.kind), asc(recipes.name));
    let ls = rs.length ? await tx.select().from(recipeLines).where(inArray(recipeLines.recipeId, rs.map((r) => r.id))).orderBy(asc(recipeLines.position)) : [];
    if (draft) {
      // An unsaved version of a recipe (new or edited): cost it in place of the saved one.
      const saved = rs.find((r) => r.id === draft.id);
      const d = draft.input;
      const row: RecipeRow = {
        ...(saved ?? { id: draft.id, orgId: '', name: '', nameAr: null, kind: 'menu', category: null, yieldQty: '1', yieldUnit: 'each', sellingPrice: null, priceIncludesVat: true, targetCostPct: null, posProductId: null, notes: null, isActive: true, source: 'app', createdBy: null, createdAt: new Date(), updatedAt: new Date() }),
        ...this.values(d),
      } as RecipeRow;
      rs = [...rs.filter((r) => r.id !== draft.id), row];
      if (d.lines) {
        ls = [
          ...ls.filter((l) => l.recipeId !== draft.id),
          ...d.lines.map((l, i) => ({ id: `draft-${i}`, orgId: '', recipeId: draft.id, position: i, itemId: l.itemId ?? null, subRecipeId: l.subRecipeId ?? null, qty: String(l.qty), unit: l.packId ? null : (l.unit ?? null), packId: l.packId ?? null, yieldPct: String(l.yieldPct ?? 100), note: l.note ?? null })),
        ];
      }
    }
    const itemIds = [...new Set(ls.map((l) => l.itemId).filter((x): x is string => !!x))];
    const itemRows = itemIds.length ? await tx.select().from(items).where(inArray(items.id, itemIds)) : [];
    const packRows = itemIds.length ? await tx.select().from(packs).where(inArray(packs.itemId, itemIds)) : [];
    const costs = await this.itemCosts(tx, itemIds, basis);
    const catalogue = new Map<string, CostingItem>(
      itemRows.map((i) => [
        i.id,
        {
          id: i.id,
          name: i.name,
          baseUnit: i.baseUnit,
          conversions: i.conversions,
          packs: packRows.filter((p) => p.itemId === i.id).map((p) => ({ id: p.id, name: p.name, qty: p.qty, unit: p.unit ?? undefined, packId: p.parentPackId ?? undefined }) as PackDef),
          costPerBase: costs.get(i.id) ?? null,
          allergens: i.allergens,
        },
      ]),
    );
    const defs: RecipeDef[] = rs.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind as RecipeDef['kind'],
      yieldQty: r.yieldQty,
      yieldUnit: r.yieldUnit,
      lines: ls.filter((l) => l.recipeId === r.id).map((l) => ({ id: l.id, itemId: l.itemId, subRecipeId: l.subRecipeId, qty: l.qty, unit: l.unit, packId: l.packId, yieldPct: l.yieldPct })),
    }));
    const costed = costRecipes(defs, catalogue);
    const posIds = rs.map((r) => r.posProductId).filter((x): x is string => !!x);
    const pos = posIds.length ? await tx.select({ id: posProducts.id, name: posProducts.name, nameAr: posProducts.nameAr, price: posProducts.price }).from(posProducts).where(inArray(posProducts.id, posIds)) : [];
    const [org] = await tx.select({ country: organizations.country }).from(organizations);
    const vat = country(org?.country).vatRate;
    return { rs, ls, itemRows, packRows, catalogue, costed, pos, vat, defs };
  }

  /** Active recipes as costing definitions, with their items (for food cost reports). */
  async definitions(tx: Tx, basis: CostBasis = 'average') {
    const { rs, defs, catalogue } = await this.costAll(tx, basis);
    return { recipes: rs, defs, catalogue };
  }

  /** Price, cost per portion (or per yield unit) and food cost % for one recipe. */
  private summary(a: AccessContext, r: RecipeRow, c: RecipeCost, pos: { id: string; name: string; nameAr: string | null; price: string | null }[], vat: string) {
    const p = r.posProductId ? pos.find((x) => x.id === r.posProductId) : undefined;
    const price = r.sellingPrice ?? p?.price ?? null;
    const exVat = price !== null ? priceExVat(price, r.priceIncludesVat, vat) : null;
    // Menu items: cost of one portion (one yield unit); preps: cost of the batch and per kg / L / each.
    const perYieldUnit = c.perBase !== null && c.yieldBaseUnit ? new Decimal(c.perBase).mul(new Decimal(c.yieldBase!).div(r.yieldQty)) : null;
    const pct = perYieldUnit && exVat ? foodCostPct(perYieldUnit, exVat) : null;
    const showCost = a.can('price:read');
    return {
      price: price !== null ? new Decimal(price).toFixed(2) : null,
      priceSource: r.sellingPrice !== null ? 'recipe' : p?.price ? 'pos' : null,
      priceExVat: exVat ? exVat.toFixed(2) : null,
      batchCost: showCost ? new Decimal(c.total).toFixed(2) : undefined,
      unitCost: showCost && perYieldUnit ? perYieldUnit.toFixed(4) : undefined,
      foodCostPct: showCost ? pct : undefined,
      overTarget: showCost && pct !== null && r.targetCostPct !== null ? new Decimal(pct).gt(r.targetCostPct) : undefined,
      missing: c.missing,
      cycle: c.cycle,
      allergens: c.allergens,
      posProduct: p ? { id: p.id, name: p.name, nameAr: p.nameAr } : null,
    };
  }

  list(a: AccessContext, q: ListDto) {
    this.must(a, 'recipe:read');
    return this.db.tenant(a.tenant, (tx) => this.listInTx(tx, a, q));
  }

  /** Recipes with costs inside the caller's transaction (agents use this). */
  async listInTx(tx: Tx, a: AccessContext, q: { kind?: 'menu' | 'prep'; q?: string; basis: CostBasis }) {
    this.must(a, 'recipe:read');
    {
      const { rs, ls, costed, pos, vat } = await this.costAll(tx, q.basis);
      const needle = q.q?.trim().toLowerCase();
      return rs
        .filter((r) => (!q.kind || r.kind === q.kind) && (!needle || r.name.toLowerCase().includes(needle) || (r.nameAr ?? '').includes(needle) || (r.category ?? '').toLowerCase().includes(needle)))
        .map((r) => ({
          id: r.id,
          name: r.name,
          nameAr: r.nameAr,
          kind: r.kind,
          category: r.category,
          yieldQty: r.yieldQty,
          yieldUnit: r.yieldUnit,
          targetCostPct: r.targetCostPct,
          source: r.source,
          lines: ls.filter((l) => l.recipeId === r.id).length,
          ...this.summary(a, r, costed.get(r.id)!, pos, vat),
        }));
    }
  }

  async detailInTx(tx: Tx, a: AccessContext, id: string, basis: CostBasis, draft?: Partial<RecipeInput>) {
    const { rs, ls, itemRows, packRows, catalogue, costed, pos, vat } = await this.costAll(tx, basis, draft ? { id, input: draft } : undefined);
    let r = rs.find((x) => x.id === id);
    if (!r) {
      [r] = await tx.select().from(recipes).where(eq(recipes.id, id));
      if (!r) throw new NotFoundException('recipe not found');
    }
    const c = costed.get(r.id) ?? { id, total: '0', perBase: null, yieldBaseUnit: null, yieldBase: null, lines: [], allergens: [], missing: [], cycle: false };
    const mine = ls.filter((l) => l.recipeId === r!.id);
    const showCost = a.can('price:read');
    const usedIn = rs.filter((x) => ls.some((l) => l.recipeId === x.id && l.subRecipeId === r!.id)).map((x) => ({ id: x.id, name: x.name, nameAr: x.nameAr }));
    return {
      ...r,
      ...this.summary(a, r, c, pos, vat),
      usedIn,
      lines: mine.map((l, i) => {
        const cl = c.lines[i];
        const item = l.itemId ? itemRows.find((x) => x.id === l.itemId) : undefined;
        const sub = l.subRecipeId ? rs.find((x) => x.id === l.subRecipeId) : undefined;
        return {
          id: l.id,
          itemId: l.itemId,
          subRecipeId: l.subRecipeId,
          name: item?.name ?? sub?.name ?? cl?.name ?? '?',
          nameAr: item?.nameAr ?? sub?.nameAr ?? null,
          baseUnit: item?.baseUnit ?? cl?.baseUnit ?? null,
          packs: item ? packRows.filter((p) => p.itemId === item.id).map((p) => ({ id: p.id, name: p.name, nameAr: p.nameAr })) : [],
          qty: l.qty,
          unit: l.unit,
          packId: l.packId,
          yieldPct: l.yieldPct,
          note: l.note,
          qtyBase: cl?.qtyBase ?? null,
          grossBase: cl?.grossBase ?? null,
          unitCost: showCost ? (cl?.unitCost ?? null) : undefined,
          cost: showCost ? (cl?.cost ? new Decimal(cl.cost).toFixed(4) : null) : undefined,
          problem: cl?.problem ?? null,
          hasCost: l.itemId ? catalogue.get(l.itemId)?.costPerBase !== null : undefined,
        };
      }),
    };
  }

  detail(a: AccessContext, id: string, basis: CostBasis) {
    this.must(a, 'recipe:read');
    return this.db.tenant(a.tenant, (tx) => this.detailInTx(tx, a, id, basis));
  }

  /** Cost an unsaved recipe (new, or edits to `recipeId`) without saving it. Unit problems show on the lines. */
  preview(a: AccessContext, dto: Partial<RecipeInput> & { recipeId?: string | null; basis?: CostBasis }) {
    this.must(a, 'recipe:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const { recipeId, basis, ...input } = dto;
      if (recipeId) {
        const [r] = await tx.select({ id: recipes.id }).from(recipes).where(eq(recipes.id, recipeId));
        if (!r) throw new NotFoundException('recipe not found');
      }
      return this.detailInTx(tx, a, recipeId ?? '00000000-0000-4000-8000-000000000000', basis ?? 'supplier', input);
    });
  }

  /** Check the lines (items, units, packs, preps without loops) and the POS link. */
  private async validate(tx: Tx, recipeId: string | null, dto: Partial<RecipeInput>) {
    const lines = dto.lines ?? [];
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => !!x))];
    const itemRows = itemIds.length ? await tx.select().from(items).where(inArray(items.id, itemIds)) : [];
    if (itemRows.length !== itemIds.length) throw new BadRequestException('Unknown item');
    const packRows = itemIds.length ? await tx.select().from(packs).where(inArray(packs.itemId, itemIds)) : [];
    for (const l of lines.filter((x) => x.itemId)) {
      const it = itemRows.find((i) => i.id === l.itemId)!;
      const ps = packRows.filter((p) => p.itemId === it.id);
      if (l.packId && !ps.some((p) => p.id === l.packId)) throw new BadRequestException(`That pack doesn't belong to ${it.name}`);
      try {
        toBase(l.qty, l.packId ? { packId: l.packId } : { unit: l.unit ?? it.baseUnit }, {
          baseUnit: it.baseUnit,
          conversions: it.conversions,
          packs: ps.map((p) => ({ id: p.id, name: p.name, qty: p.qty, unit: p.unit ?? undefined, packId: p.parentPackId ?? undefined })),
        });
      } catch (e) {
        throw new BadRequestException(`${it.name}: ${(e as Error).message}`);
      }
    }
    const subIds = [...new Set(lines.map((l) => l.subRecipeId).filter((x): x is string => !!x))];
    if (subIds.length) {
      const subs = await tx.select({ id: recipes.id, kind: recipes.kind, name: recipes.name, isActive: recipes.isActive }).from(recipes).where(inArray(recipes.id, subIds));
      if (subs.length !== subIds.length || subs.some((s) => !s.isActive)) throw new BadRequestException('Unknown prep recipe');
      const notPrep = subs.find((s) => s.kind !== 'prep');
      if (notPrep) throw new BadRequestException(`${notPrep.name} is a menu item; only prep recipes can be used inside other recipes`);
      if (recipeId) {
        const all = await tx.select({ recipeId: recipeLines.recipeId, sub: recipeLines.subRecipeId }).from(recipeLines).where(sql`${recipeLines.subRecipeId} is not null`);
        const uses = new Map<string, string[]>();
        for (const x of all) if (x.recipeId !== recipeId) uses.set(x.recipeId, [...(uses.get(x.recipeId) ?? []), x.sub!]);
        const loop = subIds.find((s) => wouldCycle(recipeId, s, uses));
        if (loop) throw new BadRequestException(`${subs.find((s) => s.id === loop)!.name} already uses this recipe, so it can't be used here`);
      }
    }
    if (dto.posProductId) {
      const [p] = await tx.select({ id: posProducts.id }).from(posProducts).innerJoin(posConnections, eq(posConnections.id, posProducts.connectionId)).where(and(eq(posProducts.id, dto.posProductId), ne(posConnections.status, 'disconnected')));
      if (!p) throw new BadRequestException('Unknown POS product');
      const [taken] = await tx.select({ name: recipes.name }).from(recipes).where(and(eq(recipes.posProductId, dto.posProductId), eq(recipes.isActive, true), recipeId ? ne(recipes.id, recipeId) : undefined));
      if (taken) throw new ConflictException(`That POS product already has the recipe ${taken.name}`);
    }
  }

  private async writeLines(tx: Tx, orgId: string, recipeId: string, lines: RecipeInput['lines']) {
    await tx.delete(recipeLines).where(eq(recipeLines.recipeId, recipeId));
    if (!lines.length) return;
    await tx.insert(recipeLines).values(
      lines.map((l, i) => ({
        orgId,
        recipeId,
        position: i,
        itemId: l.itemId ?? null,
        subRecipeId: l.subRecipeId ?? null,
        qty: new Decimal(l.qty).toFixed(4),
        unit: l.packId ? null : (l.unit ?? null),
        packId: l.packId ?? null,
        yieldPct: new Decimal(l.yieldPct ?? 100).toFixed(2),
        note: l.note ?? null,
      })),
    );
  }

  private values(dto: Partial<RecipeInput>) {
    const v: Partial<typeof recipes.$inferInsert> = {};
    if (dto.name !== undefined) v.name = dto.name;
    if (dto.nameAr !== undefined) v.nameAr = dto.nameAr || null;
    if (dto.kind !== undefined) v.kind = dto.kind;
    if (dto.category !== undefined) v.category = dto.category || null;
    if (dto.yieldQty !== undefined) v.yieldQty = new Decimal(dto.yieldQty).toFixed(4);
    if (dto.yieldUnit !== undefined) v.yieldUnit = dto.yieldUnit;
    if (dto.sellingPrice !== undefined) v.sellingPrice = dto.sellingPrice === null ? null : new Decimal(dto.sellingPrice).toFixed(4);
    if (dto.priceIncludesVat !== undefined) v.priceIncludesVat = dto.priceIncludesVat;
    if (dto.targetCostPct !== undefined) v.targetCostPct = dto.targetCostPct === null ? null : new Decimal(dto.targetCostPct).toFixed(2);
    if (dto.posProductId !== undefined) v.posProductId = dto.posProductId ?? null;
    if (dto.notes !== undefined) v.notes = dto.notes || null;
    return v;
  }

  async createInTx(tx: Tx, a: AccessContext, dto: RecipeInput, source = 'app') {
    this.must(a, 'recipe:manage');
    await this.validate(tx, null, dto);
    const [r] = await tx.insert(recipes).values({ orgId: a.orgId, ...this.values(dto), name: dto.name, source, createdBy: a.userId }).returning();
    await this.writeLines(tx, a.orgId, r!.id, dto.lines);
    await audit(tx, a, { action: 'recipe.created', entityType: 'recipe', entityId: r!.id, after: { name: dto.name, kind: dto.kind, lines: dto.lines.length } });
    return r!;
  }

  create(a: AccessContext, dto: RecipeDto) {
    return this.db.tenant(a.tenant, async (tx) => this.detailInTx(tx, a, (await this.createInTx(tx, a, dto)).id, 'supplier'));
  }

  update(a: AccessContext, id: string, dto: UpdateRecipeDto) {
    this.must(a, 'recipe:manage');
    return this.db.tenant(a.tenant, async (tx) => {
      const [r] = await tx.select().from(recipes).where(eq(recipes.id, id)).for('update');
      if (!r) throw new NotFoundException('recipe not found');
      if (dto.kind === 'menu' && r.kind === 'prep') {
        const [used] = await tx.select({ id: recipeLines.id }).from(recipeLines).where(eq(recipeLines.subRecipeId, id)).limit(1);
        if (used) throw new ConflictException('Other recipes use this prep, so it has to stay a prep');
      }
      await this.validate(tx, id, dto);
      const before = await tx.select().from(recipeLines).where(eq(recipeLines.recipeId, id));
      const v = this.values(dto);
      if (Object.keys(v).length) await tx.update(recipes).set({ ...v, updatedAt: new Date() }).where(eq(recipes.id, id));
      if (dto.lines) await this.writeLines(tx, a.orgId, id, dto.lines);
      await audit(tx, a, {
        action: 'recipe.updated',
        entityType: 'recipe',
        entityId: id,
        before: { ...pickChanged(r, v), lines: dto.lines ? before.map(lineSummary) : undefined },
        after: { ...v, lines: dto.lines?.map((l) => ({ itemId: l.itemId ?? null, subRecipeId: l.subRecipeId ?? null, qty: l.qty, unit: l.unit ?? null, packId: l.packId ?? null, yieldPct: l.yieldPct })) },
      });
      return this.detailInTx(tx, a, id, 'supplier');
    });
  }

  remove(a: AccessContext, id: string) {
    this.must(a, 'recipe:manage');
    return this.db.tenant(a.tenant, async (tx) => {
      const [r] = await tx.select().from(recipes).where(eq(recipes.id, id));
      if (!r) throw new NotFoundException('recipe not found');
      const users = await tx.select({ name: recipes.name }).from(recipeLines).innerJoin(recipes, eq(recipes.id, recipeLines.recipeId)).where(eq(recipeLines.subRecipeId, id));
      if (users.length) throw new ConflictException(`Used in ${[...new Set(users.map((u) => u.name))].join(', ')}`);
      await tx.delete(recipes).where(eq(recipes.id, id));
      await audit(tx, a, { action: 'recipe.deleted', entityType: 'recipe', entityId: id, before: { name: r.name, kind: r.kind } });
      return { deleted: true };
    });
  }

  /**
   * Menu recipes from the recipes Foodics keeps for its products, for products that don't have
   * a Kitchain recipe yet. Ingredients must be linked to our items (Integrations → Items).
   */
  fromPos(a: AccessContext, dto: FromPosDto) {
    this.must(a, 'recipe:manage');
    return this.db.tenant(a.tenant, async (tx) => {
      const [conn] = await tx.select().from(posConnections).where(ne(posConnections.status, 'disconnected')).limit(1);
      if (!conn) throw new NotFoundException('Connect Foodics first');
      const products = await tx
        .select()
        .from(posProducts)
        .where(and(eq(posProducts.connectionId, conn.id), isNull(posProducts.deletedAt), dto.productIds?.length ? inArray(posProducts.id, dto.productIds) : undefined));
      const linked = new Set((await tx.select({ id: recipes.posProductId }).from(recipes).where(and(eq(recipes.isActive, true), sql`${recipes.posProductId} is not null`))).map((r) => r.id));
      const pItems = await tx.select().from(posItems).where(eq(posItems.connectionId, conn.id));
      const ourIds = [...new Set(pItems.map((p) => p.itemId).filter((x): x is string => !!x))];
      const ours = ourIds.length ? await tx.select({ id: items.id, name: items.name, baseUnit: items.baseUnit }).from(items).where(inArray(items.id, ourIds)) : [];
      const created: { id: string; name: string; lines: number }[] = [];
      const skipped: { productId: string; name: string; reason: string }[] = [];
      for (const p of products) {
        if (linked.has(p.id)) continue;
        const ings = p.posIngredients ?? [];
        if (!ings.length) {
          skipped.push({ productId: p.id, name: p.name, reason: 'No recipe in Foodics' });
          continue;
        }
        const lines: RecipeInput['lines'] = [];
        const problems: string[] = [];
        for (const ing of ings) {
          const pi = pItems.find((x) => x.externalId === ing.externalItemId);
          const it = pi?.itemId ? ours.find((o) => o.id === pi.itemId) : undefined;
          if (!pi || !it) {
            problems.push(`${pi?.name ?? 'an ingredient'} isn't linked to a Kitchain item`);
            continue;
          }
          const u = posUnitToBase(pi.ingredientUnit);
          if (!u || u.base !== it.baseUnit) {
            problems.push(`${pi.name}: Foodics measures it in ${pi.ingredientUnit ?? '?'}, Kitchain in ${it.baseUnit}`);
            continue;
          }
          const qty = new Decimal(ing.quantity).mul(u.factor);
          if (qty.lte(0)) continue;
          lines.push({ itemId: it.id, qty: qty.toNumber(), unit: it.baseUnit, yieldPct: 100 });
        }
        if (problems.length) {
          skipped.push({ productId: p.id, name: p.name, reason: problems.join('; ') });
          continue;
        }
        const r = await this.createInTx(tx, a, { name: p.name, nameAr: p.nameAr, kind: 'menu', category: p.category, yieldQty: 1, yieldUnit: 'each', priceIncludesVat: true, posProductId: p.id, lines }, 'foodics');
        created.push({ id: r.id, name: r.name, lines: lines.length });
      }
      return { created, skipped };
    });
  }

  /** POS products without a Kitchain recipe (for linking). */
  unlinkedProducts(a: AccessContext) {
    this.must(a, 'recipe:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const [conn] = await tx.select().from(posConnections).where(ne(posConnections.status, 'disconnected')).limit(1);
      if (!conn) return [];
      const linked = new Set((await tx.select({ id: recipes.posProductId }).from(recipes).where(and(eq(recipes.isActive, true), sql`${recipes.posProductId} is not null`))).map((r) => r.id));
      const rows = await tx.select({ id: posProducts.id, name: posProducts.name, nameAr: posProducts.nameAr, price: posProducts.price, category: posProducts.category, posIngredients: posProducts.posIngredients }).from(posProducts).where(and(eq(posProducts.connectionId, conn.id), isNull(posProducts.deletedAt))).orderBy(asc(posProducts.name));
      return rows.filter((r) => !linked.has(r.id)).map(({ posIngredients, ...r }) => ({ ...r, hasPosRecipe: (posIngredients ?? []).length > 0 }));
    });
  }
}

function lineSummary(l: LineRow) {
  return { itemId: l.itemId, subRecipeId: l.subRecipeId, qty: l.qty, unit: l.unit, packId: l.packId, yieldPct: l.yieldPct };
}
function pickChanged(r: RecipeRow, v: Partial<typeof recipes.$inferInsert>) {
  return Object.fromEntries(Object.keys(v).map((k) => [k, (r as Record<string, unknown>)[k]]));
}

@ApiTags('recipes')
@ApiBearerAuth()
@Controller('recipes')
export class RecipesController {
  constructor(private readonly svc: RecipesService) {}

  @Get() @Requires('recipe:read')
  list(@Access() a: AccessContext, @Query() q: ListDto) { return this.svc.list(a, q); }

  @Post() @Requires('recipe:manage')
  create(@Access() a: AccessContext, @Body() dto: RecipeDto) { return this.svc.create(a, dto); }

  @Post('preview') @Requires('recipe:read') @HttpCode(200)
  preview(@Access() a: AccessContext, @Body() dto: PreviewDto) { return this.svc.preview(a, dto); }

  @Get('pos-products') @Requires('recipe:read')
  unlinked(@Access() a: AccessContext) { return this.svc.unlinkedProducts(a); }

  @Post('from-pos') @Requires('recipe:manage') @HttpCode(200)
  fromPos(@Access() a: AccessContext, @Body() dto: FromPosDto) { return this.svc.fromPos(a, dto); }

  @Get(':id') @Requires('recipe:read')
  detail(@Access() a: AccessContext, @Param('id', uuid) id: string, @Query() q: BasisDto) { return this.svc.detail(a, id, q.basis); }

  @Patch(':id') @Requires('recipe:manage')
  update(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateRecipeDto) { return this.svc.update(a, id, dto); }

  @Delete(':id') @Requires('recipe:manage')
  remove(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.remove(a, id); }
}

@Module({ controllers: [RecipesController], providers: [RecipesService], exports: [RecipesService] })
export class RecipesModule {}
