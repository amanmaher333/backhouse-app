import { Decimal } from 'decimal.js';

/**
 * Weighted average cost. Incoming stock with a cost blends into the average;
 * outgoing stock (or incoming without a cost) leaves the average unchanged.
 * When stock on hand is zero or negative, the incoming cost becomes the average.
 */
export function applyMovement(
  balance: { qty: Decimal.Value; avgCost: Decimal.Value },
  movement: { qty: Decimal.Value; unitCost?: Decimal.Value | null },
): { qty: Decimal; avgCost: Decimal } {
  const qty = new Decimal(balance.qty);
  const avg = new Decimal(balance.avgCost);
  const inQty = new Decimal(movement.qty);
  const newQty = qty.plus(inQty);
  if (inQty.lte(0) || movement.unitCost === null || movement.unitCost === undefined) return { qty: newQty, avgCost: avg };
  const cost = new Decimal(movement.unitCost);
  if (qty.lte(0)) return { qty: newQty, avgCost: cost };
  return { qty: newQty, avgCost: qty.mul(avg).plus(inQty.mul(cost)).div(newQty) };
}

/**
 * How many packs to order to bring stock back to par.
 * need = par − on hand − already on order; rounded up to whole packs.
 */
export function packsToOrder(params: { par: Decimal.Value; onHand: Decimal.Value; onOrder: Decimal.Value; packBaseQty: Decimal.Value }): number {
  const need = new Decimal(params.par).minus(params.onHand).minus(params.onOrder);
  if (need.lte(0)) return 0;
  return need.div(params.packBaseQty).ceil().toNumber();
}

/** Totals for order lines with a VAT rate. Money rounded to 2 decimals (halalas). */
export function orderTotals(lines: { qty: Decimal.Value; unitPrice: Decimal.Value }[], taxRate: Decimal.Value) {
  const lineTotals = lines.map((l) => new Decimal(l.qty).mul(l.unitPrice).toDecimalPlaces(2));
  const subtotal = lineTotals.reduce((a, b) => a.plus(b), new Decimal(0));
  const tax = subtotal.mul(taxRate).toDecimalPlaces(2);
  return { lineTotals: lineTotals.map((d) => d.toFixed(2)), subtotal: subtotal.toFixed(2), tax: tax.toFixed(2), total: subtotal.plus(tax).toFixed(2) };
}
