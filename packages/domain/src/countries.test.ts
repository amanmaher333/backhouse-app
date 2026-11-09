import { describe, expect, it } from 'vitest';
import { COUNTRIES, country, formatMoney, isValidTimeZone, validCrNumber, validVatNumber, zonedTimeToUtc } from './countries.js';
import { normalizePhone } from './channels.js';
import { matchInvoice } from './invoices.js';

describe('country profiles', () => {
  it('cover the Gulf, Egypt and Jordan, with valid time zones', () => {
    expect(Object.keys(COUNTRIES).sort()).toEqual(['AE', 'BH', 'EG', 'JO', 'KW', 'OM', 'QA', 'SA']);
    for (const p of Object.values(COUNTRIES)) expect(isValidTimeZone(p.timezone)).toBe(true);
    expect(country('ae')).toMatchObject({ currency: 'AED', vatRate: '0.05', timezone: 'Asia/Dubai' });
    expect(country('KW').vatRate).toBe('0');
    expect(country('ZZ').code).toBe('SA'); // unknown: Saudi defaults
  });

  it('formats money in each currency, Latin digits in both languages', () => {
    expect(formatMoney('12.5', 'SAR')).toBe('SAR 12.50');
    expect(formatMoney('12.5', 'SAR', 'ar')).toBe('12.50 ر.س');
    expect(formatMoney(99, 'AED', 'ar')).toBe('99.00 د.إ');
    expect(formatMoney(3, 'EGP')).toBe('EGP 3.00');
    expect(formatMoney(1, 'USD', 'ar')).toBe('1.00 USD');
  });

  it('checks tax and company numbers by country', () => {
    expect(validVatNumber('SA', '310122393500003')).toBe(true);
    expect(validVatNumber('SA', '100123456789012')).toBe(false);
    expect(validVatNumber('AE', '100123456789012')).toBe(true);
    expect(validVatNumber('OM', 'OM1100012345')).toBe(true);
    expect(validVatNumber('EG', '123456789')).toBe(true);
    expect(validCrNumber('SA', '1010123456')).toBe(true);
    expect(validCrNumber('SA', 'CN-1234')).toBe(false);
    expect(validCrNumber('AE', 'CN-1234567')).toBe(true);
  });

  it('reads local phone numbers for the organisation’s country', () => {
    expect(normalizePhone('0501234567')).toBe('+966501234567');
    expect(normalizePhone('050 123 4567', 'AE')).toBe('+971501234567');
    expect(normalizePhone('36123456', 'BH')).toBe('+97336123456');
    expect(normalizePhone('01012345678', 'EG')).toBe('+201012345678');
    expect(normalizePhone('0791234567', 'JO')).toBe('+962791234567');
    expect(normalizePhone('+97455123456')).toBe('+97455123456');
    expect(normalizePhone('+966123')).toBeNull();
  });

  it('finds the UTC instant of a local time in any zone', () => {
    expect(zonedTimeToUtc('2026-11-01', '00:00', 'Asia/Riyadh').toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(zonedTimeToUtc('2026-11-01', '00:00', 'Asia/Dubai').toISOString()).toBe('2026-10-31T20:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-01', '00:00', 'Africa/Cairo').toISOString()).toBe('2026-06-30T21:00:00.000Z'); // summer time (UTC+3)
    expect(zonedTimeToUtc('2026-01-01', '00:00', 'Africa/Cairo').toISOString()).toBe('2025-12-31T22:00:00.000Z');
  });

  it('writes invoice differences in the invoice’s currency', () => {
    const lines = [{ description: 'Fee', qty: 1, unitPrice: 25, lineTotal: '25.00' }];
    const r = matchInvoice({ type: 'invoice', lines, subtotal: '25', taxTotal: '1.25', total: '26.25', currency: 'AED', expectedTaxRate: '0.05', po: { lines: [], taxRate: '0.05' } });
    const d = r.discrepancies.find((x) => x.kind === 'not_on_order')!;
    expect(d.message).toContain('AED 25.00');
    expect(d.messageAr).toContain('25.00 د.إ');
    expect(r.claim).toEqual({ subtotal: '25.00', tax: '1.25', total: '26.25' });
  });
});
