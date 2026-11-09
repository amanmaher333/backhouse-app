import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { FOODICS_API, SimulatedFoodics } from '../src/integrations/foodics/client.js';
import { FoodicsService } from '../src/integrations/foodics/foodics.service.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let app: INestApplication;
let http: ReturnType<typeof request>;
let sim: SimulatedFoodics;
let svc: FoodicsService;

async function signup() {
  const o = await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } }).expect(201);
  return { token: o.body.accessToken as string, legalEntityId: o.body.legalEntity.id as string };
}

async function invite(owner: string, roleKey: string, siteIds?: string[]) {
  const roles = await http.get('/v1/roles').set(auth(owner)).expect(200);
  const role = roles.body.find((r: any) => r.key === roleKey);
  const inv = await http.post('/v1/invitations').set(auth(owner)).send({ email: `${uniq()}@t.sa`, roleId: role.id, siteIds }).expect(201);
  return (await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: roleKey }).expect(201)).body.accessToken as string;
}

/** Connect through the simulated Foodics: the authorize URL comes straight back with a code. */
async function connect(token: string, status: number, code?: string) {
  const { url } = (await http.post('/v1/integrations/foodics/connect').set(auth(token)).expect(200)).body;
  const u = new URL(url);
  return http.post('/v1/integrations/foodics/callback').set(auth(token)).send({ code: code ?? u.searchParams.get('code'), state: u.searchParams.get('state') }).expect(status);
}

const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', FOODICS_MODE: 'simulated' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
  sim = app.get(FOODICS_API);
  svc = app.get(FoodicsService);
});
afterAll(async () => {
  await app?.close();
});

describe('Foodics', () => {
  it('connects, maps branches and items, imports sales, follows returns, and records deliveries as purchases', async () => {
    const o = await signup();
    const olaya = (await http.post('/v1/sites').set(auth(o.token)).send({ legalEntityId: o.legalEntityId, name: 'Olaya', nameAr: 'العليا' }).expect(201)).body;
    await http.post('/v1/sites').set(auth(o.token)).send({ legalEntityId: o.legalEntityId, name: 'Malqa', nameAr: 'الملقا' }).expect(201);
    const chicken = (await http.post('/v1/items').set(auth(o.token)).send({ name: 'Chicken breast', nameAr: 'صدر دجاج', baseUnit: 'g', defaultPack: false }).expect(201)).body;
    const carton = (await http.post(`/v1/items/${chicken.id}/packs`).set(auth(o.token)).send({ name: 'Carton 10 kg', qty: 10, unit: 'kg' }).expect(201)).body;
    const tomato = (await http.post('/v1/items').set(auth(o.token)).send({ name: 'Tomato', nameAr: 'طماطم' }).expect(201)).body;
    const saffron = (await http.post('/v1/items').set(auth(o.token)).send({ name: 'Saffron', nameAr: 'زعفران', baseUnit: 'g', defaultPack: false }).expect(201)).body;
    const sGram = (await http.post(`/v1/items/${saffron.id}/packs`).set(auth(o.token)).send({ name: 'Box 10 g', qty: 10, unit: 'g' }).expect(201)).body;

    expect((await http.get('/v1/integrations/foodics').set(auth(o.token)).expect(200)).body).toMatchObject({ connected: false, mode: 'simulated' });
    const conn = (await connect(o.token, 200)).body;
    expect(conn).toMatchObject({ provider: 'foodics', status: 'connected', currency: 'SAR', timezone: 'Asia/Riyadh' });
    expect(conn.tokenSealed).toBeUndefined();
    await http.post('/v1/integrations/foodics/connect').set(auth(o.token)).expect(409);

    // A bad or reused state is refused.
    await http.post('/v1/integrations/foodics/callback').set(auth(o.token)).send({ code: 'sim-123456', state: 'not-a-real-state-value' }).expect(400);

    const sync = (await http.post('/v1/integrations/foodics/sync').set(auth(o.token)).expect(200)).body;
    expect(sync.catalog).toMatchObject({ locations: 3, items: 6, products: 3, autoMatchedSites: 2, autoMatchedItems: 3 });
    expect(sync.orders.imported).toBe(240); // 10 days × 24 orders

    const locs = (await http.get('/v1/integrations/foodics/locations').set(auth(o.token)).expect(200)).body;
    expect(locs.map((l: any) => [l.name, l.siteName, l.mappedBy])).toEqual([
      ['Malqa Branch', 'Malqa', 'auto'],
      ['Olaya Branch', 'Olaya', 'auto'],
      ['Central Warehouse', null, null],
    ]);
    const posItems = (await http.get('/v1/integrations/foodics/items').set(auth(o.token)).expect(200)).body;
    const byName = (n: string) => posItems.find((i: any) => i.name === n);
    expect(byName('Chicken Breast')).toMatchObject({ itemId: chicken.id, storageInBase: '1000.000000' });
    expect(byName('Tomatoes')).toMatchObject({ itemId: tomato.id });
    expect(byName('Saffron')).toMatchObject({ itemId: saffron.id, storageInBase: null }); // Box vs grams: needs a factor
    expect(byName('Burger Bun')).toMatchObject({ itemId: null, suggestion: null });

    // Sales: yesterday at Olaya (odd orders): 12 burgers, no shakshuka, 4 orders × 2 salads.
    const sales = (await http.get(`/v1/integrations/foodics/sales?from=${day(1)}&to=${day(1)}&siteId=${olaya.id}`).set(auth(o.token)).expect(200)).body;
    const sold = (name: string) => sales.products.find((p: any) => p.name === name)?.qty;
    expect([sold('Chicken Burger'), sold('Shakshuka'), sold('Chicken Salad')]).toEqual(['12.000', undefined, '8.000']);
    expect(sales.days).toHaveLength(1);
    const products = (await http.get('/v1/integrations/foodics/products').set(auth(o.token)).expect(200)).body;
    expect(products.find((p: any) => p.name === 'Chicken Burger')).toMatchObject({ hasPosRecipe: true, price: '28.0000' });

    // A burger is returned after closing; Foodics sends a webhook and we pull the change.
    const ref = conn.businessReference;
    const firstOrder = `ord-${Math.floor(Date.now() / 86400_000 - 1) * 1000 + 1}`;
    sim.returns.set(firstOrder, 1);
    await http.post('/v1/integrations/foodics/webhook').send({ event: 'order.updated', business: { name: 'Demo', reference: Number(ref) }, order: { id: firstOrder } }).expect(200);
    await svc.processWebhooks();
    const after = (await http.get(`/v1/integrations/foodics/sales?from=${day(1)}&to=${day(1)}&siteId=${olaya.id}`).set(auth(o.token)).expect(200)).body;
    expect(after.products.find((p: any) => p.name === 'Chicken Burger').qty).toBe('11.000');
    sim.returns.clear();

    // A delivery at Olaya: 2 cartons of chicken and 3 boxes of saffron.
    const sup = (await http.post('/v1/suppliers').set(auth(o.token)).send({ displayName: 'Al Watania', contactEmail: 'o@w.sa' }).expect(201)).body;
    const cl = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(o.token)).send({ itemId: chicken.id, packId: carton.id, price: 250 }).expect(201)).body;
    const sl = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(o.token)).send({ itemId: saffron.id, packId: sGram.id, price: 90 }).expect(201)).body;
    const po = (await http.post('/v1/purchase-orders').set(auth(o.token)).send({ siteId: olaya.id, relationshipId: sup.id, submit: true, lines: [{ supplierItemId: cl.id, qty: 2 }, { supplierItemId: sl.id, qty: 3 }] }).expect(201)).body;
    await http.post(`/v1/purchase-orders/${po.id}/send`).set(auth(o.token)).send({ via: 'manual' }).expect(200);
    const poLines = (await http.get(`/v1/purchase-orders/${po.id}`).set(auth(o.token)).expect(200)).body.lines;
    await http.post(`/v1/purchase-orders/${po.id}/receive`).set(auth(o.token)).send({ documentNo: 'INV-900', lines: poLines.map((l: any) => ({ lineId: l.id, qty: Number(l.qty) })) }).expect(200);

    // Saffron's units don't line up, so the purchase waits for a mapping.
    const s1 = (await http.post('/v1/integrations/foodics/sync').set(auth(o.token)).expect(200)).body;
    expect(s1.pushes).toMatchObject({ pushed: 0, needsMapping: 1 });
    let pushes = (await http.get('/v1/integrations/foodics/pushes').set(auth(o.token)).expect(200)).body;
    expect(pushes[0]).toMatchObject({ status: 'needs_mapping', siteName: 'Olaya' });
    expect(pushes[0].error).toContain('Saffron');

    // One Foodics "Box" of saffron is 10 g.
    await http.put(`/v1/integrations/foodics/items/${byName('Saffron').id}`).set(auth(o.token)).send({ itemId: saffron.id, manualFactor: 10 }).expect(200);
    const retried = (await http.post(`/v1/integrations/foodics/pushes/${pushes[0].id}/retry`).set(auth(o.token)).expect(200)).body;
    expect(retried).toMatchObject({ status: 'pushed' });
    const trx = sim.created.filter((c) => c.kind === 'inventory_transaction').at(-1)!.body as any;
    expect(trx).toMatchObject({ type: 1, status: 4, branch_id: 'br-olaya', invoice_number: 'INV-900', paid_tax: 115.5, additional_cost: 0 });
    expect(trx.items).toEqual([
      { id: 'inv-chicken', quantity: 20, cost: 500 },
      { id: 'inv-saffron', quantity: 3, cost: 270 },
    ]);
    expect(trx.supplier_id).toMatch(/^sup-/);
    expect(trx.creator_id).toMatch(/^usr-/);
    expect(sim.created.filter((c) => c.kind === 'supplier' && c.token === `sim:${ref}`)).toHaveLength(1);
    // Nothing is recorded twice.
    expect((await http.post('/v1/integrations/foodics/sync').set(auth(o.token)).expect(200)).body.pushes).toMatchObject({ pushed: 0, needsMapping: 0 });

    // Another organisation can't connect the same Foodics account.
    const other = await signup();
    await connect(other.token, 409, `sim-${ref}`);

    // People without access can't see it; disconnecting revokes the token.
    const staff = await invite(o.token, 'staff');
    await http.get('/v1/integrations/foodics').set(auth(staff)).expect(403);
    await http.post('/v1/integrations/foodics/disconnect').set(auth(o.token)).expect(200);
    expect(sim.created.some((c) => c.kind === 'revoke' && c.token === `sim:${ref}`)).toBe(true);
    expect((await http.get('/v1/integrations/foodics').set(auth(o.token)).expect(200)).body).toMatchObject({ connected: false });
    // Once disconnected, the business can be connected again (here by the other organisation).
    await connect(other.token, 200, `sim-${ref}`);
  });
});
