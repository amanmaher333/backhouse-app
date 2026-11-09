import { describe, expect, it } from 'vitest';
import { costRecipes, foodCostPct, priceExVat, wouldCycle, type CostingItem, type RecipeDef } from './recipes.js';

const items = new Map<string, CostingItem>([
  ['chicken', { id: 'chicken', name: 'Chicken breast', baseUnit: 'g', costPerBase: '0.025', allergens: [] }],
  ['bun', { id: 'bun', name: 'Burger bun', baseUnit: 'each', costPerBase: '0.80', allergens: ['gluten', 'sesame'] }],
  ['tomato', { id: 'tomato', name: 'Tomato', baseUnit: 'g', costPerBase: '0.0055', allergens: [] }],
  ['oil', { id: 'oil', name: 'Olive oil', baseUnit: 'ml', costPerBase: '0.028', allergens: [] }],
  ['egg', { id: 'egg', name: 'Eggs', baseUnit: 'each', costPerBase: '0.5', allergens: ['egg'], conversions: [{ from: { qty: 1, unit: 'each' }, to: { qty: 60, unit: 'g' } }] }],
  ['saffron', { id: 'saffron', name: 'Saffron', baseUnit: 'g', costPerBase: null, allergens: [] }],
  ['flour', { id: 'flour', name: 'Flour', baseUnit: 'g', costPerBase: '0.004', packs: [{ id: 'bag', name: 'Bag 10 kg', qty: 10, unit: 'kg' }], allergens: ['gluten'] }],
]);

describe('recipe costing', () => {
  it('costs a menu item with trim loss and a prep used by it', () => {
    const recipes: RecipeDef[] = [
      // 2 kg of sauce: 2.5 kg tomatoes at 80% usable, 100 ml oil.
      { id: 'sauce', name: 'Tomato sauce', kind: 'prep', yieldQty: 2, yieldUnit: 'kg', lines: [{ itemId: 'tomato', qty: 2.5, unit: 'kg', yieldPct: 80 }, { itemId: 'oil', qty: 100, unit: 'ml' }] },
      { id: 'burger', name: 'Chicken burger', kind: 'menu', yieldQty: 1, yieldUnit: 'each', lines: [{ itemId: 'chicken', qty: 150, unit: 'g' }, { itemId: 'bun', qty: 1 }, { subRecipeId: 'sauce', qty: 40, unit: 'g' }] },
    ];
    const c = costRecipes(recipes, items);
    const sauce = c.get('sauce')!;
    // Tomatoes: 2500 g net ÷ 0.8 = 3125 g × 0.0055 = 17.1875; oil 100 × 0.028 = 2.8 → 19.9875 for 2000 g.
    expect(sauce.total).toBe('19.9875');
    expect(sauce.perBase).toBe('0.00999375');
    expect(sauce.lines[0]).toMatchObject({ qtyBase: '2500.000000', grossBase: '3125.000000', cost: '17.1875' });
    const burger = c.get('burger')!;
    // 150 × 0.025 = 3.75; bun 0.80; 40 g sauce × 0.00999375 = 0.39975 → 4.94975.
    expect(burger.total).toBe('4.9498');
    expect(burger.perBase).toBe('4.94975000');
    expect(burger.allergens).toEqual(['gluten', 'sesame']);
    expect(burger.missing).toEqual([]);
  });

  it('uses packs and conversions, and lists what has no cost or the wrong unit', () => {
    const c = costRecipes(
      [
        {
          id: 'r',
          name: 'Saffron rice',
          kind: 'menu',
          yieldQty: 4,
          yieldUnit: 'each',
          lines: [
            { itemId: 'flour', qty: 0.01, packId: 'bag' }, // 100 g
            { itemId: 'egg', qty: 120, unit: 'g' }, // 2 eggs via 60 g each
            { itemId: 'saffron', qty: 1, unit: 'g' }, // no cost
            { itemId: 'oil', qty: 2, unit: 'kg' }, // ml item in kg: no conversion
          ],
        },
      ],
      items,
    ).get('r')!;
    expect(c.lines.map((l) => [l.name, l.cost, l.problem])).toEqual([
      ['Flour', '0.4000', null],
      ['Eggs', '1.0000', null],
      ['Saffron', null, 'no_cost'],
      ['Olive oil', null, 'bad_unit'],
    ]);
    expect(c.total).toBe('1.4000');
    expect(c.perBase).toBe('0.35000000'); // per portion, 4 portions
    expect(c.missing).toEqual(['Saffron', 'Olive oil']);
    expect(c.allergens).toEqual(['egg', 'gluten']);
  });

  it('flags recipes that use themselves', () => {
    const c = costRecipes(
      [
        { id: 'a', name: 'A', kind: 'prep', yieldQty: 1, yieldUnit: 'kg', lines: [{ subRecipeId: 'b', qty: 100, unit: 'g' }] },
        { id: 'b', name: 'B', kind: 'prep', yieldQty: 1, yieldUnit: 'kg', lines: [{ subRecipeId: 'a', qty: 100, unit: 'g' }] },
      ],
      items,
    );
    expect(c.get('a')!.cycle || c.get('b')!.cycle).toBe(true);
    expect(wouldCycle('a', 'b', new Map([['b', ['a']]]))).toBe(true);
    expect(wouldCycle('a', 'b', new Map([['b', ['c']]]))).toBe(false);
  });

  it('works out food cost against the price before VAT', () => {
    expect(priceExVat(28.75, true, 0.15).toFixed(2)).toBe('25.00');
    expect(foodCostPct('7.50', priceExVat(28.75, true, 0.15))).toBe('30.0');
    expect(foodCostPct(5, null)).toBeNull();
  });
});
