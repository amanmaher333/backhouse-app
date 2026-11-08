import { describe, expect, it } from 'vitest';
import { addInterval, companyNameSimilarity, computeBill, decodeZatcaQr, toHalalas, zatcaQr } from './billing.js';

describe('computeBill', () => {
  it('charges the platform fee plus each agent per active site, with VAT', () => {
    const b = computeBill({ interval: 'month', activeSites: 3, agents: [{ kind: 'purchasing', name: 'Purchasing', nameAr: 'المشتريات' }, { kind: 'price_watch', name: 'Price Watch', nameAr: 'مراقب الأسعار' }] });
    expect(b.lines.map((l) => [l.code, l.quantity, l.unitPrice, l.amount])).toEqual([
      ['platform', 1, '400.00', '400.00'],
      ['agent:purchasing', 3, '350.00', '1050.00'],
      ['agent:price_watch', 3, '150.00', '450.00'],
    ]);
    expect([b.subtotal, b.vat, b.total]).toEqual(['1900.00', '285.00', '2185.00']);
    expect(b.lines[1]!.descriptionAr).toBe('وكيل المشتريات × 3 فروع (شهر واحد)');
  });
  it('bills at least one site and gives two months free on annual', () => {
    const b = computeBill({ interval: 'year', activeSites: 0, agents: [{ kind: 'price_watch', name: 'Price Watch', nameAr: 'مراقب الأسعار' }] });
    expect(b.lines.map((l) => l.amount)).toEqual(['4000.00', '1500.00']);
    expect(b.total).toBe('6325.00');
    expect(toHalalas(b.total)).toBe(632500);
  });
});

describe('addInterval', () => {
  it('adds calendar months and years, clamping month ends', () => {
    expect(addInterval(new Date('2026-01-31T10:00:00Z'), 'month').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addInterval(new Date('2026-11-08T10:00:00Z'), 'month').toISOString()).toBe('2026-12-08T10:00:00.000Z');
    expect(addInterval(new Date('2028-02-29T00:00:00Z'), 'year').toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });
});

describe('ZATCA QR', () => {
  it('encodes the five phase-1 fields as TLV, Arabic included', () => {
    const qr = zatcaQr({ sellerName: 'شركة بوه للتقنية', vatNumber: '310122393500003', timestamp: '2026-11-08T12:00:00Z', total: '2185.00', vatTotal: '285.00' });
    expect(decodeZatcaQr(qr)).toEqual(['شركة بوه للتقنية', '310122393500003', '2026-11-08T12:00:00Z', '2185.00', '285.00']);
    // Tag 1, length in UTF-8 bytes (Arabic letters are two bytes each)
    const raw = atob(qr);
    expect(raw.charCodeAt(0)).toBe(1);
    expect(raw.charCodeAt(1)).toBe(new TextEncoder().encode('شركة بوه للتقنية').length);
  });
});

describe('companyNameSimilarity', () => {
  it('matches names across legal forms, articles and spelling', () => {
    expect(companyNameSimilarity('Najd Kitchens', 'شركة مطابخ نجد ذات مسؤولية محدودة')).toBe(0); // different scripts: no match
    expect(companyNameSimilarity('مطابخ نجد', 'شركة مطابخ نجد ذات مسؤولية محدودة')).toBe(1);
    expect(companyNameSimilarity('Najd Kitchens Co.', 'NAJD KITCHENS COMPANY LLC')).toBe(1);
    expect(companyNameSimilarity('مؤسسة الوطنية للأغذية', 'الوطنيه للاغذيه')).toBe(1);
    expect(companyNameSimilarity('Najd Kitchens', 'Riyadh Bakery Trading')).toBe(0);
    expect(companyNameSimilarity('Najd Kitchens Riyadh', 'Najd Kitchens')).toBe(1);
  });
});
