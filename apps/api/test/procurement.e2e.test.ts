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

async function signup() {
  const res = await http
    .post('/v1/auth/signup')
    .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } })
    .expect(201);
  return { token: res.body.accessToken as string, legalEntityId: res.body.legalEntity.id as string };
}

async function invite(owner: string, roleKey: string, siteIds?: string[]) {
  const roles = await http.get('/v1/roles').set(auth(owner)).expect(200);
  const role = roles.body.find((r: any) => r.key === roleKey);
  const inv = await http.post('/v1/invitations').set(auth(owner)).send({ email: `${uniq()}@t.sa`, roleId: role.id, siteIds }).expect(201);
  return (await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: roleKey }).expect(201)).body.accessToken as string;
}

/** Org with two sites, a supplier selling chicken (1 kg) and tomato (1 kg). */
async function setup() {
  const o = await signup();
  const s1 = (await http.post('/v1/sites').set(auth(o.token)).send({ legalEntityId: o.legalEntityId, name: 'Olaya' }).expect(201)).body;
  const s2 = (await http.post('/v1/sites').set(auth(o.token)).send({ legalEntityId: o.legalEntityId, name: 'Malqa' }).expect(201)).body;
  const chicken = (await http.post('/v1/items').set(auth(o.token)).send({ name: 'Chicken breast' }).expect(201)).body;
  const tomato = (await http.post('/v1/items').set(auth(o.token)).send({ name: 'Tomato' }).expect(201)).body;
  const sup = (await http.post('/v1/suppliers').set(auth(o.token)).send({ displayName: 'Al Watania', displayNameAr: 'الوطنية', contactEmail: 'o@w.sa', contactPhone: '+966500000001' }).expect(201)).body;
  await http.put(`/v1/suppliers/${sup.id}/sites/${s1.id}`).set(auth(o.token)).send({ deliveryDays: [0, 1, 2, 3, 4, 5, 6], leadTimeDays: 1 }).expect(200);
  const lc = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(o.token)).send({ itemId: chicken.id, packId: chicken.packs[0].id, supplierSku: 'CH-1', price: 24.75 }).expect(201)).body;
  const lt = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(o.token)).send({ itemId: tomato.id, packId: tomato.packs[0].id, price: 5.4 }).expect(201)).body;
  return { ...o, s1, s2, chicken, tomato, sup, lc, lt };
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});

describe('purchase orders', () => {
  it('creates, submits, sends and receives an order; stock and average cost follow', async () => {
    const x = await setup();
    const po = await http
      .post('/v1/purchase-orders')
      .set(auth(x.token))
      .send({ siteId: x.s1.id, relationshipId: x.sup.id, lines: [{ supplierItemId: x.lc.id, qty: 3 }, { supplierItemId: x.lt.id, qty: 2 }] })
      .expect(201);
    expect(po.body).toMatchObject({ number: 'PO-00001', status: 'draft', subtotal: '85.05', taxTotal: '12.76', total: '97.81' });
    expect(po.body.deliveryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect((await http.post(`/v1/purchase-orders/${po.body.id}/submit`).set(auth(x.token)).expect(200)).body.status).toBe('approved');
    const sent = await http.post(`/v1/purchase-orders/${po.body.id}/send`).set(auth(x.token)).send({}).expect(200);
    expect(sent.body.status).toBe('sent');
    expect(sent.body.message).toContain('طلب شراء PO-00001');
    expect(sent.body.message).toContain('Chicken breast — 3 × 1 kg (CH-1)');
    expect(sent.body.links.mailto).toContain('mailto:o@w.sa');
    expect(sent.body.links.whatsapp).toContain('https://wa.me/966500000001');

    const detail = (await http.get(`/v1/purchase-orders/${po.body.id}`).set(auth(x.token)).expect(200)).body;
    const chickenLine = detail.lines.find((l: any) => l.itemId === x.chicken.id);
    const tomatoLine = detail.lines.find((l: any) => l.itemId === x.tomato.id);

    // First delivery: 2 of 3 chicken at the ordered price.
    const r1 = await http.post(`/v1/purchase-orders/${po.body.id}/receive`).set(auth(x.token)).send({ lines: [{ lineId: chickenLine.id, qty: 2 }] }).expect(200);
    expect(r1.body.status).toBe('partially_received');
    // Second delivery: last chicken at a higher price, and the tomatoes.
    const r2 = await http
      .post(`/v1/purchase-orders/${po.body.id}/receive`)
      .set(auth(x.token))
      .send({ documentNo: 'INV-77', lines: [{ lineId: chickenLine.id, qty: 1, unitPrice: 27.75 }, { lineId: tomatoLine.id, qty: 2 }] })
      .expect(200);
    expect(r2.body.status).toBe('received');
    expect(r2.body.priceChanges).toHaveLength(1);

    const stock = (await http.get(`/v1/sites/${x.s1.id}/stock`).set(auth(x.token)).expect(200)).body;
    const ch = stock.find((s: any) => s.itemId === x.chicken.id);
    expect(Number(ch.qtyOnHand)).toBe(3000);
    // (2000 g × 0.02475 + 1000 g × 0.02775) / 3000 g = 0.02575 per g
    expect(Number(ch.avgCost)).toBeCloseTo(0.02575, 8);

    // The delivered price became the supplier's price, and Price Watch can see it.
    const changes = (await http.get('/v1/price-changes').set(auth(x.token)).expect(200)).body;
    expect(changes[0]).toMatchObject({ source: 'invoice', price: '27.7500' });
    await http.post(`/v1/purchase-orders/${po.body.id}/receive`).set(auth(x.token)).send({ lines: [{ lineId: chickenLine.id, qty: 1 }] }).expect(400);
  });

  it('holds orders above spend limits for someone else to approve', async () => {
    const x = await setup();
    await http.post('/v1/spend-limits').set(auth(x.token)).send({ period: 'order', amount: 100 }).expect(201);
    const ops = await invite(x.token, 'ops_manager');
    const po = await http
      .post('/v1/purchase-orders')
      .set(auth(ops))
      .send({ siteId: x.s1.id, relationshipId: x.sup.id, submit: true, lines: [{ supplierItemId: x.lc.id, qty: 5 }] })
      .expect(201);
    expect(po.body.status).toBe('pending_approval');
    expect(po.body.approvalReason).toContain('per-order limit of SAR 100.00');
    await http.post(`/v1/purchase-orders/${po.body.id}/send`).set(auth(ops)).send({}).expect(400);
    await http.post(`/v1/purchase-orders/${po.body.id}/approve`).set(auth(ops)).expect(403); // own order
    expect((await http.post(`/v1/purchase-orders/${po.body.id}/approve`).set(auth(x.token)).expect(200)).body.status).toBe('approved');

    // Monthly limit counts approved orders this month.
    await http.post('/v1/spend-limits').set(auth(x.token)).send({ period: 'month', amount: 200, siteId: x.s1.id }).expect(201);
    const small = await http.post('/v1/purchase-orders').set(auth(ops)).send({ siteId: x.s1.id, relationshipId: x.sup.id, submit: true, lines: [{ supplierItemId: x.lt.id, qty: 10 }] }).expect(201);
    expect(small.body.status).toBe('pending_approval');
    expect(small.body.approvalReason).toContain('monthly limit');
  });

  it('limits people to their sites and roles', async () => {
    const x = await setup();
    const mgr = await invite(x.token, 'site_manager', [x.s1.id]);
    const staff = await invite(x.token, 'staff', [x.s1.id]);
    await http.post('/v1/purchase-orders').set(auth(mgr)).send({ siteId: x.s2.id, relationshipId: x.sup.id, lines: [{ supplierItemId: x.lc.id, qty: 1 }] }).expect(403);
    const po = await http.post('/v1/purchase-orders').set(auth(mgr)).send({ siteId: x.s1.id, relationshipId: x.sup.id, submit: true, lines: [{ supplierItemId: x.lc.id, qty: 1 }] }).expect(201);
    await http.post('/v1/purchase-orders').set(auth(staff)).send({ siteId: x.s1.id, relationshipId: x.sup.id, lines: [{ supplierItemId: x.lc.id, qty: 1 }] }).expect(403);
    // Staff can receive deliveries at their site.
    const line = (await http.get(`/v1/purchase-orders/${po.body.id}`).set(auth(staff)).expect(200)).body.lines[0];
    await http.post(`/v1/purchase-orders/${po.body.id}/receive`).set(auth(staff)).send({ lines: [{ lineId: line.id, qty: 1 }] }).expect(200);

    // Another org sees nothing.
    const other = await signup();
    await http.get(`/v1/purchase-orders/${po.body.id}`).set(auth(other.token)).expect(404);
    expect((await http.get('/v1/purchase-orders?status=all').set(auth(other.token)).expect(200)).body).toEqual([]);
  });

  it('edits drafts only, cancels, and sets counted stock', async () => {
    const x = await setup();
    const po = await http.post('/v1/purchase-orders').set(auth(x.token)).send({ siteId: x.s1.id, relationshipId: x.sup.id, lines: [{ supplierItemId: x.lc.id, qty: 1 }] }).expect(201);
    const edited = await http.patch(`/v1/purchase-orders/${po.body.id}`).set(auth(x.token)).send({ lines: [{ supplierItemId: x.lc.id, qty: 4 }], notes: 'Back door' }).expect(200);
    expect(edited.body.total).toBe('113.85');
    await http.post(`/v1/purchase-orders/${po.body.id}/submit`).set(auth(x.token)).expect(200);
    await http.patch(`/v1/purchase-orders/${po.body.id}`).set(auth(x.token)).send({ notes: 'x' }).expect(400);
    expect((await http.post(`/v1/purchase-orders/${po.body.id}/cancel`).set(auth(x.token)).send({ note: 'menu change' }).expect(200)).body.status).toBe('cancelled');

    await http.put(`/v1/items/${x.tomato.id}/sites/${x.s1.id}`).set(auth(x.token)).send({ parLevel: 10000, reorderPoint: 4000 }).expect(200);
    const set = await http.post(`/v1/sites/${x.s1.id}/stock/set`).set(auth(x.token)).send({ itemId: x.tomato.id, qty: 3, unit: 'kg' }).expect(201);
    expect(set.body.qtyOnHand).toBe('3000.000000');
    const stock = (await http.get(`/v1/sites/${x.s1.id}/stock`).set(auth(x.token)).expect(200)).body;
    const t = stock.find((s: any) => s.itemId === x.tomato.id);
    expect(t).toMatchObject({ status: 'low' });
    expect(Number(t.avgCost)).toBeCloseTo(0.0054, 8); // first count valued at the cheapest supplier cost
    const moves = (await http.get(`/v1/sites/${x.s1.id}/stock/movements`).set(auth(x.token)).expect(200)).body;
    expect(moves[0]).toMatchObject({ type: 'opening', qtyBase: '3000.000000' });
  });
});
