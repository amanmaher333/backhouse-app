import { describe, expect, it } from 'vitest';
import { bestNameMatch, orderSalesLines, posStorageInBase, posUnitToBase, toPosStorageQty } from './pos.js';

describe('POS units', () => {
  it('reads POS unit names', () => {
    expect(posUnitToBase('Gram')).toEqual({ base: 'g', factor: 1 });
    expect(posUnitToBase('KG')).toEqual({ base: 'g', factor: 1000 });
    expect(posUnitToBase('Liter')).toEqual({ base: 'ml', factor: 1000 });
    expect(posUnitToBase('حبة')).toEqual({ base: 'each', factor: 1 });
    expect(posUnitToBase('box')).toBeNull();
  });

  it('converts our base quantity to the POS storage unit', () => {
    // Foodics: stored in KG, ingredient unit Gram, 1000 grams per KG. 12.5 kg received.
    expect(toPosStorageQty(12500, 'g', { ingredientUnit: 'Gram', storageFactor: 1000 })!.toNumber()).toBe(12.5);
    // Stored in boxes of 6 litres, ingredient unit Liter: 18 L = 3 boxes.
    expect(toPosStorageQty(18000, 'ml', { ingredientUnit: 'Liter', storageFactor: 6 })!.toNumber()).toBe(3);
    // Eggs in trays of 30 pieces.
    expect(toPosStorageQty(90, 'each', { ingredientUnit: 'Piece', storageFactor: 30 })!.toNumber()).toBe(3);
    // Grams into a POS item counted in pieces: can't convert without a manual factor.
    expect(toPosStorageQty(1000, 'g', { ingredientUnit: 'Piece', storageFactor: 1 })).toBeNull();
    expect(toPosStorageQty(1000, 'g', { ingredientUnit: 'Piece', storageFactor: 1, manualFactor: 250 })!.toNumber()).toBe(4);
    expect(posStorageInBase('g', { ingredientUnit: 'Gram', storageFactor: 1000 })!.toNumber()).toBe(1000);
  });
});

describe('POS sales', () => {
  it('counts what closed orders sold, net of returns and void lines', () => {
    const lines = orderSalesLines({
      status: 4,
      business_date: '2026-11-08',
      products: [
        { product: { id: 'burger' }, quantity: 3, returned_quantity: 1, tax_exclusive_total_price: 60, status: 3 },
        { product: { id: 'fries' }, quantity: 2, tax_exclusive_total_price: 20, status: 3 },
        { product: { id: 'burger' }, quantity: 1, tax_exclusive_total_price: 20, status: 3 },
        { product: { id: 'shake' }, quantity: 1, tax_exclusive_total_price: 15, status: 5 }, // void
      ],
      combos: [{ quantity: 1, products: [{ product: { id: 'fries' }, quantity: 1, tax_exclusive_total_price: 8 }] }],
    });
    expect(lines).toEqual([
      { productId: 'burger', qty: '3.000', net: '60.00' },
      { productId: 'fries', qty: '3.000', net: '28.00' },
    ]);
    expect(orderSalesLines({ status: 7, business_date: '2026-11-08', products: [{ product: { id: 'x' }, quantity: 1, total_price: 5 }] })).toEqual([]);
  });

  it('suggests matches by name in either language', () => {
    const sites = [{ id: 's1', name: 'Olaya', nameAr: 'العليا' }, { id: 's2', name: 'Malqa', nameAr: 'الملقا' }];
    expect(bestNameMatch('Olaya Branch', null, sites)?.item.id).toBe('s1');
    expect(bestNameMatch('Malqa Riyadh Branch', null, sites)?.item.id).toBe('s2');
    expect(bestNameMatch('فرع الملقا', null, sites)?.item.id).toBe('s2');
    expect(bestNameMatch('Hittin', null, sites)).toBeNull();
    const items = [{ id: 'tom', name: 'Tomato', nameAr: 'طماطم' }, { id: 'chk', name: 'Chicken breast', nameAr: 'صدر دجاج' }];
    expect(bestNameMatch('Tomatoes', null, items)?.item.id).toBe('tom');
    expect(bestNameMatch('Chicken Breast Fresh', null, items)?.item.id).toBe('chk');
  });
});
