import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { foodCostReport, recipeUsage } from './foodcost.js';
import type { CostingItem, RecipeDef } from './recipes.js';

const items = new Map<string, CostingItem>([
  ['chicken', { id: 'chicken', name: 'Chicken breast', baseUnit: 'g', costPerBase: '0.025' }],
  ['bun', { id: 'bun', name: 'Burger bun', baseUnit: 'each', costPerBase: '0.8' }],
  ['tomato', { id: 'tomato', name: 'Tomato', baseUnit: 'g', costPerBase: '0.0055' }],
  ['oil', { id: 'oil', name: 'Olive oil', baseUnit: 'ml', costPerBase: '0.028' }],
]);
const recipes: RecipeDef[] = [
  { id: 'sauce', name: 'Tomato sauce', kind: 'prep', yieldQty: 2, yieldUnit: 'kg', lines: [{ itemId: 'tomato', qty: 2.5, unit: 'kg', yieldPct: 80 }, { itemId: 'oil', qty: 100, unit: 'ml' }] },
  { id: 'burger', name: 'Chicken burger', kind: 'menu', yieldQty: 1, yieldUnit: 'each', lines: [{ itemId: 'chicken', qty: 150, unit: 'g' }, { itemId: 'bun', qty: 1 }, { subRecipeId: 'sauce', qty: 40, unit: 'g' }] },
  { id: 'wings', name: 'Wings (box of 2)', kind: 'menu', yieldQty: 2, yieldUnit: 'each', lines: [{ itemId: 'chicken', qty: 400, unit: 'g', yieldPct: 80 }] },
];

describe('recipe usage', () => {
  it('explodes preps to raw items, with trim loss, per portion', () => {
    const u = recipeUsage(recipes, items);
    const burger = u.get('burger')!;
    expect(burger.get('chicken')!.toNumber()).toBe(150);
    expect(burger.get('bun')!.toNumber()).toBe(1);
    // 40 g of sauce: 3125 g tomatoes and 100 ml oil make 2000 g.
    expect(burger.get('tomato')!.toNumber()).toBe(62.5);
    expect(burger.get('oil')!.toNumber()).toBe(2);
    // Box of 2 portions: 400 g net at 80% = 500 g bought, 250 g per portion.
    expect(u.get('wings')!.get('chicken')!.toNumber()).toBe(250);
  });
});

describe('theoretical vs actual', () => {
  it('compares what went with what sales and waste explain', () => {
    const usage = recipeUsage(recipes, items);
    const r = foodCostReport({
      items: new Map([...items].map(([id, i]) => [id, { name: i.name, baseUnit: i.baseUnit, unitCost: i.costPerBase }])),
      // Chicken: 20 kg counted, 10 kg delivered, 2 kg to another site, 12 kg counted at the end → 16 kg used; 0.5 kg logged as waste.
      ledger: [
        { itemId: 'chicken', opening: 20000, received: 10000, transferIn: 0, transferOut: 2000, waste: 500, closing: 12000 },
        { itemId: 'bun', opening: 100, received: 0, transferIn: 0, transferOut: 0, waste: 0, closing: 10 },
      ],
      sales: [
        { productId: 'p-burger', name: 'Chicken burger', qty: 90, net: 2250, recipeId: 'burger' },
        { productId: 'p-shake', name: 'Milkshake', qty: 10, net: 150, recipeId: null },
      ],
      usage,
    });
    const chicken = r.rows.find((x) => x.itemId === 'chicken')!;
    // 90 burgers × 150 g = 13.5 kg sold + 0.5 kg waste = 14 kg theoretical; 16 kg actual → 2 kg unexplained = 50.00.
    expect(chicken).toMatchObject({ actual: '16000.000', sold: '13500.000', waste: '500.000', theoretical: '14000.000', variance: '2000.000', varianceValue: '50.00' });
    const bun = r.rows.find((x) => x.itemId === 'bun')!;
    expect(bun).toMatchObject({ actual: '90.000', theoretical: '90.000', variance: '0.000' });
    // Tomato and oil were "sold" through the sauce but never stocked: actual 0, so a negative variance shows it.
    expect(r.rows.find((x) => x.itemId === 'tomato')).toMatchObject({ actual: '0.000', theoretical: '5625.000' });
    expect(r.rows[0]!.itemId).toBe('chicken'); // biggest loss first
    expect(r).toMatchObject({ netSales: '2400.00', netSalesWithRecipe: '2250.00' });
    expect(r.withoutRecipe).toEqual([{ productId: 'p-shake', name: 'Milkshake', qty: '10.000', net: '150.00' }]);
    // Actual: 16000 × 0.025 + 90 × 0.8 = 472; theoretical: 14000 × 0.025 + 72 + 5625 × 0.0055 + 180 × 0.028 = 457.98.
    expect(r.actualCost).toBe('472.00');
    expect(r.theoreticalCost).toBe(new Decimal(350).plus(72).plus(30.9375).plus(5.04).toFixed(2));
    expect(r.actualPct).toBe('19.7');
  });
});
