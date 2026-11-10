import { describe, expect, it } from 'vitest';
import { monthlyReportDue, monthlySavingsLines, monthRange, openClaim, savingsMultiple, savingsNothingToReport, summariseSavings, switchSaving } from './savings.js';

describe('savings', () => {
  it('values a supplier switch at the price gap on what was actually bought', () => {
    // Paid 900 at the new supplier, which was 10% cheaper: the old supplier would have charged 1000.
    expect(switchSaving('900', 10)).toBe('100.00');
    expect(switchSaving('1000', 0)).toBe('0.00');
    expect(switchSaving('1000', -5)).toBe('0.00');
    expect(switchSaving('1000', 100)).toBe('0.00');
  });

  it('keeps open claims separate from money saved', () => {
    const t = summariseSavings([
      { kind: 'credit_note', amount: '28.75' },
      { kind: 'credit_note', amount: '100' },
      { kind: 'duplicate', amount: '1150' },
      { kind: 'supplier_switch', amount: '100.004' },
      { kind: 'claim_open', amount: '81' },
      { kind: 'credit_note', amount: '0' },
    ]);
    expect(t.saved).toBe('1378.75');
    expect(t.inProgress).toBe('81.00');
    expect(t.byKind.credit_note).toEqual({ amount: '128.75', count: 2 });
    expect(t.byKind.claim_open).toEqual({ amount: '81.00', count: 1 });
  });

  it('nets credit notes off a claim, never below zero', () => {
    expect(openClaim('81', '30')).toBe('51.00');
    expect(openClaim('81', '100')).toBe('0.00');
  });

  it('compares savings with the cost only when there is a cost', () => {
    expect(savingsMultiple('2300', '460')).toBe(5);
    expect(savingsMultiple('100', '460')).toBe(0.2);
    expect(savingsMultiple('100', '0')).toBeNull();
    expect(savingsMultiple('100', null)).toBeNull();
  });

  it('works out calendar months', () => {
    expect(monthRange('2026-11-09')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange('2026-11-09', -1)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthRange('2026-01-15', -1)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(monthRange('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
});

describe('monthly savings report', () => {
  it('is due from the chosen hour on the 1st, with catch-up on the 2nd and 3rd', () => {
    // 08:00 in Riyadh is 05:00 UTC.
    expect(monthlyReportDue(new Date('2026-12-01T04:59:00Z'), 'Asia/Riyadh', 8)).toEqual({ due: false, period: '2026-11', from: '2026-11-01', to: '2026-11-30' });
    expect(monthlyReportDue(new Date('2026-12-01T05:00:00Z'), 'Asia/Riyadh', 8).due).toBe(true);
    expect(monthlyReportDue(new Date('2026-12-03T20:00:00Z'), 'Asia/Riyadh', 8).due).toBe(true);
    expect(monthlyReportDue(new Date('2026-12-03T21:00:00Z'), 'Asia/Riyadh', 8).due).toBe(false); // already the 4th in Riyadh
    // New year: December is reported in January.
    expect(monthlyReportDue(new Date('2027-01-01T09:00:00Z'), 'Asia/Riyadh', 8)).toMatchObject({ due: true, period: '2026-12', from: '2026-12-01', to: '2026-12-31' });
  });

  it('lists only kinds with money, then open claims', () => {
    const t = summariseSavings([{ kind: 'credit_note', amount: '115' }, { kind: 'supplier_switch', amount: '71.92' }, { kind: 'claim_open', amount: '60.38' }]);
    const money = (a: string) => `SAR ${a}`;
    expect(monthlySavingsLines(t, 'en', money)).toEqual(['Credit notes received: SAR 115.00', 'Cheaper suppliers: SAR 71.92', 'Still being claimed: SAR 60.38']);
    expect(monthlySavingsLines(t, 'ar', money)[2]).toBe('قيد المطالبة: SAR 60.38');
    expect(savingsNothingToReport(t)).toBe(false);
    expect(savingsNothingToReport(summariseSavings([]))).toBe(true);
    expect(savingsNothingToReport(summariseSavings([{ kind: 'claim_open', amount: '5' }]))).toBe(false);
  });
});
