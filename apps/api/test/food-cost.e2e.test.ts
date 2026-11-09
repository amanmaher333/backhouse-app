import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createDb, runMigrations, type DbHandle } from '@boh/db';
import { zonedTimeToUtc } from '@boh/domain';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let app: INestApplication;
let http: ReturnType<typeof request>;
let raw: DbHandle;

const riyadhDate = (offsetDays: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date(Date.now() + offsetDays * 86400_000));
const yesterday = riyadhDate(-1);
const at = (date: string, time: string) => zonedTimeToUtc(date, time, 'Asia/Riyadh');

/** Move the site's movements made since `afterId` (and optionally a count's posting time) back to `when`. */
async function backdate(siteId: string, afterId: number, when: Date, countId?: string) {
  // The ledger is append-only (even for the owner); lift that only to simulate the past.
  await raw.pool.query('alter table stock_movements disable trigger stock_movements_immutable');
  await raw.pool.query('update stock_movements set occurred_at = $1 where site_id = $2 and id > $3', [when, siteId, afterId]);
  await raw.pool.query('alter table stock_movements enable trigger stock_movements_immutable');
  if (countId) {
    await raw.pool.query('alter table stock_counts disable trigger stock_counts_guard');
    await raw.pool.query('update stock_counts set posted_at = $1 where id = $2', [when, countId]);
    await raw.pool.query('alter table stock_counts enable trigger stock_counts_guard');
  }
}
const lastMovementId = async () => Number((await raw.pool.query('select coalesce(max(id), 0) as id from stock_movements')).rows[0].id);

async function invite(owner: string, roleKey: string, siteIds?: string[]) {
  const roles = await http.get('/v1/roles').set(auth(owner)).expect(200);
  const role = roles.body.find((r: any) => r.key === roleKey);
  const inv = await http.post('/v1/invitations').set(auth(owner)).send({ email: `${uniq()}@t.sa`, roleId: role.id, siteIds }).expect(201);
  return (await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: roleKey }).expect(201)).body.accessToken as string;
}

beforeAll(async () => {
  await runMigrations(DB);
  raw = createDb(DB, 2);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', FOODICS_MODE: 'simulated' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
  await raw?.pool.end();
});

describe('theoretical vs actual food cost', () => {
  it('compares stock used with what Foodics sales and recorded waste explain', async () => {
    const o = await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } }).expect(201);
    const token = o.body.accessToken as string;
    const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: o.body.legalEntity.id, name: 'Olaya', nameAr: 'العليا', timezone: 'Asia/Riyadh' }).expect(201)).body;
    const sup = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Al Watania', contactEmail: 'o@w.sa' }).expect(201)).body;
    const mk = async (name: string, baseUnit: string, pack: { name: string; qty: number; unit: string }, price: number) => {
      const it = (await http.post('/v1/items').set(auth(token)).send({ name, baseUnit, defaultPack: false }).expect(201)).body;
      const p = (await http.post(`/v1/items/${it.id}/packs`).set(auth(token)).send(pack).expect(201)).body;
      const line = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(token)).send({ itemId: it.id, packId: p.id, price }).expect(201)).body;
      return { ...it, pack: p, line };
    };
    const chicken = await mk('Chicken breast', 'g', { name: 'Carton 10 kg', qty: 10, unit: 'kg' }, 250); // 0.025/g
    const bun = await mk('Burger bun', 'each', { name: 'Bag of 10', qty: 10, unit: 'each' }, 8); // 0.80
    const tomato = await mk('Tomato', 'g', { name: 'Carton 6 kg', qty: 6, unit: 'kg' }, 33); // 0.0055/g

    // Foodics demo: Olaya sells 12 burgers and 8 salads a day.
    const { url } = (await http.post('/v1/integrations/foodics/connect').set(auth(token)).expect(200)).body;
    const u = new URL(url);
    await http.post('/v1/integrations/foodics/callback').set(auth(token)).send({ code: u.searchParams.get('code'), state: u.searchParams.get('state') }).expect(200);
    await http.post('/v1/integrations/foodics/sync').set(auth(token)).expect(200);
    const posProducts = (await http.get('/v1/recipes/pos-products').set(auth(token)).expect(200)).body;
    const burgerProduct = posProducts.find((p: any) => p.name === 'Chicken Burger');
    await http.post('/v1/recipes/from-pos').set(auth(token)).send({ productIds: [burgerProduct.id] }).expect(200);

    // Stock: counted two days ago; a delivery and some waste yesterday; the closing count late yesterday.
    let last = await lastMovementId();
    const opening = (await http.post(`/v1/sites/${site.id}/stock-counts`).set(auth(token)).send({}).expect(201)).body;
    await http
      .patch(`/v1/stock-counts/${opening.id}/lines`)
      .set(auth(token))
      .send({ lines: [{ itemId: chicken.id, qty: 20, unit: 'kg' }, { itemId: bun.id, qty: 100, unit: 'each' }, { itemId: tomato.id, qty: 10, unit: 'kg' }] })
      .expect(200);
    await http.post(`/v1/stock-counts/${opening.id}/submit`).set(auth(token)).expect(200);
    await http.post(`/v1/stock-counts/${opening.id}/post`).set(auth(token)).expect(200);
    await backdate(site.id, last, at(riyadhDate(-2), '23:00'), opening.id);

    last = await lastMovementId();
    const po = (await http.post('/v1/purchase-orders').set(auth(token)).send({ siteId: site.id, relationshipId: sup.id, submit: true, lines: [{ supplierItemId: chicken.line.id, qty: 1 }] }).expect(201)).body;
    await http.post(`/v1/purchase-orders/${po.id}/send`).set(auth(token)).send({ via: 'manual' }).expect(200);
    const pl = (await http.get(`/v1/purchase-orders/${po.id}`).set(auth(token)).expect(200)).body.lines;
    await http.post(`/v1/purchase-orders/${po.id}/receive`).set(auth(token)).send({ lines: [{ lineId: pl[0].id, qty: 1 }] }).expect(200);
    await http.post(`/v1/sites/${site.id}/waste`).set(auth(token)).send({ entries: [{ itemId: chicken.id, qty: 500, unit: 'g', reason: 'expired' }] }).expect(201);
    await backdate(site.id, last, at(yesterday, '12:00'));

    last = await lastMovementId();
    const count = (await http.post(`/v1/sites/${site.id}/stock-counts`).set(auth(token)).send({}).expect(201)).body;
    await http
      .patch(`/v1/stock-counts/${count.id}/lines`)
      .set(auth(token))
      .send({ lines: [{ itemId: chicken.id, qty: 26, unit: 'kg' }, { itemId: bun.id, qty: 85, unit: 'each' }, { itemId: tomato.id, qty: 7, unit: 'kg' }] })
      .expect(200);
    await http.post(`/v1/stock-counts/${count.id}/submit`).set(auth(token)).expect(200);
    await http.post(`/v1/stock-counts/${count.id}/post`).set(auth(token)).expect(200);
    await backdate(site.id, last, at(yesterday, '23:30'), count.id);

    // Yesterday, before the salad has a recipe: its sales are listed as not covered.
    let r = (await http.get(`/v1/food-cost?siteId=${site.id}&from=${yesterday}&to=${yesterday}`).set(auth(token)).expect(200)).body;
    expect(r.withoutRecipe).toEqual([expect.objectContaining({ name: 'Chicken Salad', qty: '8.000', net: '222.60' })]);
    expect(r.pos).toMatchObject({ connected: true, linkedLocations: 1 });

    await http.post('/v1/recipes/from-pos').set(auth(token)).send({}).expect(200);
    r = (await http.get(`/v1/food-cost?siteId=${site.id}&from=${yesterday}&to=${yesterday}`).set(auth(token)).expect(200)).body;
    expect(r.withoutRecipe).toEqual([]);
    expect(r.counts.start).toMatchObject({ ref: opening.ref }); // counted the night before
    expect(r.counts.end).toMatchObject({ ref: count.ref });
    const row = (n: string) => r.rows.find((x: any) => x.name === n);
    // Chicken: 20 + 10 − 26 = 4 kg used; sold 12 × 150 g + 8 × 120 g = 2.76 kg, + 0.5 kg waste = 3.26 kg → 740 g unexplained.
    expect(row('Chicken breast')).toMatchObject({ opening: '20000.000', received: '10000.000', closing: '26000.000', actual: '4000.000', sold: '2760.000', waste: '500.000', theoretical: '3260.000', variance: '740.000', varianceValue: '18.50' });
    expect(row('Burger bun')).toMatchObject({ actual: '15.000', theoretical: '12.000', variance: '3.000', varianceValue: '2.40' });
    expect(row('Tomato')).toMatchObject({ actual: '3000.000', theoretical: '1000.000', variance: '2000.000', varianceValue: '11.00' });
    expect(r.rows[0].name).toBe('Chicken breast');
    // Net sales 12 × 24.35 + 4 × 55.65 = 514.80; actual 128.50 (25.0%); theoretical 96.60 (18.8%).
    expect(r.totals).toMatchObject({ netSales: '514.80', actualCost: '128.50', theoreticalCost: '96.60', wasteCost: '12.50', varianceCost: '31.90', actualPct: '25.0', theoreticalPct: '18.8', gapPct: '6.2' });

    // Counts offered as period ends; between the two counts gives the same figures.
    const periods = (await http.get(`/v1/food-cost/periods?siteId=${site.id}`).set(auth(token)).expect(200)).body;
    expect(periods.map((p: any) => p.ref)).toEqual([count.ref, opening.ref]);
    expect(periods[0]).toMatchObject({ id: count.id, date: yesterday });
    const between = (await http.get(`/v1/food-cost?siteId=${site.id}&fromCountId=${opening.id}&toCountId=${count.id}`).set(auth(token)).expect(200)).body;
    expect(between.period).toMatchObject({ from: yesterday, to: yesterday });
    expect(between.totals).toEqual(r.totals);
    expect(between.rows.find((x: any) => x.name === 'Chicken breast')).toMatchObject({ opening: '20000.000', closing: '26000.000', actual: '4000.000' });
    // Without a count at the start, the report says so.
    const earlier = (await http.get(`/v1/food-cost?siteId=${site.id}&from=${riyadhDate(-4)}&to=${riyadhDate(-3)}`).set(auth(token)).expect(200)).body;
    expect(earlier.counts.start).toBeNull();
    // A period needs two different counts in order.
    await http.get(`/v1/food-cost?siteId=${site.id}&fromCountId=${count.id}&toCountId=${count.id}`).set(auth(token)).expect(400);
    await http.get(`/v1/food-cost?siteId=${site.id}`).set(auth(token)).expect(400);

    // Who can see it.
    const staff = await invite(token, 'staff', [site.id]);
    await http.get(`/v1/food-cost?siteId=${site.id}&from=${yesterday}&to=${yesterday}`).set(auth(staff)).expect(403);
    const other = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: o.body.legalEntity.id, name: 'Malqa' }).expect(201)).body;
    const manager = await invite(token, 'site_manager', [other.id]);
    await http.get(`/v1/food-cost?siteId=${site.id}&from=${yesterday}&to=${yesterday}`).set(auth(manager)).expect(403);
  });
});
