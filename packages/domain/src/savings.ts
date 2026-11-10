import { Decimal } from 'decimal.js';

/**
 * What Backhouse saved an organisation, from records only (never estimates of things that didn't happen).
 *
 * - credit_note: a supplier credit note received against an invoice Backhouse disputed.
 * - duplicate: an invoice rejected because it repeated one already received.
 * - supplier_switch: deliveries from a cheaper supplier after Price Watch switched to it, valued at the
 *   price gap at the time of the switch.
 * - claim_open: overcharges disputed but not yet credited. In progress, not counted as saved.
 */
export type SavingKind = 'credit_note' | 'duplicate' | 'supplier_switch' | 'claim_open';
export const SAVED_KINDS: SavingKind[] = ['credit_note', 'duplicate', 'supplier_switch'];

export interface SavingEntry {
  kind: SavingKind;
  amount: string;
}

export interface SavingsTotals {
  saved: string;
  inProgress: string;
  byKind: Record<SavingKind, { amount: string; count: number }>;
}

const m2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export function summariseSavings(entries: SavingEntry[]): SavingsTotals {
  const byKind = Object.fromEntries((['credit_note', 'duplicate', 'supplier_switch', 'claim_open'] as SavingKind[]).map((k) => [k, { sum: new Decimal(0), count: 0 }])) as Record<SavingKind, { sum: Decimal; count: number }>;
  for (const e of entries) {
    const amt = new Decimal(e.amount || 0);
    if (amt.lte(0)) continue;
    byKind[e.kind].sum = byKind[e.kind].sum.plus(amt);
    byKind[e.kind].count++;
  }
  const saved = SAVED_KINDS.reduce((s, k) => s.plus(byKind[k].sum), new Decimal(0));
  return {
    saved: m2(saved),
    inProgress: m2(byKind.claim_open.sum),
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { amount: m2(v.sum), count: v.count }])) as SavingsTotals['byKind'],
  };
}

/**
 * Saving on a delivery from the supplier switched to: what the same quantity would have cost at the old
 * supplier's price at the time of the switch. With p the saving % (old − new) / old and `spend` what was
 * paid the new supplier, the old price would have been spend / (1 − p), so the saving is spend × p / (1 − p).
 */
export function switchSaving(spend: Decimal.Value, savingPct: number): string {
  if (!(savingPct > 0) || savingPct >= 100) return '0.00';
  const p = new Decimal(savingPct).div(100);
  return m2(new Decimal(spend).mul(p).div(new Decimal(1).minus(p)));
}

/** A disputed invoice's claim still open: the claim less credit notes already received against it (never negative). */
export function openClaim(claimTotal: Decimal.Value, credited: Decimal.Value): string {
  const left = new Decimal(claimTotal || 0).minus(credited || 0);
  return m2(Decimal.max(left, 0));
}

/** How many times savings cover the cost (one decimal), or null when there's no cost to compare. */
export function savingsMultiple(saved: Decimal.Value, cost: Decimal.Value | null | undefined): number | null {
  if (cost === null || cost === undefined || new Decimal(cost).lte(0)) return null;
  return new Decimal(saved).div(cost).toDecimalPlaces(1, Decimal.ROUND_DOWN).toNumber();
}

/** Calendar month [from, to] (YYYY-MM-DD) containing `date`, shifted by `offset` months. */
export function monthRange(date: string, offset = 0): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(first), to: iso(last) };
}
