import { Decimal } from 'decimal.js';
import { normalizeName } from './text.js';

/*
 * POS integration maths (Foodics first): converting our base quantities to a POS item's
 * storage unit, turning orders into product sales, and suggesting matches by name. Pure.
 */

type BaseUnit = 'g' | 'ml' | 'each';

/** A POS unit name ("Gram", "KG", "Liter", "Piece", "حبة") → our base unit and how many base units it is. */
export function posUnitToBase(unit: string | null | undefined): { base: BaseUnit; factor: number } | null {
  const u = (unit ?? '').trim().toLowerCase().replace(/\.$/, '');
  const table: Record<string, [BaseUnit, number]> = {
    g: ['g', 1], gm: ['g', 1], gr: ['g', 1], gram: ['g', 1], grams: ['g', 1], جرام: ['g', 1], غرام: ['g', 1], جم: ['g', 1],
    kg: ['g', 1000], kgs: ['g', 1000], kilo: ['g', 1000], kilogram: ['g', 1000], kilograms: ['g', 1000], كيلو: ['g', 1000], كجم: ['g', 1000],
    mg: ['g', 0.001],
    ml: ['ml', 1], milliliter: ['ml', 1], millilitre: ['ml', 1], مل: ['ml', 1],
    l: ['ml', 1000], lt: ['ml', 1000], ltr: ['ml', 1000], liter: ['ml', 1000], litre: ['ml', 1000], liters: ['ml', 1000], لتر: ['ml', 1000],
    piece: ['each', 1], pieces: ['each', 1], pc: ['each', 1], pcs: ['each', 1], each: ['each', 1], ea: ['each', 1], unit: ['each', 1], units: ['each', 1], حبة: ['each', 1], حبه: ['each', 1], قطعة: ['each', 1],
  };
  const hit = table[u];
  return hit ? { base: hit[0], factor: hit[1] } : null;
}

/**
 * How many of a POS item's storage units a quantity in our base unit is. A Foodics item says
 * e.g. ingredient unit "Gram", storage unit "KG", storage_to_ingredient_factor 1000.
 * Null when the units don't line up (then the item needs a manual factor).
 */
export function toPosStorageQty(
  baseQty: Decimal.Value,
  baseUnit: string,
  item: { ingredientUnit: string | null; storageFactor: Decimal.Value | null; manualFactor?: Decimal.Value | null },
): Decimal | null {
  // A person can say directly how many of our base units one storage unit is.
  if (item.manualFactor !== undefined && item.manualFactor !== null && new Decimal(item.manualFactor).gt(0)) return new Decimal(baseQty).div(item.manualFactor);
  const ing = posUnitToBase(item.ingredientUnit);
  if (!ing || ing.base !== baseUnit || item.storageFactor === null || new Decimal(item.storageFactor).lte(0)) return null;
  return new Decimal(baseQty).div(new Decimal(ing.factor).mul(item.storageFactor));
}

/** Our base units in one POS storage unit, when it can be worked out. */
export function posStorageInBase(baseUnit: string, item: { ingredientUnit: string | null; storageFactor: Decimal.Value | null; manualFactor?: Decimal.Value | null }): Decimal | null {
  const one = toPosStorageQty(1, baseUnit, item);
  return one && !one.isZero() ? new Decimal(1).div(one) : null;
}

export interface PosOrderLike {
  status: number;
  business_date: string;
  products?: PosOrderProduct[] | null;
  combos?: { quantity?: number | null; products?: PosOrderProduct[] | null }[] | null;
}
interface PosOrderProduct {
  product?: { id: string } | null;
  quantity?: number | null;
  returned_quantity?: number | null;
  tax_exclusive_total_price?: number | null;
  total_price?: number | null;
  status?: number | null;
}

export interface SalesLine {
  productId: string;
  qty: string;
  /** Net sales before VAT. */
  net: string;
}

/** Foodics order status "Closed"; product statuses that never sold (Void, Declined). */
const CLOSED = 4;
const UNSOLD_PRODUCT = new Set([5, 7]);

/**
 * What a POS order sold, per product: quantity net of returns and sales before VAT.
 * Only closed orders count; void and declined lines are skipped.
 */
export function orderSalesLines(order: PosOrderLike): SalesLine[] {
  if (order.status !== CLOSED) return [];
  const acc = new Map<string, { qty: Decimal; net: Decimal }>();
  const add = (p: PosOrderProduct) => {
    if (!p.product?.id || (p.status !== undefined && p.status !== null && UNSOLD_PRODUCT.has(p.status))) return;
    const qty = new Decimal(p.quantity ?? 0);
    if (qty.lte(0)) return;
    const sold = qty.minus(p.returned_quantity ?? 0);
    if (sold.lte(0)) return;
    const total = new Decimal(p.tax_exclusive_total_price ?? p.total_price ?? 0);
    const cur = acc.get(p.product.id) ?? { qty: new Decimal(0), net: new Decimal(0) };
    acc.set(p.product.id, { qty: cur.qty.plus(sold), net: cur.net.plus(total.mul(sold).div(qty)) });
  };
  for (const p of order.products ?? []) add(p);
  for (const c of order.combos ?? []) for (const p of c.products ?? []) add(p);
  return [...acc].map(([productId, v]) => ({ productId, qty: v.qty.toFixed(3), net: v.net.toFixed(2) }));
}

/** Words that say nothing about which branch or item it is. */
const FILLER = new Set(['branch', 'store', 'restaurant', 'outlet', 'location', 'kitchen', 'فرع', 'الفرع', 'مطعم', 'محل', 'fresh', 'طازج']);

/** The closest name among candidates, with a 0–1 score; null under the threshold. */
export function bestNameMatch<T extends { name: string; nameAr?: string | null }>(name: string, nameAr: string | null | undefined, candidates: T[], threshold = 0.6) {
  const tokens = (s: string | null | undefined) => new Set(normalizeName(s ?? '').split(' ').filter((t) => t.length > 1 && !FILLER.has(t)));
  const score = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let hits = 0;
    for (const t of a) if ([...b].some((u) => u === t || (Math.min(t.length, u.length) >= 4 && (t.startsWith(u) || u.startsWith(t)) && Math.abs(t.length - u.length) <= 2))) hits++;
    return (2 * hits) / (a.size + b.size);
  };
  const mine = [tokens(name), tokens(nameAr)];
  let best: { item: T; score: number } | null = null;
  for (const c of candidates) {
    const theirs = [tokens(c.name), tokens(c.nameAr)];
    const s = Math.max(score(mine[0]!, theirs[0]!), score(mine[1]!, theirs[1]!), score(mine[0]!, theirs[1]!), score(mine[1]!, theirs[0]!));
    if (!best || s > best.score) best = { item: c, score: s };
  }
  return best && best.score >= threshold ? best : null;
}
