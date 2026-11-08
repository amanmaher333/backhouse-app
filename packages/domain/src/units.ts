import { Decimal } from 'decimal.js';

/**
 * Units-of-measure engine.
 *
 * Every stockable item has a base unit in one of three dimensions (g, ml, each).
 * All ledger maths happens in base units. Conversions across dimensions
 * (e.g. 1 each egg = 55 g, 1 l oil = 920 g) are item-specific and supplied
 * via `ItemConversion`s. Packs (case → bottle → ml) nest and resolve to base.
 *
 * All arithmetic uses Decimal to avoid float drift in stock and cost maths.
 */

export type Dimension = 'mass' | 'volume' | 'count';
export type Qty = Decimal.Value;

export interface UnitDef {
  code: string;
  dimension: Dimension;
  /** How many base units (g / ml / each) one of this unit equals. */
  toBase: string;
  name: { en: string; ar: string };
}

export const BASE_UNIT: Record<Dimension, string> = { mass: 'g', volume: 'ml', count: 'each' };

export const UNITS: Record<string, UnitDef> = Object.fromEntries(
  (
    [
      ['mg', 'mass', '0.001', 'milligram', 'ملليغرام'],
      ['g', 'mass', '1', 'gram', 'غرام'],
      ['kg', 'mass', '1000', 'kilogram', 'كيلوغرام'],
      ['oz', 'mass', '28.349523125', 'ounce', 'أونصة'],
      ['lb', 'mass', '453.59237', 'pound', 'رطل'],
      ['ml', 'volume', '1', 'millilitre', 'ملليلتر'],
      ['cl', 'volume', '10', 'centilitre', 'سنتيلتر'],
      ['l', 'volume', '1000', 'litre', 'لتر'],
      ['fl_oz', 'volume', '29.5735295625', 'US fluid ounce', 'أونصة سائلة'],
      ['gal', 'volume', '3785.411784', 'US gallon', 'غالون'],
      ['each', 'count', '1', 'each', 'حبة'],
      ['dozen', 'count', '12', 'dozen', 'دزينة'],
    ] as const
  ).map(([code, dimension, toBase, en, ar]) => [code, { code, dimension, toBase, name: { en, ar } }]),
);

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitError';
  }
}

export function getUnit(code: string): UnitDef {
  const u = UNITS[code];
  if (!u) throw new UnitError(`Unknown unit "${code}"`);
  return u;
}

/** Item-specific equivalence between two dimensions, e.g. { 1 each = 55 g }. */
export interface ItemConversion {
  from: { qty: Qty; unit: string };
  to: { qty: Qty; unit: string };
}

/** Ratio kept as numerator/denominator so chained conversions stay exact. */
interface Ratio {
  num: Decimal;
  den: Decimal;
}

function dimensionGraph(conversions: ItemConversion[]): Map<Dimension, Map<Dimension, Ratio>> {
  const graph = new Map<Dimension, Map<Dimension, Ratio>>();
  const add = (a: Dimension, b: Dimension, r: Ratio) => {
    if (!graph.has(a)) graph.set(a, new Map());
    graph.get(a)!.set(b, r);
  };
  for (const c of conversions) {
    const fu = getUnit(c.from.unit);
    const tu = getUnit(c.to.unit);
    if (fu.dimension === tu.dimension) {
      throw new UnitError(`Item conversion must cross dimensions (${fu.code} → ${tu.code})`);
    }
    const fromBase = new Decimal(c.from.qty).mul(fu.toBase);
    const toBase = new Decimal(c.to.qty).mul(tu.toBase);
    if (fromBase.lte(0) || toBase.lte(0)) throw new UnitError('Item conversion quantities must be positive');
    add(fu.dimension, tu.dimension, { num: toBase, den: fromBase });
    add(tu.dimension, fu.dimension, { num: fromBase, den: toBase });
  }
  return graph;
}

function crossRatio(from: Dimension, to: Dimension, conversions: ItemConversion[]): Ratio {
  const one = { num: new Decimal(1), den: new Decimal(1) };
  if (from === to) return one;
  const graph = dimensionGraph(conversions);
  // BFS over at most 3 dimensions.
  const queue: Array<[Dimension, Ratio]> = [[from, one]];
  const seen = new Set<Dimension>([from]);
  while (queue.length) {
    const [dim, acc] = queue.shift()!;
    for (const [next, r] of graph.get(dim) ?? []) {
      if (seen.has(next)) continue;
      const nacc = { num: acc.num.mul(r.num), den: acc.den.mul(r.den) };
      if (next === to) return nacc;
      seen.add(next);
      queue.push([next, nacc]);
    }
  }
  throw new UnitError(`No conversion from ${from} to ${to} for this item`);
}

/** Convert a quantity between units, optionally across dimensions using item conversions. */
export function convert(qty: Qty, fromUnit: string, toUnit: string, conversions: ItemConversion[] = []): Decimal {
  const f = getUnit(fromUnit);
  const t = getUnit(toUnit);
  const base = new Decimal(qty).mul(f.toBase);
  const r = crossRatio(f.dimension, t.dimension, conversions);
  return base.mul(r.num).div(r.den.mul(t.toBase));
}

/** A pack contains `qty` of either a unit or another pack (by id). */
export interface PackDef {
  id: string;
  name: string;
  qty: Qty;
  unit?: string;
  packId?: string;
}

/** Resolve one pack to the item's base unit quantity, following nested packs. */
export function packToBase(
  packId: string,
  packs: PackDef[],
  baseUnit: string,
  conversions: ItemConversion[] = [],
): Decimal {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const visiting = new Set<string>();
  const resolve = (id: string): Decimal => {
    const p = byId.get(id);
    if (!p) throw new UnitError(`Unknown pack "${id}"`);
    if (visiting.has(id)) throw new UnitError(`Pack cycle detected at "${p.name}"`);
    if (new Decimal(p.qty).lte(0)) throw new UnitError(`Pack "${p.name}" must have a positive quantity`);
    if ((p.unit ? 1 : 0) + (p.packId ? 1 : 0) !== 1) {
      throw new UnitError(`Pack "${p.name}" must reference exactly one of unit or packId`);
    }
    visiting.add(id);
    const inner = p.unit ? convert(1, p.unit, baseUnit, conversions) : resolve(p.packId!);
    visiting.delete(id);
    return new Decimal(p.qty).mul(inner);
  };
  return resolve(packId);
}

/** A quantity expressed either in a unit or in a pack, converted to base. */
export function toBase(
  qty: Qty,
  of: { unit: string } | { packId: string },
  item: { baseUnit: string; packs?: PackDef[]; conversions?: ItemConversion[] },
): Decimal {
  const conv = item.conversions ?? [];
  if ('unit' in of) return convert(qty, of.unit, item.baseUnit, conv);
  return new Decimal(qty).mul(packToBase(of.packId, item.packs ?? [], item.baseUnit, conv));
}

/** Unit cost per base unit, given a price for a pack or unit. */
export function costPerBase(
  price: Qty,
  per: { unit: string } | { packId: string },
  item: { baseUnit: string; packs?: PackDef[]; conversions?: ItemConversion[] },
): Decimal {
  const base = toBase(1, per, item);
  return new Decimal(price).div(base);
}

export function isBaseUnit(code: string): boolean {
  return Object.values(BASE_UNIT).includes(code);
}
