import { describe, expect, it } from 'vitest';
import { addInterval, companyNameSimilarity, computeBill, decodeZatcaQr, pricingActive, toHalalas, trialReminderDue, zatcaQr } from './billing.js';

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
    const qr = zatcaQr({ sellerName: 'شركة كيتشين للتقنية', vatNumber: '310122393500003', timestamp: '2026-11-08T12:00:00Z', total: '2185.00', vatTotal: '285.00' });
    expect(decodeZatcaQr(qr)).toEqual(['شركة كيتشين للتقنية', '310122393500003', '2026-11-08T12:00:00Z', '2185.00', '285.00']);
    // Tag 1, length in UTF-8 bytes (Arabic letters are two bytes each)
    const raw = atob(qr);
    expect(raw.charCodeAt(0)).toBe(1);
    expect(raw.charCodeAt(1)).toBe(new TextEncoder().encode('شركة كيتشين للتقنية').length);
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

describe('trial reminder', () => {
  const end = new Date('2026-12-10T09:00:00Z'); // 12:00 in Riyadh
  it('is due in the last three days, from the chosen hour, and any time on the last day', () => {
    expect(trialReminderDue(new Date('2026-12-07T08:59:00Z'), end, 'Asia/Riyadh', 8)).toBe(false); // more than 3 days left
    expect(trialReminderDue(new Date('2026-12-07T09:30:00Z'), end, 'Asia/Riyadh', 13)).toBe(false); // 12:30 local, before 13:00
    expect(trialReminderDue(new Date('2026-12-07T10:00:00Z'), end, 'Asia/Riyadh', 13)).toBe(true); // 13:00 local
    expect(trialReminderDue(new Date('2026-12-09T22:00:00Z'), end, 'Asia/Riyadh', 8)).toBe(true); // 01:00 local, last day
    expect(trialReminderDue(new Date('2026-12-10T09:00:00Z'), end, 'Asia/Riyadh', 8)).toBe(false); // ended
  });
});

describe('custom pricing', () => {
  const agents = [{ kind: 'price_watch', name: 'Price Watch', nameAr: 'مراقب الأسعار' }, { kind: 'purchasing', name: 'Purchasing', nameAr: 'المشتريات' }];
  it('uses agreed prices and shows the discount as its own line', () => {
    // List: 400 + 150×2 + 350×2 = 1400. Agreed: platform 200, Purchasing 300/site → 200 + 300 + 600 = 1100; 20% off → 880.
    const b = computeBill({ interval: 'month', activeSites: 2, agents, asOf: '2026-12-01', pricing: { label: 'Design partner', labelAr: 'شريك تصميم', platformFee: '200.00', agentFees: { purchasing: '300.00' }, discountPct: 20 } });
    expect(b.lines.map((l) => [l.code, l.amount])).toEqual([['platform', '200.00'], ['agent:price_watch', '300.00'], ['agent:purchasing', '600.00'], ['discount', '-220.00']]);
    expect(b.lines.at(-1)).toMatchObject({ description: 'Design partner discount (20%)', descriptionAr: 'خصم شريك تصميم (20٪)' });
    expect(b).toMatchObject({ subtotal: '880.00', vat: '132.00', total: '1012.00' });
  });

  it('applies to annual bills, and stops after its end date', () => {
    const pricing = { label: 'Pilot', discountPct: 50, until: '2027-03-31' };
    const year = computeBill({ interval: 'year', activeSites: 1, agents: [], asOf: '2027-03-31', pricing });
    expect(year).toMatchObject({ subtotal: '2000.00' }); // 400 × 10 months, half off
    const after = computeBill({ interval: 'month', activeSites: 1, agents: [], asOf: '2027-04-01', pricing });
    expect(after.lines.map((l) => l.code)).toEqual(['platform']);
    expect(after.subtotal).toBe('400.00');
    expect(pricingActive(pricing, '2027-03-31')).toBe(true);
    expect(pricingActive(pricing, '2027-04-01')).toBe(false);
    expect(pricingActive(null, '2027-01-01')).toBe(false);
  });

  it('can make the plan free', () => {
    const b = computeBill({ interval: 'month', activeSites: 1, agents, asOf: '2026-12-01', pricing: { label: 'Founding partner', discountPct: 100 } });
    expect(b).toMatchObject({ subtotal: '0.00', vat: '0.00', total: '0.00' });
  });
});
