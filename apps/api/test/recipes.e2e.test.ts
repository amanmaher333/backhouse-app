import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let app: INestApplication;
let http: ReturnType<typeof request>;

async function invite(owner: string, roleKey: string, siteIds?: string[]) {
  const roles = await http.get('/v1/roles').set(auth(owner)).expect(200);
  const role = roles.body.find((r: any) => r.key === roleKey);
  const inv = await http.post('/v1/invitations').set(auth(owner)).send({ email: `${uniq()}@t.sa`, roleId: role.id, siteIds }).expect(201);
  return (await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: roleKey }).expect(201)).body.accessToken as string;
}

/** Items priced by a supplier: chicken 0.025/g, bun 0.80 each, tomato 0.0055/g, olive oil 0.028/ml. */
async function setup() {
  const o = await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } }).expect(201);
  const token = o.body.accessToken as string;
  const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: o.body.legalEntity.id, name: 'Olaya' }).expect(201)).body;
  const sup = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Al Watania', contactEmail: 'o@w.sa' }).expect(201)).body;
  const mk = async (name: string, baseUnit: string, pack: { name: string; qty: number; unit: string }, price: number, allergens: string[] = []) => {
    const it = (await http.post('/v1/items').set(auth(token)).send({ name, baseUnit, defaultPack: false, allergens }).expect(201)).body;
    const p = (await http.post(`/v1/items/${it.id}/packs`).set(auth(token)).send(pack).expect(201)).body;
    const line = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(token)).send({ itemId: it.id, packId: p.id, price }).expect(201)).body;
    return { ...it, pack: p, line };
  };
  const chicken = await mk('Chicken breast', 'g', { name: 'Carton 10 kg', qty: 10, unit: 'kg' }, 250);
  const bun = await mk('Burger bun', 'each', { name: 'Bag of 10', qty: 10, unit: 'each' }, 8, ['gluten', 'sesame']);
  const tomato = await mk('Tomato', 'g', { name: 'Carton 6 kg', qty: 6, unit: 'kg' }, 33);
  const oil = await mk('Olive oil', 'ml', { name: 'Tin 5 L', qty: 5, unit: 'l' }, 140);
  return { token, site, sup, chicken, bun, tomato, oil };
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', FOODICS_MODE: 'simulated' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});

describe('recipes', () => {
  it('costs menu items with preps and trim loss, against the price before VAT', async () => {
    const x = await setup();
    const sauce = (await http
      .post('/v1/recipes')
      .set(auth(x.token))
      .send({ name: 'Tomato sauce', kind: 'prep', yieldQty: 2, yieldUnit: 'kg', lines: [{ itemId: x.tomato.id, qty: 2.5, unit: 'kg', yieldPct: 80 }, { itemId: x.oil.id, qty: 100, unit: 'ml' }] })
      .expect(201)).body;
    // 3125 g of tomatoes bought (80% usable) × 0.0055 + 100 ml × 0.028 = 19.99 for 2 kg.
    expect(sauce).toMatchObject({ batchCost: '19.99', unitCost: '9.9938', missing: [] });
    expect(sauce.lines[0]).toMatchObject({ qtyBase: '2500.000000', grossBase: '3125.000000', cost: '17.1875' });

    const burger = (await http
      .post('/v1/recipes')
      .set(auth(x.token))
      .send({
        name: 'Chicken burger',
        nameAr: 'برجر دجاج',
        category: 'Burgers',
        sellingPrice: 28.75,
        targetCostPct: 30,
        lines: [{ itemId: x.chicken.id, qty: 150, unit: 'g' }, { itemId: x.bun.id, qty: 1, packId: null }, { subRecipeId: sauce.id, qty: 40, unit: 'g' }],
      })
      .expect(201)).body;
    // 3.75 + 0.80 + 0.39975 = 4.9498; price before 15% VAT 25.00 → 19.8%.
    expect(burger).toMatchObject({ kind: 'menu', unitCost: '4.9498', price: '28.75', priceExVat: '25.00', foodCostPct: '19.8', overTarget: false, allergens: ['gluten', 'sesame'] });

    // Changing only the name leaves everything else alone.
    const renamed = (await http.patch(`/v1/recipes/${burger.id}`).set(auth(x.token)).send({ name: 'Classic chicken burger', targetCostPct: 15 }).expect(200)).body;
    expect(renamed).toMatchObject({ name: 'Classic chicken burger', yieldQty: '1.0000', unitCost: '4.9498', overTarget: true });
    expect(renamed.lines).toHaveLength(3);

    const list = (await http.get('/v1/recipes').set(auth(x.token)).expect(200)).body;
    expect(list.map((r: any) => [r.name, r.kind, r.lines])).toEqual([
      ['Classic chicken burger', 'menu', 3],
      ['Tomato sauce', 'prep', 2],
    ]);
    expect((await http.get(`/v1/recipes/${sauce.id}`).set(auth(x.token)).expect(200)).body.usedIn).toEqual([expect.objectContaining({ name: 'Classic chicken burger' })]);

    // Menu items can't go inside recipes, and preps can't loop.
    await http.patch(`/v1/recipes/${sauce.id}`).set(auth(x.token)).send({ lines: [{ subRecipeId: burger.id, qty: 1, unit: 'each' }] }).expect(400);
    const base = (await http.post('/v1/recipes').set(auth(x.token)).send({ name: 'Pizza base', kind: 'prep', yieldQty: 1, yieldUnit: 'kg', lines: [{ subRecipeId: sauce.id, qty: 200, unit: 'g' }] }).expect(201)).body;
    const loop = await http.patch(`/v1/recipes/${sauce.id}`).set(auth(x.token)).send({ lines: [{ subRecipeId: base.id, qty: 100, unit: 'g' }] }).expect(400);
    expect(loop.body.message).toContain('Pizza base already uses this recipe');
    // Wrong units are refused with the item's name.
    expect((await http.post('/v1/recipes').set(auth(x.token)).send({ name: 'Bad', lines: [{ itemId: x.bun.id, qty: 1, unit: 'ml' }] }).expect(400)).body.message).toContain('Burger bun');
    // A prep in use can't be deleted.
    await http.delete(`/v1/recipes/${sauce.id}`).set(auth(x.token)).expect(409);
    await http.delete(`/v1/recipes/${base.id}`).set(auth(x.token)).expect(200);

    // On the stock-average basis, the chicken bought at a higher price raises the cost.
    await http.post(`/v1/sites/${x.site.id}/stock/set`).set(auth(x.token)).send({ itemId: x.chicken.id, qty: 2, packId: x.chicken.pack.id }).expect(201);
    const po = (await http.post('/v1/purchase-orders').set(auth(x.token)).send({ siteId: x.site.id, relationshipId: x.sup.id, submit: true, lines: [{ supplierItemId: x.chicken.line.id, qty: 2, unitPrice: 300 }] }).expect(201)).body;
    await http.post(`/v1/purchase-orders/${po.id}/send`).set(auth(x.token)).send({ via: 'manual' }).expect(200);
    const pl = (await http.get(`/v1/purchase-orders/${po.id}`).set(auth(x.token)).expect(200)).body.lines;
    await http.post(`/v1/purchase-orders/${po.id}/receive`).set(auth(x.token)).send({ lines: [{ lineId: pl[0].id, qty: 2, unitPrice: 300 }], updatePrices: false }).expect(200);
    const avg = (await http.get(`/v1/recipes/${burger.id}?basis=average`).set(auth(x.token)).expect(200)).body;
    // Chicken average (20 kg at 0.025 + 20 kg at 0.03) = 0.0275/g → 150 g = 4.125.
    expect(avg.lines[0]).toMatchObject({ unitCost: '0.02750000', cost: '4.1250' });
    expect(avg.unitCost).toBe('5.3248');

    // Who can see and change recipes.
    const staff = await invite(x.token, 'staff', [x.site.id]);
    await http.get('/v1/recipes').set(auth(staff)).expect(403);
    const manager = await invite(x.token, 'site_manager', [x.site.id]);
    expect((await http.get('/v1/recipes').set(auth(manager)).expect(200)).body).toHaveLength(2);
    await http.post('/v1/recipes').set(auth(manager)).send({ name: 'Nope' }).expect(403);
  });

  it('creates menu recipes from the recipes Foodics keeps', async () => {
    const x = await setup();
    // Connect the demo Foodics business and sync: its Chicken Breast, Tomatoes, Burger Bun and Olive Oil match ours.
    const { url } = (await http.post('/v1/integrations/foodics/connect').set(auth(x.token)).expect(200)).body;
    const u = new URL(url);
    await http.post('/v1/integrations/foodics/callback').set(auth(x.token)).send({ code: u.searchParams.get('code'), state: u.searchParams.get('state') }).expect(200);
    await http.post('/v1/integrations/foodics/sync').set(auth(x.token)).expect(200);

    expect((await http.get('/v1/recipes/pos-products').set(auth(x.token)).expect(200)).body.map((p: any) => p.name)).toEqual(['Chicken Burger', 'Chicken Salad', 'Shakshuka']);
    const r = (await http.post('/v1/recipes/from-pos').set(auth(x.token)).send({}).expect(200)).body;
    expect(r.created.map((c: any) => [c.name, c.lines])).toEqual([
      ['Chicken Burger', 3],
      ['Chicken Salad', 2],
    ]);
    // Shakshuka uses eggs, which aren't a Backhouse item yet.
    expect(r.skipped).toEqual([expect.objectContaining({ name: 'Shakshuka', reason: expect.stringContaining("Eggs isn't linked") })]);

    const burger = (await http.get(`/v1/recipes/${r.created[0].id}`).set(auth(x.token)).expect(200)).body;
    // Foodics: 150 g chicken, 1 bun, 30 g tomato; the price comes from Foodics (28 incl. VAT).
    expect(burger.lines.map((l: any) => [l.name, l.qty, l.unit])).toEqual([
      ['Chicken breast', '150.0000', 'g'],
      ['Burger bun', '1.0000', 'each'],
      ['Tomato', '30.0000', 'g'],
    ]);
    expect(burger).toMatchObject({ source: 'foodics', priceSource: 'pos', price: '28.00', priceExVat: '24.35', unitCost: '4.7150', foodCostPct: '19.4' });
    expect(burger.posProduct).toMatchObject({ name: 'Chicken Burger' });
    // Running it again creates nothing new; linking another recipe to the same product is refused.
    expect((await http.post('/v1/recipes/from-pos').set(auth(x.token)).send({}).expect(200)).body.created).toEqual([]);
    await http.post('/v1/recipes').set(auth(x.token)).send({ name: 'Dup', posProductId: burger.posProductId }).expect(409);
  });
});
