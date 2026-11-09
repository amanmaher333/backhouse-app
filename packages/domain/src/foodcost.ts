import { Decimal } from 'decimal.js';
import { BASE_UNIT, convert, getUnit, toBase } from './units.js';
import type { CostingItem, RecipeDef } from './recipes.js';

/*
 * Theoretical vs actual food cost.
 *   actual      = opening + received + transferred in − transferred out − closing
 *   theoretical = Σ sales × recipe (exploded to raw items, trim loss included) + recorded waste
 *   variance    = actual − theoretical  (positive: more went than sales and waste explain)
 * Pure: the caller supplies ledger totals, sales and recipes.
 */

/**
 * Raw items used per base unit of what each recipe makes (per portion for a menu item
 * that makes 1 each), with preps exploded and trim loss included. Recipes that loop or
 * have lines that can't be converted leave those lines out (they're flagged by costing).
 */
export function recipeUsage(recipes: RecipeDef[], items: Map<string, CostingItem>): Map<string, Map<string, Decimal>> {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const done = new Map<string, Map<string, Decimal>>();
  const visiting = new Set<string>();
  const yieldBase = (r: RecipeDef) => {
    try {
      const u = getUnit(r.yieldUnit);
      return { base: BASE_UNIT[u.dimension], qty: convert(r.yieldQty, r.yieldUnit, BASE_UNIT[u.dimension]) };
    } catch {
      return null;
    }
  };
  const usage = (id: string): Map<string, Decimal> => {
    const hit = done.get(id);
    if (hit) return hit;
    const r = byId.get(id);
    if (!r || visiting.has(id)) return new Map();
    visiting.add(id);
    const batch = new Map<string, Decimal>();
    const add = (itemId: string, q: Decimal) => batch.set(itemId, (batch.get(itemId) ?? new Decimal(0)).plus(q));
    for (const l of r.lines) {
      try {
        if (l.subRecipeId) {
          const sub = byId.get(l.subRecipeId);
          const y = sub ? yieldBase(sub) : null;
          if (!sub || !y) continue;
          const qty = convert(l.qty, l.unit ?? y.base, y.base);
          for (const [itemId, per] of usage(sub.id)) add(itemId, per.mul(qty));
        } else if (l.itemId) {
          const it = items.get(l.itemId);
          if (!it) continue;
          const net = toBase(l.qty, l.packId ? { packId: l.packId } : { unit: l.unit ?? it.baseUnit }, it);
          const pct = new Decimal(l.yieldPct ?? 100);
          add(it.id, pct.gt(0) ? net.mul(100).div(pct) : net);
        }
      } catch {
        /* unit doesn't convert: left out */
      }
    }
    visiting.delete(id);
    const y = yieldBase(r);
    const per = new Map<string, Decimal>();
    if (y && y.qty.gt(0)) for (const [k, v] of batch) per.set(k, v.div(y.qty));
    done.set(id, per);
    return per;
  };
  for (const r of recipes) usage(r.id);
  return done;
}

export interface LedgerTotals {
  itemId: string;
  opening: Decimal.Value;
  received: Decimal.Value;
  transferIn: Decimal.Value;
  transferOut: Decimal.Value;
  /** Recorded waste in the period, as a positive quantity (net of voids). */
  waste: Decimal.Value;
  closing: Decimal.Value;
}

export interface SoldProduct {
  productId: string;
  name: string;
  qty: Decimal.Value;
  net: Decimal.Value;
  /** The recipe sold (menu item that makes `yield` each), or null when the product has none. */
  recipeId: string | null;
}

export interface FoodCostRow {
  itemId: string;
  name: string;
  baseUnit: string;
  unitCost: string | null;
  opening: string;
  received: string;
  transferIn: string;
  transferOut: string;
  closing: string;
  actual: string;
  sold: string;
  waste: string;
  theoretical: string;
  variance: string;
  actualValue: string | null;
  theoreticalValue: string | null;
  varianceValue: string | null;
}

export interface FoodCostReport {
  rows: FoodCostRow[];
  netSales: string;
  /** Sales of products with a recipe (theoretical cost only covers these). */
  netSalesWithRecipe: string;
  actualCost: string;
  theoreticalCost: string;
  wasteCost: string;
  varianceCost: string;
  actualPct: string | null;
  theoreticalPct: string | null;
  /** Products sold that have no recipe: their usage isn't in theoretical. */
  withoutRecipe: { productId: string; name: string; qty: string; net: string }[];
  /** Items used with no cost (values are left out for them). */
  noCost: string[];
}

const pct = (part: Decimal, whole: Decimal) => (whole.gt(0) ? part.div(whole).mul(100).toFixed(1) : null);

/** Per-item theoretical vs actual for one site and period, and the totals. */
export function foodCostReport(input: {
  items: Map<string, { name: string; baseUnit: string; unitCost: Decimal.Value | null }>;
  ledger: LedgerTotals[];
  sales: SoldProduct[];
  usage: Map<string, Map<string, Decimal>>;
}): FoodCostReport {
  const sold = new Map<string, Decimal>();
  let netSales = new Decimal(0);
  let netWithRecipe = new Decimal(0);
  const withoutRecipe: FoodCostReport['withoutRecipe'] = [];
  for (const s of input.sales) {
    netSales = netSales.plus(s.net);
    const per = s.recipeId ? input.usage.get(s.recipeId) : undefined;
    if (!per || !per.size) {
      withoutRecipe.push({ productId: s.productId, name: s.name, qty: new Decimal(s.qty).toFixed(3), net: new Decimal(s.net).toFixed(2) });
      continue;
    }
    netWithRecipe = netWithRecipe.plus(s.net);
    // Menu items make 1 each per portion, so usage per base unit is usage per portion.
    for (const [itemId, q] of per) sold.set(itemId, (sold.get(itemId) ?? new Decimal(0)).plus(q.mul(s.qty)));
  }
  const ledger = new Map(input.ledger.map((l) => [l.itemId, l]));
  const ids = new Set([...ledger.keys(), ...sold.keys()]);
  const rows: FoodCostRow[] = [];
  const noCost = new Set<string>();
  let actualCost = new Decimal(0);
  let theoreticalCost = new Decimal(0);
  let wasteCost = new Decimal(0);
  for (const id of ids) {
    const it = input.items.get(id);
    if (!it) continue;
    const l = ledger.get(id);
    const z = new Decimal(0);
    const opening = new Decimal(l?.opening ?? z);
    const received = new Decimal(l?.received ?? z);
    const tin = new Decimal(l?.transferIn ?? z);
    const tout = new Decimal(l?.transferOut ?? z);
    const closing = new Decimal(l?.closing ?? z);
    const waste = new Decimal(l?.waste ?? z);
    const actual = opening.plus(received).plus(tin).minus(tout).minus(closing);
    const s = sold.get(id) ?? z;
    const theoretical = s.plus(waste);
    const variance = actual.minus(theoretical);
    if (actual.isZero() && theoretical.isZero()) continue;
    const cost = it.unitCost !== null && it.unitCost !== undefined ? new Decimal(it.unitCost) : null;
    if (!cost) noCost.add(it.name);
    if (cost) {
      actualCost = actualCost.plus(actual.mul(cost));
      theoreticalCost = theoreticalCost.plus(theoretical.mul(cost));
      wasteCost = wasteCost.plus(waste.mul(cost));
    }
    rows.push({
      itemId: id,
      name: it.name,
      baseUnit: it.baseUnit,
      unitCost: cost ? cost.toFixed(8) : null,
      opening: opening.toFixed(3),
      received: received.toFixed(3),
      transferIn: tin.toFixed(3),
      transferOut: tout.toFixed(3),
      closing: closing.toFixed(3),
      actual: actual.toFixed(3),
      sold: s.toFixed(3),
      waste: waste.toFixed(3),
      theoretical: theoretical.toFixed(3),
      variance: variance.toFixed(3),
      actualValue: cost ? actual.mul(cost).toFixed(2) : null,
      theoreticalValue: cost ? theoretical.mul(cost).toFixed(2) : null,
      varianceValue: cost ? variance.mul(cost).toFixed(2) : null,
    });
  }
  // Biggest losses first.
  rows.sort((a, b) => new Decimal(b.varianceValue ?? 0).cmp(a.varianceValue ?? 0));
  return {
    rows,
    netSales: netSales.toFixed(2),
    netSalesWithRecipe: netWithRecipe.toFixed(2),
    actualCost: actualCost.toFixed(2),
    theoreticalCost: theoreticalCost.toFixed(2),
    wasteCost: wasteCost.toFixed(2),
    varianceCost: actualCost.minus(theoreticalCost).toFixed(2),
    actualPct: pct(actualCost, netSales),
    theoreticalPct: pct(theoreticalCost, netSales),
    withoutRecipe: withoutRecipe.sort((a, b) => new Decimal(b.net).cmp(a.net)),
    noCost: [...noCost],
  };
}
