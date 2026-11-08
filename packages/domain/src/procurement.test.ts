import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, localParts, nextDeliveryDate } from './delivery.js';
import { applyMovement, orderTotals, packsToOrder } from './stock.js';

const RIYADH = 'Asia/Riyadh'; // UTC+3, no daylight saving

describe('delivery dates', () => {
  // 2026-11-08 is a Sunday.
  const sundayMorning = new Date('2026-11-08T06:00:00Z'); // 09:00 Riyadh
  const sundayEvening = new Date('2026-11-08T15:00:00Z'); // 18:00 Riyadh

  it('reads local time in Riyadh', () => {
    expect(localParts(sundayMorning, RIYADH)).toEqual({ date: '2026-11-08', weekday: 0, minutes: 540 });
    expect(localParts(new Date('2026-11-08T22:30:00Z'), RIYADH).date).toBe('2026-11-09'); // after local midnight
  });

  it('uses the next delivery day after the lead time', () => {
    // Delivers Sun/Tue/Thu, lead time 1 day, ordered Sunday before cut-off → Tuesday
    expect(nextDeliveryDate(sundayMorning, RIYADH, { deliveryDays: [0, 2, 4], cutoffTime: '16:00', leadTimeDays: 1 })).toBe('2026-11-10');
  });

  it('moves to the next day after the cut-off', () => {
    // Same schedule ordered after 16:00 → counts from Monday → earliest Tuesday... lead 1 → Tuesday
    expect(nextDeliveryDate(sundayEvening, RIYADH, { deliveryDays: [0, 2, 4], cutoffTime: '16:00', leadTimeDays: 1 })).toBe('2026-11-10');
    // Lead time 2 after cut-off → earliest Wednesday → Thursday
    expect(nextDeliveryDate(sundayEvening, RIYADH, { deliveryDays: [0, 2, 4], cutoffTime: '16:00', leadTimeDays: 2 })).toBe('2026-11-12');
  });

  it('allows any day when no delivery days are set', () => {
    expect(nextDeliveryDate(sundayMorning, RIYADH, { deliveryDays: [], leadTimeDays: 1 })).toBe('2026-11-09');
  });

  it('does date arithmetic', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-11-08', '2026-11-10')).toBe(2);
  });
});

describe('stock maths', () => {
  it('blends incoming cost into the weighted average', () => {
    const r = applyMovement({ qty: 10000, avgCost: '0.0045' }, { qty: 10000, unitCost: '0.0054' });
    expect(r.qty.toString()).toBe('20000');
    expect(r.avgCost.toString()).toBe('0.00495');
  });

  it('keeps the average for outgoing stock and resets it from zero', () => {
    expect(applyMovement({ qty: 5000, avgCost: '0.005' }, { qty: -2000 }).avgCost.toString()).toBe('0.005');
    expect(applyMovement({ qty: -100, avgCost: '0.005' }, { qty: 1000, unitCost: '0.006' }).avgCost.toString()).toBe('0.006');
  });

  it('computes packs to order and order totals with VAT', () => {
    expect(packsToOrder({ par: 20000, onHand: 6500, onOrder: 2000, packBaseQty: 5000 })).toBe(3);
    expect(packsToOrder({ par: 20000, onHand: 21000, onOrder: 0, packBaseQty: 5000 })).toBe(0);
    expect(orderTotals([{ qty: 3, unitPrice: '24.75' }, { qty: 2, unitPrice: '5.4' }], '0.15')).toEqual({
      lineTotals: ['74.25', '10.80'],
      subtotal: '85.05',
      tax: '12.76',
      total: '97.81',
    });
  });
});
