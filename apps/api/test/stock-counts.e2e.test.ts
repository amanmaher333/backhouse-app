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

/**
 * Org with one site and three items: chicken (counted in 10 kg cartons), tomato (1 kg
 * pack) and eggs (each, tray of 30). Opening stock: 20 kg chicken at 0.025/g, 10 kg tomato.
 */
async function setup() {
  const o = await http
    .post('/v1/auth/signup')
    .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } })
    .expect(201);
  const token = o.body.accessToken as string;
  const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: o.body.legalEntity.id, name: 'Olaya' }).expect(201)).body;
  const chicken = (await http.post('/v1/items').set(auth(token)).send({ name: 'Chicken breast', nameAr: 'صدر دجاج', baseUnit: 'g', defaultPack: false }).expect(201)).body;
  const carton = (await http.post(`/v1/items/${chicken.id}/packs`).set(auth(token)).send({ name: 'Carton 10 kg', nameAr: 'كرتون 10 كجم', qty: 10, unit: 'kg' }).expect(201)).body;
  const tomato = (await http.post('/v1/items').set(auth(token)).send({ name: 'Tomato', nameAr: 'طماطم' }).expect(201)).body;
  const eggs = (await http.post('/v1/items').set(auth(token)).send({ name: 'Eggs', nameAr: 'بيض', baseUnit: 'each', defaultPack: false }).expect(201)).body;
  const tray = (await http.post(`/v1/items/${eggs.id}/packs`).set(auth(token)).send({ name: 'Tray of 30', nameAr: 'طبق 30', qty: 30, unit: 'each' }).expect(201)).body;
  const sup = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Al Watania', contactEmail: 'o@w.sa' }).expect(201)).body;
  await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(token)).send({ itemId: chicken.id, packId: carton.id, price: 250 }).expect(201);
  await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(token)).send({ itemId: eggs.id, packId: tray.id, price: 15 }).expect(201);
  await http.post(`/v1/sites/${site.id}/stock/set`).set(auth(token)).send({ itemId: chicken.id, qty: 2, packId: carton.id }).expect(201);
  await http.post(`/v1/sites/${site.id}/stock/set`).set(auth(token)).send({ itemId: tomato.id, qty: 10, unit: 'kg' }).expect(201);
  return { token, site, chicken, carton, tomato, eggs, tray, sup };
}

const onHand = async (x: { token: string; site: { id: string } }, itemId: string) =>
  Number((await http.get(`/v1/sites/${x.site.id}/stock`).set(auth(x.token)).expect(200)).body.find((s: any) => s.itemId === itemId).qtyOnHand);

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});

describe('stock counts', () => {
  it('counts by tapping and by text, accounts for deliveries during the count, and posts the variances', async () => {
    const x = await setup();
    const count = (await http.post(`/v1/sites/${x.site.id}/stock-counts`).set(auth(x.token)).send({}).expect(201)).body;
    expect(count).toMatchObject({ ref: 'SC-00001', status: 'open', scope: 'full', blind: true });
    expect(count.lines.map((l: any) => l.name).sort()).toEqual(['Chicken breast', 'Eggs', 'Tomato']);
    expect(count.lines.find((l: any) => l.itemId === x.chicken.id).packs).toEqual([expect.objectContaining({ id: x.carton.id, baseQty: '10000.000000' })]);

    // Typed or said, in Arabic and English: only show what was understood.
    const preview = (await http.post(`/v1/stock-counts/${count.id}/entries`).set(auth(x.token)).send({ text: 'دجاج ١٫٥ كرتون، tomatoes 9 kg, eggs, saffron 2 g' }).expect(200)).body;
    expect(preview.entries.map((e: any) => [e.itemName, e.qty, e.problem])).toEqual([
      ['Chicken breast', '1.5', null],
      ['Tomato', '9', null],
      ['Eggs', null, 'no_qty'],
      [null, '2', 'no_item'],
    ]);
    expect(preview.recorded).toBe(0);
    // Apply: the clear ones are recorded.
    const applied = (await http.post(`/v1/stock-counts/${count.id}/entries`).set(auth(x.token)).send({ text: 'دجاج ١٫٥ كرتون، tomatoes 9 kg', apply: true }).expect(200)).body;
    expect(applied).toMatchObject({ recorded: 2, unclear: 0 });

    // A delivery of 1 carton arrives after the chicken was counted, before the eggs were.
    const po = (await http.post('/v1/purchase-orders').set(auth(x.token)).send({ siteId: x.site.id, relationshipId: x.sup.id, submit: true, lines: [{ itemId: x.chicken.id, packId: x.carton.id, qty: 1 }] }).expect(201)).body;
    await http.post(`/v1/purchase-orders/${po.id}/send`).set(auth(x.token)).send({ via: 'manual' }).expect(200);
    const poDetail = (await http.get(`/v1/purchase-orders/${po.id}`).set(auth(x.token)).expect(200)).body;
    await http.post(`/v1/purchase-orders/${po.id}/receive`).set(auth(x.token)).send({ lines: [{ lineId: poDetail.lines[0].id, qty: 1 }] }).expect(200);
    expect(await onHand(x, x.chicken.id)).toBe(30000);

    // Eggs counted in trays plus a few loose ones, in two places.
    await http.patch(`/v1/stock-counts/${count.id}/lines`).set(auth(x.token)).send({ lines: [{ itemId: x.eggs.id, qty: 2, packId: x.tray.id }] }).expect(200);
    const afterEggs = (await http.patch(`/v1/stock-counts/${count.id}/lines`).set(auth(x.token)).send({ lines: [{ itemId: x.eggs.id, qty: 5, mode: 'add' }] }).expect(200)).body;
    const eggLine = afterEggs.lines.find((l: any) => l.itemId === x.eggs.id);
    expect(eggLine).toMatchObject({ countedQty: '65.000000', expectedQty: '0.000000' });

    const submitted = (await http.post(`/v1/stock-counts/${count.id}/submit`).set(auth(x.token)).expect(200)).body;
    expect(submitted.status).toBe('submitted');
    const line = (id: string) => submitted.lines.find((l: any) => l.itemId === id);
    // Chicken: 20 kg expected when counted, 15 kg counted → −5 kg at 0.025/g = −125.00 (the later delivery doesn't count).
    expect(line(x.chicken.id)).toMatchObject({ expectedQty: '20000.000000', countedQty: '15000.000000', adjustmentQty: '-5000.000000', varianceValue: '-125.00' });
    // Tomato has no cost history: −1 kg, value 0.
    expect(line(x.tomato.id)).toMatchObject({ adjustmentQty: '-1000.000000', varianceValue: '0.00' });
    // Eggs: +65 at the supplier's 0.5 each.
    expect(line(x.eggs.id)).toMatchObject({ adjustmentQty: '65.000000', varianceValue: '32.50' });
    expect(submitted).toMatchObject({ varianceValue: '-92.50', absVarianceValue: '157.50', needsApproval: false });

    await http.patch(`/v1/stock-counts/${count.id}/lines`).set(auth(x.token)).send({ lines: [{ itemId: x.eggs.id, qty: 1 }] }).expect(400);
    const posted = (await http.post(`/v1/stock-counts/${count.id}/post`).set(auth(x.token)).expect(200)).body;
    expect(posted.status).toBe('posted');
    // 30 kg on hand − 5 kg = 25 kg (the delivery during the count is kept).
    expect(await onHand(x, x.chicken.id)).toBe(25000);
    expect(await onHand(x, x.tomato.id)).toBe(9000);
    expect(await onHand(x, x.eggs.id)).toBe(65);
    const stock = (await http.get(`/v1/sites/${x.site.id}/stock`).set(auth(x.token)).expect(200)).body;
    expect(Number(stock.find((s: any) => s.itemId === x.eggs.id).avgCost)).toBeCloseTo(0.5, 8);
    const moves = (await http.get(`/v1/sites/${x.site.id}/stock/movements?itemId=${x.chicken.id}`).set(auth(x.token)).expect(200)).body;
    expect(moves[0]).toMatchObject({ type: 'adjustment', qtyBase: '-5000.000000', sourceType: 'stock_count', sourceId: count.id, note: 'SC-00001' });

    // Posted is final.
    await http.post(`/v1/stock-counts/${count.id}/reopen`).set(auth(x.token)).expect(400);
    await http.post(`/v1/stock-counts/${count.id}/cancel`).set(auth(x.token)).send({}).expect(400);
    const list = (await http.get(`/v1/stock-counts?siteId=${x.site.id}`).set(auth(x.token)).expect(200)).body;
    expect(list[0]).toMatchObject({ ref: 'SC-00001', status: 'posted', lines: 3, counted: 3 });
  });

  it('keeps counts blind for counters and needs someone else to approve large variances', async () => {
    const x = await setup();
    const staff = await invite(x.token, 'staff', [x.site.id]);
    const manager = await invite(x.token, 'site_manager', [x.site.id]);
    const count = (await http.post(`/v1/sites/${x.site.id}/stock-counts`).set(auth(staff)).send({ scope: 'partial', itemIds: [x.chicken.id] }).expect(201)).body;
    expect(count.lines).toHaveLength(1);
    expect(count.expectedVisible).toBe(false);
    expect(count.lines[0].expectedQty).toBeUndefined();
    expect(count.lines[0].snapshotQty).toBeUndefined();

    // Staff counts 1 carton (and adds tomatoes on the fly); the manager can see the expected quantity.
    await http.patch(`/v1/stock-counts/${count.id}/lines`).set(auth(staff)).send({ lines: [{ itemId: x.chicken.id, qty: 1, packId: x.carton.id }, { itemId: x.tomato.id, qty: 10, unit: 'kg' }] }).expect(200);
    const seen = (await http.get(`/v1/stock-counts/${count.id}`).set(auth(manager)).expect(200)).body;
    expect(seen.expectedVisible).toBe(true);
    expect(seen.lines.find((l: any) => l.itemId === x.chicken.id)).toMatchObject({ expectedQty: '20000.000000', adjustmentQty: '-10000.000000' });

    // −10 kg × 0.025 = −250.00, over a limit of 100.
    expect((await http.patch('/v1/settings/stock-counts').set(auth(x.token)).send({ countApprovalValue: 100 }).expect(200)).body).toEqual({ countApprovalValue: 100 });
    await http.patch('/v1/settings/stock-counts').set(auth(manager)).send({ countApprovalValue: 1e6 }).expect(403);
    const submitted = (await http.post(`/v1/stock-counts/${count.id}/submit`).set(auth(staff)).expect(200)).body;
    expect(submitted).toMatchObject({ status: 'submitted', expectedVisible: true, needsApproval: true });
    await http.post(`/v1/stock-counts/${count.id}/post`).set(auth(staff)).expect(403); // no stock:approve

    // Reopen, recount as the manager, resubmit: the manager counted it, so can't approve it.
    await http.post(`/v1/stock-counts/${count.id}/reopen`).set(auth(manager)).expect(200);
    await http.patch(`/v1/stock-counts/${count.id}/lines`).set(auth(manager)).send({ lines: [{ itemId: x.chicken.id, qty: 0.5, packId: x.carton.id }] }).expect(200);
    const again = (await http.post(`/v1/stock-counts/${count.id}/submit`).set(auth(manager)).expect(200)).body;
    expect(again).toMatchObject({ varianceValue: '-375.00', absVarianceValue: '375.00', needsApproval: true });
    await http.post(`/v1/stock-counts/${count.id}/post`).set(auth(manager)).expect(403);
    const ops = await invite(x.token, 'ops_manager');
    expect((await http.post(`/v1/stock-counts/${count.id}/post`).set(auth(ops)).expect(200)).body.status).toBe('posted');
    expect(await onHand(x, x.chicken.id)).toBe(5000);
  });

  it('needs approval above the default limit, cancels, and keeps other sites out', async () => {
    const x = await setup();
    const count = (await http.post(`/v1/sites/${x.site.id}/stock-counts`).set(auth(x.token)).send({ scope: 'partial', itemIds: [x.chicken.id] }).expect(201)).body;
    const staff = await invite(x.token, 'staff', [x.site.id]);
    // Counted nothing: 0 vs 20 kg = −500.00; add 1 more egg tray to push it over 500.
    await http.patch(`/v1/stock-counts/${count.id}/lines`).set(auth(staff)).send({ lines: [{ itemId: x.chicken.id, qty: 0, unit: 'kg' }, { itemId: x.eggs.id, qty: 1, packId: x.tray.id }] }).expect(200);
    const submitted = (await http.post(`/v1/stock-counts/${count.id}/submit`).set(auth(staff)).expect(200)).body;
    expect(submitted).toMatchObject({ needsApproval: true });
    expect(submitted.absVarianceValue).toBeUndefined(); // staff don't see costs
    expect((await http.get(`/v1/stock-counts/${count.id}`).set(auth(x.token)).expect(200)).body).toMatchObject({ absVarianceValue: '515.00' });
    await http.post(`/v1/stock-counts/${count.id}/post`).set(auth(staff)).expect(403);

    // Someone at another site can't see or touch it.
    const other = (await http.post('/v1/sites').set(auth(x.token)).send({ legalEntityId: (await http.get('/v1/legal-entities').set(auth(x.token))).body[0].id, name: 'Malqa' }).expect(201)).body;
    const elsewhere = await invite(x.token, 'site_manager', [other.id]);
    await http.get(`/v1/stock-counts/${count.id}`).set(auth(elsewhere)).expect(403);
    expect((await http.get('/v1/stock-counts').set(auth(elsewhere)).expect(200)).body).toEqual([]);
    await http.post(`/v1/sites/${x.site.id}/stock-counts`).set(auth(elsewhere)).send({}).expect(403);

    const cancelled = (await http.post(`/v1/stock-counts/${count.id}/cancel`).set(auth(x.token)).send({ note: 'wrong freezer' }).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(cancelled.note).toContain('wrong freezer');
    await http.post(`/v1/stock-counts/${count.id}/post`).set(auth(x.token)).expect(400);
    expect(await onHand(x, x.chicken.id)).toBe(20000);
    await http.post(`/v1/sites/${x.site.id}/stock-counts`).set(auth(x.token)).send({ scope: 'partial' }).expect(400);
  });
});
