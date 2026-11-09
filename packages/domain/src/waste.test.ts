import { describe, expect, it } from 'vitest';
import { parseWasteText, takeReason } from './waste.js';
import type { CountableItem } from './counts.js';

const ITEMS: CountableItem[] = [
  { id: 'tom', name: 'Tomato', nameAr: 'طماطم', baseUnit: 'g', packs: [{ id: 'tom-ctn', name: 'Carton 6 kg', nameAr: 'كرتون 6 كجم' }] },
  { id: 'milk', name: 'Fresh milk', nameAr: 'حليب طازج', baseUnit: 'ml', packs: [{ id: 'milk-2l', name: 'Bottle 2 L', nameAr: 'قارورة 2 لتر' }] },
  { id: 'egg', name: 'Eggs', nameAr: 'بيض', baseUnit: 'each', packs: [{ id: 'egg-tray', name: 'Tray of 30', nameAr: 'طبق 30' }] },
  { id: 'rice', name: 'Cooked rice', nameAr: 'رز مطبوخ', baseUnit: 'g', packs: [] },
];

describe('waste text', () => {
  it('finds the reason and leaves the rest for the item', () => {
    expect(takeReason('tomatoes 2 kg spoiled')).toEqual({ reason: 'spoiled', rest: 'tomatoes 2 kg' });
    expect(takeReason('milk out of date 4 l').reason).toBe('expired');
    expect(takeReason('حليب ٢ لتر منتهي الصلاحية')).toMatchObject({ reason: 'expired', rest: 'حليب ٢ لتر' });
    expect(takeReason('Tomato 3 kg').reason).toBeNull();
    // "off" only as a word, not inside "coffee".
    expect(takeReason('coffee 2 kg').reason).toBeNull();
  });

  it('reads a whole message, in Arabic and English', () => {
    const r = parseWasteText('طماطم ٢ كيلو تالف، eggs 12 broken, rice 3 kg leftover', ITEMS);
    expect(r.map((e) => [e.itemId, e.qty, e.unit ?? e.packId, e.reason])).toEqual([
      ['tom', '2', 'kg', 'spoiled'],
      ['egg', '12', 'each', 'damaged'],
      ['rice', '3', 'kg', 'overproduction'],
    ]);
  });

  it('applies a reason given once for the message', () => {
    const r = parseWasteText('expired: milk 2 bottles, eggs 6 dropped', ITEMS);
    expect(r.map((e) => [e.itemId, e.qty, e.packId ?? e.unit, e.reason])).toEqual([
      ['milk', '2', 'milk-2l', 'expired'],
      ['egg', '6', 'each', 'dropped'],
    ]);
    expect(parseWasteText('tomatoes 1 carton', ITEMS)[0]).toMatchObject({ itemId: 'tom', packId: 'tom-ctn', reason: null });
  });
});
