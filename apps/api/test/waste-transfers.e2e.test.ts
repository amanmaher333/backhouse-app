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

/** A central kitchen and a branch; chicken (10 kg cartons) at 0.025/g, 30 kg in the kitchen; tomato with no cost history. */
async function setup() {
  const o = await http
    .post('/v1/auth/signup')
    .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } })
    .expect(201);
  const token = o.body.accessToken as string;
  const kitchen = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: o.body.legalEntity.id, name: 'Central kitchen', type: 'central_kitchen' }).expect(201)).body;
  const branch = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: o.body.legalEntity.id, name: 'Olaya' }).expect(201)).body;
  const chicken = (await http.post('/v1/items').set(auth(token)).send({ name: 'Chicken breast', nameAr: 'صدر دجاج', baseUnit: 'g', defaultPack: false }).expect(201)).body;
  const carton = (await http.post(`/v1/items/${chicken.id}/packs`).set(auth(token)).send({ name: 'Carton 10 kg', nameAr: 'كرتون 10 كجم', qty: 10, unit: 'kg' }).expect(201)).body;
  const tomato = (await http.post('/v1/items').set(auth(token)).send({ name: 'Tomato', nameAr: 'طماطم' }).expect(201)).body;
  const sup = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Al Watania', contactEmail: 'o@w.sa' }).expect(201)).body;
  await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(token)).send({ itemId: chicken.id, packId: carton.id, price: 250 }).expect(201);
  await http.post(`/v1/sites/${kitchen.id}/stock/set`).set(auth(token)).send({ itemId: chicken.id, qty: 3, packId: carton.id }).expect(201);
  await http.post(`/v1/sites/${kitchen.id}/stock/set`).set(auth(token)).send({ itemId: tomato.id, qty: 10, unit: 'kg' }).expect(201);
  return { token, kitchen, branch, chicken, carton, tomato };
}

const stockAt = async (token: string, siteId: string, itemId: string) => {
  const row = (await http.get(`/v1/sites/${siteId}/stock`).set(auth(token)).expect(200)).body.find((s: any) => s.itemId === itemId);
  return { qty: Number(row.qtyOnHand), avgCost: Number(row.avgCost ?? 0) };
};

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});

describe('waste', () => {
  it('records waste by tap and by text, values it, summarises it and voids mistakes', async () => {
    const x = await setup();
    const rec = (await http.post(`/v1/sites/${x.kitchen.id}/waste`).set(auth(x.token)).send({ entries: [{ itemId: x.chicken.id, qty: 2, unit: 'kg', reason: 'expired', note: 'back of the walk-in' }] }).expect(201)).body;
    expect(rec[0]).toMatchObject({ qtyBase: '2000.000000', reason: 'expired', value: '50.00', unitCost: '0.02500000' });
    expect((await stockAt(x.token, x.kitchen.id, x.chicken.id)).qty).toBe(28000);

    // Typed or said: preview, then record. Tomato has no cost: value 0, still taken off stock.
    const preview = (await http.post(`/v1/sites/${x.kitchen.id}/waste/read`).set(auth(x.token)).send({ text: 'دجاج ١ كيلو طاح، طماطم ٢ كيلو تالف، saffron 2 g' }).expect(200)).body;
    expect(preview.entries.map((e: any) => [e.itemName, e.qty, e.reason, e.problem])).toEqual([
      ['Chicken breast', '1', 'dropped', null],
      ['Tomato', '2', 'spoiled', null],
      [null, '2', null, 'no_item'],
    ]);
    const applied = (await http.post(`/v1/sites/${x.kitchen.id}/waste/read`).set(auth(x.token)).send({ text: 'دجاج ١ كيلو طاح، طماطم ٢ كيلو تالف، tomato 1 kg', apply: true }).expect(200)).body;
    expect(applied).toMatchObject({ recorded: 3, value: '25.00', unclear: 0 });
    expect((await stockAt(x.token, x.kitchen.id, x.tomato.id)).qty).toBe(7000);

    const list = (await http.get(`/v1/waste?siteId=${x.kitchen.id}`).set(auth(x.token)).expect(200)).body;
    expect(list).toHaveLength(4);
    expect(list.find((w: any) => w.reason === 'other')).toMatchObject({ itemName: 'Tomato', entryText: 'tomato 1 kg' });
    const summary = (await http.get(`/v1/waste/summary?siteId=${x.kitchen.id}`).set(auth(x.token)).expect(200)).body;
    expect(summary).toMatchObject({ total: '75.00', entries: 4 });
    expect(summary.byReason[0]).toMatchObject({ reason: 'expired', value: '50.00' });
    expect(summary.topItems[0]).toMatchObject({ name: 'Chicken breast', qtyBase: '3000.000000', value: '75.00' });

    // Staff record waste and can void their own entry; someone else's needs stock:approve.
    const staff = await invite(x.token, 'staff', [x.kitchen.id]);
    const mine = (await http.post(`/v1/sites/${x.kitchen.id}/waste`).set(auth(staff)).send({ entries: [{ itemId: x.chicken.id, qty: 1, packId: x.carton.id, reason: 'damaged' }] }).expect(201)).body[0];
    expect(mine.value).toBeUndefined(); // staff don't see costs
    expect((await stockAt(x.token, x.kitchen.id, x.chicken.id)).qty).toBe(17000);
    await http.post(`/v1/waste/${rec[0].id}/void`).set(auth(staff)).send({ reason: 'not mine' }).expect(403);
    await http.post(`/v1/waste/${mine.id}/void`).set(auth(staff)).send({ reason: 'typed cartons, meant kg' }).expect(200);
    await http.post(`/v1/waste/${mine.id}/void`).set(auth(staff)).send({ reason: 'again' }).expect(400);
    const after = await stockAt(x.token, x.kitchen.id, x.chicken.id);
    expect(after.qty).toBe(27000);
    expect(after.avgCost).toBeCloseTo(0.025, 8);
    expect((await http.get(`/v1/waste?siteId=${x.kitchen.id}`).set(auth(x.token)).expect(200)).body).toHaveLength(4);
    expect((await http.get(`/v1/waste?siteId=${x.kitchen.id}&includeVoided=true`).set(auth(x.token)).expect(200)).body).toHaveLength(5);

    // Other sites are out of reach.
    await http.post(`/v1/sites/${x.branch.id}/waste`).set(auth(staff)).send({ entries: [{ itemId: x.chicken.id, qty: 1, unit: 'kg', reason: 'other' }] }).expect(403);
    expect((await http.get(`/v1/waste?siteId=${x.branch.id}`).set(auth(staff))).status).toBe(403);
  });
});

describe('transfers', () => {
  it('moves stock and its value between sites, with shortages recorded on receipt', async () => {
    const x = await setup();
    const t = (await http
      .post('/v1/stock-transfers')
      .set(auth(x.token))
      .send({ fromSiteId: x.kitchen.id, toSiteId: x.branch.id, lines: [{ itemId: x.chicken.id, qty: 2, packId: x.carton.id }, { itemId: x.tomato.id, qty: 4, unit: 'kg' }] })
      .expect(201)).body;
    expect(t).toMatchObject({ ref: 'TR-00001', status: 'draft', fromName: 'Central kitchen', toName: 'Olaya', canSend: true, canReceive: true });
    await http.post(`/v1/stock-transfers/${t.id}/receive`).set(auth(x.token)).send({}).expect(400); // not sent
    await http.patch(`/v1/stock-transfers/${t.id}`).set(auth(x.token)).send({ lines: [{ itemId: x.chicken.id, qty: 2, packId: x.carton.id }, { itemId: x.tomato.id, qty: 5, unit: 'kg' }] }).expect(200);

    const sent = (await http.post(`/v1/stock-transfers/${t.id}/send`).set(auth(x.token)).expect(200)).body;
    expect(sent).toMatchObject({ status: 'sent', value: '500.00' });
    expect((await stockAt(x.token, x.kitchen.id, x.chicken.id)).qty).toBe(10000);
    await http.patch(`/v1/stock-transfers/${t.id}`).set(auth(x.token)).send({ note: 'x' }).expect(400);

    // The branch receives 1.5 cartons of chicken (half a carton short) and all the tomatoes.
    const chickenLine = sent.lines.find((l: any) => l.itemId === x.chicken.id);
    const received = (await http.post(`/v1/stock-transfers/${t.id}/receive`).set(auth(x.token)).send({ lines: [{ lineId: chickenLine.id, qty: 1.5, packId: x.carton.id }], note: 'one carton torn' }).expect(200)).body;
    expect(received).toMatchObject({ status: 'received', shortValue: '125.00' });
    expect(received.lines.find((l: any) => l.itemId === x.chicken.id)).toMatchObject({ qtyBase: '20000.000000', receivedQty: '15000.000000' });
    const atBranch = await stockAt(x.token, x.branch.id, x.chicken.id);
    expect(atBranch.qty).toBe(15000);
    expect(atBranch.avgCost).toBeCloseTo(0.025, 8); // value moved with the stock
    expect((await stockAt(x.token, x.branch.id, x.tomato.id)).qty).toBe(5000);
    expect((await stockAt(x.token, x.kitchen.id, x.tomato.id)).qty).toBe(5000);
    const moves = (await http.get(`/v1/sites/${x.branch.id}/stock/movements?itemId=${x.chicken.id}`).set(auth(x.token)).expect(200)).body;
    expect(moves[0]).toMatchObject({ type: 'transfer_in', qtyBase: '15000.000000', sourceType: 'transfer', note: 'TR-00001' });

    await http.post(`/v1/stock-transfers/${t.id}/cancel`).set(auth(x.token)).send({}).expect(400);
    const list = (await http.get(`/v1/stock-transfers?siteId=${x.branch.id}&direction=in`).set(auth(x.token)).expect(200)).body;
    expect(list[0]).toMatchObject({ ref: 'TR-00001', status: 'received', lines: 2 });
    expect((await http.get(`/v1/stock-transfers?siteId=${x.branch.id}&direction=out`).set(auth(x.token)).expect(200)).body).toEqual([]);
  });

  it('only the source sends and only the destination receives; cancelling a sent transfer puts stock back', async () => {
    const x = await setup();
    const kitchenStaff = await invite(x.token, 'staff', [x.kitchen.id]);
    const branchManager = await invite(x.token, 'site_manager', [x.branch.id]);
    await http.post('/v1/stock-transfers').set(auth(branchManager)).send({ fromSiteId: x.kitchen.id, toSiteId: x.branch.id, lines: [{ itemId: x.chicken.id, qty: 1, packId: x.carton.id }] }).expect(403);
    await http.post('/v1/stock-transfers').set(auth(kitchenStaff)).send({ fromSiteId: x.kitchen.id, toSiteId: x.kitchen.id, lines: [{ itemId: x.chicken.id, qty: 1, unit: 'kg' }] }).expect(400);
    const t = (await http.post('/v1/stock-transfers').set(auth(kitchenStaff)).send({ fromSiteId: x.kitchen.id, toSiteId: x.branch.id, send: true, lines: [{ itemId: x.chicken.id, qty: 1, packId: x.carton.id }] }).expect(201)).body;
    expect(t).toMatchObject({ status: 'sent', canSend: true, canReceive: false });
    expect(t.value).toBeUndefined();
    await http.post(`/v1/stock-transfers/${t.id}/receive`).set(auth(kitchenStaff)).send({}).expect(403);
    // The branch manager sees it coming in.
    const seen = (await http.get(`/v1/stock-transfers/${t.id}`).set(auth(branchManager)).expect(200)).body;
    expect(seen).toMatchObject({ canSend: false, canReceive: true });
    expect((await http.get('/v1/stock-transfers?status=active').set(auth(branchManager)).expect(200)).body).toHaveLength(1);
    await http.post(`/v1/stock-transfers/${t.id}/cancel`).set(auth(branchManager)).send({}).expect(403);

    expect((await stockAt(x.token, x.kitchen.id, x.chicken.id)).qty).toBe(20000);
    const cancelled = (await http.post(`/v1/stock-transfers/${t.id}/cancel`).set(auth(kitchenStaff)).send({ note: 'van broke down' }).expect(200)).body;
    expect(cancelled.status).toBe('cancelled');
    const back = await stockAt(x.token, x.kitchen.id, x.chicken.id);
    expect(back.qty).toBe(30000);
    expect(back.avgCost).toBeCloseTo(0.025, 8);
    await http.post(`/v1/stock-transfers/${t.id}/receive`).set(auth(branchManager)).send({}).expect(400);
  });
});
