import { Decimal } from 'decimal.js';
import { BASE_UNIT, convert, getUnit, toBase, type ItemConversion, type PackDef } from './units.js';

/*
 * Recipe costing. A recipe is a menu item (sold, usually one portion) or a prep (a batch that
 * other recipes use, e.g. 2 kg of tomato sauce). Lines use items (with trim/yield loss) or other
 * preps. Pure: the caller supplies item costs per base unit.
 */

export type RecipeKind = 'menu' | 'prep';

export interface CostingItem {
  id: string;
  name: string;
  baseUnit: string;
  packs?: PackDef[];
  conversions?: ItemConversion[];
  /** Cost per base unit (g, ml or each); null when unknown. */
  costPerBase: Decimal.Value | null;
  allergens?: string[];
}

export interface RecipeLineDef {
  id?: string;
  itemId?: string | null;
  subRecipeId?: string | null;
  qty: Decimal.Value;
  /** A unit (g, kg, ml, each, tbsp…) or one of the item's packs. */
  unit?: string | null;
  packId?: string | null;
  /** Usable share after trimming/peeling, in percent (100 = no loss). Items only. */
  yieldPct?: Decimal.Value | null;
}

export interface RecipeDef {
  id: string;
  name: string;
  kind: RecipeKind;
  /** What the recipe makes: 1 each (a portion) for menu items; e.g. 2 kg for a prep. */
  yieldQty: Decimal.Value;
  yieldUnit: string;
  lines: RecipeLineDef[];
}

export interface CostedLine {
  id?: string;
  itemId: string | null;
  subRecipeId: string | null;
  name: string;
  /** Net quantity in the ingredient's base unit (or the prep's yield base unit). */
  qtyBase: string | null;
  /** Gross quantity bought: net ÷ yield. */
  grossBase: string | null;
  baseUnit: string | null;
  unitCost: string | null;
  cost: string | null;
  problem: 'no_cost' | 'bad_unit' | 'missing' | 'cycle' | null;
}

export interface RecipeCost {
  id: string;
  /** Total cost of one batch (of yieldQty). Null parts are left out and listed in `missing`. */
  total: string;
  /** Cost per base unit of what it makes (per g / ml / each). */
  perBase: string | null;
  /** The base unit of what it makes. */
  yieldBaseUnit: string | null;
  yieldBase: string | null;
  lines: CostedLine[];
  allergens: string[];
  /** Ingredients without a cost or with a unit that doesn't convert, so the total is too low. */
  missing: string[];
  cycle: boolean;
}

/** Cost every recipe. Sub-recipes are costed first; a recipe that uses itself (directly or not) is flagged. */
export function costRecipes(recipes: RecipeDef[], items: Map<string, CostingItem>): Map<string, RecipeCost> {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const done = new Map<string, RecipeCost>();
  const visiting = new Set<string>();

  const yieldOf = (r: RecipeDef) => {
    try {
      const u = getUnit(r.yieldUnit);
      const base = BASE_UNIT[u.dimension];
      return { base, qty: convert(r.yieldQty, r.yieldUnit, base) };
    } catch {
      return null;
    }
  };

  const cost = (id: string): RecipeCost => {
    const hit = done.get(id);
    if (hit) return hit;
    const r = byId.get(id)!;
    if (visiting.has(id)) return { id, total: '0', perBase: null, yieldBaseUnit: null, yieldBase: null, lines: [], allergens: [], missing: [r.name], cycle: true };
    visiting.add(id);
    let total = new Decimal(0);
    const missing: string[] = [];
    const allergens = new Set<string>();
    let cycle = false;
    const lines: CostedLine[] = r.lines.map((l) => {
      const base = { id: l.id, itemId: l.itemId ?? null, subRecipeId: l.subRecipeId ?? null };
      if (l.subRecipeId) {
        const sub = byId.get(l.subRecipeId);
        if (!sub) return { ...base, name: '?', qtyBase: null, grossBase: null, baseUnit: null, unitCost: null, cost: null, problem: 'missing' };
        const sc = cost(sub.id);
        const y = yieldOf(sub);
        if (sc.cycle) {
          cycle = true;
          return { ...base, name: sub.name, qtyBase: null, grossBase: null, baseUnit: y?.base ?? null, unitCost: null, cost: null, problem: 'cycle' };
        }
        sc.allergens.forEach((a) => allergens.add(a));
        sc.missing.forEach((m) => missing.push(m));
        let qty: Decimal;
        try {
          qty = convert(l.qty, l.unit ?? y!.base, y!.base);
        } catch {
          missing.push(sub.name);
          return { ...base, name: sub.name, qtyBase: null, grossBase: null, baseUnit: y?.base ?? null, unitCost: null, cost: null, problem: 'bad_unit' };
        }
        if (sc.perBase === null) {
          missing.push(sub.name);
          return { ...base, name: sub.name, qtyBase: qty.toFixed(6), grossBase: qty.toFixed(6), baseUnit: y!.base, unitCost: null, cost: null, problem: 'no_cost' };
        }
        const c = qty.mul(sc.perBase);
        total = total.plus(c);
        return { ...base, name: sub.name, qtyBase: qty.toFixed(6), grossBase: qty.toFixed(6), baseUnit: y!.base, unitCost: new Decimal(sc.perBase).toFixed(8), cost: c.toFixed(4), problem: null };
      }
      const it = l.itemId ? items.get(l.itemId) : undefined;
      if (!it) return { ...base, name: '?', qtyBase: null, grossBase: null, baseUnit: null, unitCost: null, cost: null, problem: 'missing' };
      (it.allergens ?? []).forEach((a) => allergens.add(a));
      let net: Decimal;
      try {
        net = toBase(l.qty, l.packId ? { packId: l.packId } : { unit: l.unit ?? it.baseUnit }, it);
      } catch {
        missing.push(it.name);
        return { ...base, name: it.name, qtyBase: null, grossBase: null, baseUnit: it.baseUnit, unitCost: null, cost: null, problem: 'bad_unit' };
      }
      const yieldPct = new Decimal(l.yieldPct ?? 100);
      const gross = yieldPct.gt(0) ? net.mul(100).div(yieldPct) : net;
      if (it.costPerBase === null || it.costPerBase === undefined) {
        missing.push(it.name);
        return { ...base, name: it.name, qtyBase: net.toFixed(6), grossBase: gross.toFixed(6), baseUnit: it.baseUnit, unitCost: null, cost: null, problem: 'no_cost' };
      }
      const c = gross.mul(it.costPerBase);
      total = total.plus(c);
      return { ...base, name: it.name, qtyBase: net.toFixed(6), grossBase: gross.toFixed(6), baseUnit: it.baseUnit, unitCost: new Decimal(it.costPerBase).toFixed(8), cost: c.toFixed(4), problem: null };
    });
    visiting.delete(id);
    const y = yieldOf(r);
    const perBase = y && y.qty.gt(0) && !cycle ? total.div(y.qty) : null;
    const out: RecipeCost = {
      id,
      total: total.toFixed(4),
      perBase: perBase ? perBase.toFixed(8) : null,
      yieldBaseUnit: y?.base ?? null,
      yieldBase: y ? y.qty.toFixed(6) : null,
      lines,
      allergens: [...allergens].sort(),
      missing: [...new Set(missing)],
      cycle,
    };
    done.set(id, out);
    return out;
  };

  for (const r of recipes) cost(r.id);
  return done;
}

/** Would adding `subRecipeId` to `recipeId` make a recipe use itself? */
export function wouldCycle(recipeId: string, subRecipeId: string, uses: Map<string, string[]>): boolean {
  const stack = [subRecipeId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === recipeId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(uses.get(id) ?? []));
  }
  return false;
}

/** Selling price before VAT. */
export function priceExVat(price: Decimal.Value, includesVat: boolean, vatRate: Decimal.Value): Decimal {
  return includesVat ? new Decimal(price).div(new Decimal(1).plus(vatRate)) : new Decimal(price);
}

/** Food cost as a percent of the price before VAT, or null without a price. */
export function foodCostPct(cost: Decimal.Value, priceBeforeVat: Decimal.Value | null): string | null {
  if (priceBeforeVat === null || new Decimal(priceBeforeVat).lte(0)) return null;
  return new Decimal(cost).div(priceBeforeVat).mul(100).toFixed(1);
}
