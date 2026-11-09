import { describe, expect, it } from 'vitest';
import { countAdjustment, parseCountText, parseEntry, splitEntries, type CountableItem } from './counts.js';

const ITEMS: CountableItem[] = [
  { id: 'tom', name: 'Tomato', nameAr: 'طماطم', baseUnit: 'g', packs: [{ id: 'tom-1kg', name: '1 kg', nameAr: '1 كجم' }, { id: 'tom-ctn', name: 'Carton 6 kg', nameAr: 'كرتون 6 كجم' }] },
  { id: 'chk', name: 'Chicken breast', nameAr: 'صدر دجاج', baseUnit: 'g', packs: [{ id: 'chk-ctn', name: 'Carton 10 kg', nameAr: 'كرتون 10 كجم' }] },
  { id: 'egg', name: 'Eggs', nameAr: 'بيض', baseUnit: 'each', packs: [{ id: 'egg-tray', name: 'Tray of 30', nameAr: 'طبق 30' }] },
  { id: 'oil', name: 'Olive oil', nameAr: 'زيت زيتون', baseUnit: 'ml', packs: [{ id: 'oil-tin', name: 'Tin 5 L', nameAr: 'تنكة 5 لتر' }] },
  { id: 'veg-oil', name: 'Vegetable oil', nameAr: 'زيت نباتي', baseUnit: 'ml', packs: [] },
  { id: 'rice', name: 'Basmati rice', nameAr: 'رز بسمتي', baseUnit: 'g', packs: [{ id: 'rice-bag', name: 'Bag 40 kg', nameAr: 'كيس 40 كجم' }] },
];

describe('reading counts people type or say', () => {
  it('splits a message into entries', () => {
    expect(splitEntries('tomatoes 12 kg, chicken 3 cartons\neggs 60؛ زيت زيتون ٢ تنكة')).toEqual(['tomatoes 12 kg', 'chicken 3 cartons', 'eggs 60', 'زيت زيتون 2 تنكة']);
    expect(splitEntries('rice 2 bags and tomatoes 4 kg')).toEqual(['rice 2 bags', 'tomatoes 4 kg']);
  });

  it('reads English entries with units and packs, in any order', () => {
    expect(parseEntry('tomatoes 12 kg', ITEMS)).toMatchObject({ itemId: 'tom', qty: '12', unit: 'kg', packId: null, problem: null });
    expect(parseEntry('12kg tomato', ITEMS)).toMatchObject({ itemId: 'tom', qty: '12', unit: 'kg' });
    expect(parseEntry('chicken 3 cartons', ITEMS)).toMatchObject({ itemId: 'chk', qty: '3', packId: 'chk-ctn' });
    expect(parseEntry('2.5 L olive oil', ITEMS)).toMatchObject({ itemId: 'oil', qty: '2.5', unit: 'l' });
    expect(parseEntry('half a bag of rice', ITEMS)).toMatchObject({ itemId: 'rice', qty: '0.5', packId: 'rice-bag' });
  });

  it('reads Arabic entries, with Arabic-Indic digits', () => {
    expect(parseEntry('طماطم ١٢ كيلو', ITEMS)).toMatchObject({ itemId: 'tom', qty: '12', unit: 'kg' });
    expect(parseEntry('دجاج ٣ كراتين', ITEMS)).toMatchObject({ itemId: 'chk', qty: '3', packId: 'chk-ctn' });
    expect(parseEntry('بيض طبقين', ITEMS)).toMatchObject({ itemId: 'egg', problem: 'no_qty' });
    expect(parseEntry('بيض ٢ طبق', ITEMS)).toMatchObject({ itemId: 'egg', qty: '2', packId: 'egg-tray' });
    expect(parseEntry('زيت زيتون ١٫٥ لتر', ITEMS)).toMatchObject({ itemId: 'oil', qty: '1.5', unit: 'l' });
  });

  it('uses the obvious unit when none is said', () => {
    expect(parseEntry('eggs 60', ITEMS)).toMatchObject({ itemId: 'egg', qty: '60', unit: 'each' });
    expect(parseEntry('chicken 4', ITEMS)).toMatchObject({ itemId: 'chk', packId: 'chk-ctn' }); // its only pack
    expect(parseEntry('tomato 4', ITEMS)).toMatchObject({ itemId: 'tom', problem: 'no_unit' }); // two packs: unclear
  });

  it('says what is missing instead of guessing', () => {
    expect(parseEntry('saffron 2 g', ITEMS)).toMatchObject({ itemId: null, problem: 'no_item' });
    const oil = parseEntry('oil 3 l', ITEMS);
    expect(oil).toMatchObject({ itemId: null, problem: 'ambiguous_item' });
    expect(oil.candidates.sort()).toEqual(['oil', 'veg-oil']);
    expect(parseEntry('chicken 3 kg of litres', ITEMS)).toMatchObject({ itemId: 'chk', unit: 'kg' });
    expect(parseEntry('olive oil 3 kg', ITEMS)).toMatchObject({ itemId: 'oil', problem: 'no_unit' }); // kg for a liquid
    expect(parseEntry('tomatoes', ITEMS)).toMatchObject({ itemId: 'tom', problem: 'no_qty' });
  });

  it('reads a whole message', () => {
    const r = parseCountText('طماطم ١٢ كيلو، chicken 3 cartons, eggs 60', ITEMS);
    expect(r.map((e) => [e.itemId, e.qty, e.unit ?? e.packId])).toEqual([
      ['tom', '12', 'kg'],
      ['chk', '3', 'chk-ctn'],
      ['egg', '60', 'each'],
    ]);
  });
});

describe('count adjustments', () => {
  it('compares the count with what was expected when it was counted', () => {
    // 10 kg at the start, 6 kg delivered during the count before this item was counted, 15 kg counted.
    expect(countAdjustment({ snapshotQty: 10000, movedSinceSnapshot: 6000, countedQty: 15000, unitCost: '0.005' })).toEqual({ expected: '16000.000000', adjustment: '-1000.000000', value: '-5.00' });
    expect(countAdjustment({ snapshotQty: 0, movedSinceSnapshot: 0, countedQty: 30, unitCost: '0.5' })).toEqual({ expected: '0.000000', adjustment: '30.000000', value: '15.00' });
  });
});
