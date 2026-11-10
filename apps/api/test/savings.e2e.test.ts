import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { ubl, vat } from './invoice-fixtures.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const b64 = (s: string) => Buffer.from(s).toString('base64');
let app: INestApplication;
let http: ReturnType<typeof request>;
let runtime: AgentRuntime;

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
  runtime = app.get(AgentRuntime);
});
afterAll(async () => {
  await app?.close();
});

describe('Savings', () => {
  it('adds up credit notes, duplicates stopped and cheaper suppliers, and keeps open claims apart', async () => {
    const o = (await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } }).expect(201)).body;
    const token = o.accessToken as string;
    const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: o.legalEntity.id, name: 'Olaya' }).expect(201)).body;

    // Nothing yet: zero, not an error.
    const empty = (await http.get('/v1/savings').set(auth(token)).expect(200)).body;
    expect(empty.totals).toMatchObject({ saved: '0.00', inProgress: '0.00', cost: '0.00', multiple: null });
    expect(empty.entries).toEqual([]);

    // Invoices: a supplier with chicken; three orders received.
    const supplierVat = vat();
    const chicken = (await http.post('/v1/items').set(auth(token)).send({ name: 'Chicken breast' }).expect(201)).body;
    const wafra = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Al Wafra Foods', displayNameAr: 'الوفرة للأغذية', vatNumber: supplierVat, contactEmail: 'sales@wafra.sa' }).expect(201)).body;
    const lc = (await http.post(`/v1/suppliers/${wafra.id}/items`).set(auth(token)).send({ itemId: chicken.id, packId: chicken.packs[0].id, supplierSku: 'CH-1', price: 24.75 }).expect(201)).body;
    const order = async () => {
      const po = (await http.post('/v1/purchase-orders').set(auth(token)).send({ siteId: site.id, relationshipId: wafra.id, lines: [{ supplierItemId: lc.id, qty: 4 }], submit: true }).expect(201)).body;
      const line = (await http.get(`/v1/purchase-orders/${po.id}`).set(auth(token)).expect(200)).body.lines[0];
      await http.post(`/v1/purchase-orders/${po.id}/receive`).set(auth(token)).send({ lines: [{ lineId: line.id, qty: 4 }] }).expect(200);
      return po;
    };
    const upload = async (xml: string) => (await http.post('/v1/supplier-invoices/upload').set(auth(token)).send({ filename: 'i.xml', contentType: 'application/xml', data: b64(xml) }).expect(201)).body;

    // 1. Charged 2.50 more per kilo: disputed (11.50 with VAT), and the supplier sends a credit note.
    const po1 = await order();
    const over = await upload(ubl({ number: 'INV-1', supplierVat, po: po1.number, lines: [{ name: 'Chicken', sku: 'CH-1', qty: 4, price: 27.25 }] }));
    expect(over.claimTotal).toBe('11.50');
    await http.post(`/v1/supplier-invoices/${over.id}/dispute`).set(auth(token)).send({}).expect(200);
    await upload(ubl({ number: 'CN-1', supplierVat, type: '381', billingRef: 'INV-1', lines: [{ name: 'Price correction', qty: 4, price: 2.5 }] }));

    // 2. The same invoice sent twice: the copy is rejected.
    const po2 = await order();
    const exact = (n: string, desc = 'Chicken') => ubl({ number: n, supplierVat, po: po2.number, lines: [{ name: desc, sku: 'CH-1', qty: 4, price: 24.75 }] });
    await upload(exact('INV-2'));
    const dup = await upload(exact('INV-2', 'Chicken breast'));
    expect(dup.match.discrepancies.map((d: any) => d.kind)).toContain('duplicate');
    await http.post(`/v1/supplier-invoices/${dup.id}/reject`).set(auth(token)).send({ reason: 'Duplicate' }).expect(200);

    // 3. Another overcharge disputed, no credit note yet: in progress, not saved.
    const po3 = await order();
    const open = await upload(ubl({ number: 'INV-3', supplierVat, po: po3.number, lines: [{ name: 'Chicken', sku: 'CH-1', qty: 4, price: 27.25 }] }));
    await http.post(`/v1/supplier-invoices/${open.id}/dispute`).set(auth(token)).send({}).expect(200);

    // 4. Price Watch: tomatoes go up 20% at Fresh Farms; switch to Green Valley (11.1% less), then buy 10 there.
    const tomato = (await http.post('/v1/items').set(auth(token)).send({ name: 'Tomato' }).expect(201)).body;
    const ff = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Fresh Farms', contactEmail: 'o@ff.sa' }).expect(201)).body;
    const gv = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Green Valley', contactEmail: 's@gv.sa' }).expect(201)).body;
    const la = (await http.post(`/v1/suppliers/${ff.id}/items`).set(auth(token)).send({ itemId: tomato.id, packId: tomato.packs[0].id, price: 4.5, isPreferred: true }).expect(201)).body;
    const lb = (await http.post(`/v1/suppliers/${gv.id}/items`).set(auth(token)).send({ itemId: tomato.id, packId: tomato.packs[0].id, price: 4.8 }).expect(201)).body;
    const agentId = (await http.post('/v1/agents').set(auth(token)).send({ kind: 'price_watch' }).expect(201)).body.agent.id;
    await http.post(`/v1/supplier-items/${la.id}/prices`).set(auth(token)).send({ price: 5.4 }).expect(201);
    await runtime.run(agentId, 'event');
    const task = (await http.get('/v1/agent-tasks').set(auth(token)).expect(200)).body.find((t: any) => t.kind === 'price_rise');
    expect(task.actions.find((a: any) => a.id === 'switch').params.savingPct).toBe(11.1);
    await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(token)).send({ actionId: 'switch' }).expect(200);
    const po4 = (await http.post('/v1/purchase-orders').set(auth(token)).send({ siteId: site.id, relationshipId: gv.id, lines: [{ supplierItemId: lb.id, qty: 10 }], submit: true }).expect(201)).body;
    const l4 = (await http.get(`/v1/purchase-orders/${po4.id}`).set(auth(token)).expect(200)).body.lines[0];
    await http.post(`/v1/purchase-orders/${po4.id}/receive`).set(auth(token)).send({ lines: [{ lineId: l4.id, qty: 10 }] }).expect(200);

    const r = (await http.get('/v1/savings').set(auth(token)).expect(200)).body;
    // 48.00 paid at Green Valley; at Fresh Farms' price it would have been 48 / (1 − 0.111) = 53.99.
    const switchSaved = '5.99';
    const total = (11.5 + Number(dup.total) + 5.99).toFixed(2);
    expect(r.currency).toBe('SAR');
    expect(r.totals).toMatchObject({ saved: total, inProgress: '11.50', cost: '0.00', multiple: null });
    expect(r.totals.byKind).toMatchObject({
      credit_note: { amount: '11.50', count: 1 },
      duplicate: { amount: dup.total, count: 1 },
      supplier_switch: { amount: switchSaved, count: 1 },
      claim_open: { amount: '11.50', count: 1 },
    });
    expect(r.entries.find((e: any) => e.kind === 'credit_note')).toMatchObject({ amount: '11.50', supplier: { name: 'Al Wafra Foods' }, subject: { type: 'invoice', id: over.id }, detail: { claim: '11.50' } });
    expect(r.entries.find((e: any) => e.kind === 'supplier_switch')).toMatchObject({ supplier: { name: 'Green Valley' }, subject: { type: 'item', id: tomato.id, label: 'Tomato' }, detail: { spend: '48.00', savingPct: 11.1 } });
    // Open claims come last.
    expect(r.entries.at(-1)).toMatchObject({ kind: 'claim_open', subject: { id: open.id } });

    // On trial: savings since it started, against the monthly price of the plan.
    expect(r.trial).toMatchObject({ saved: total, daysLeft: expect.any(Number) });
    expect(Number(r.trial.monthlyPrice)).toBeGreaterThan(0);
    expect(r.totals.planMonthly).toBe(r.trial.monthlyPrice);

    // A month long ago: nothing saved, but the open claim still shows.
    const old = (await http.get('/v1/savings?from=2025-01-01&to=2025-01-31').set(auth(token)).expect(200)).body;
    expect(old.totals).toMatchObject({ saved: '0.00', inProgress: '11.50' });
    expect(old.period).toEqual({ from: '2025-01-01', to: '2025-01-31' });
    await http.get('/v1/savings?from=2025-02-01&to=2025-01-01').set(auth(token)).expect(400);

    // Money figures need price:read.
    const roles = (await http.get('/v1/roles').set(auth(token)).expect(200)).body;
    const staff = roles.find((x: any) => x.key === 'staff');
    const inv = (await http.post('/v1/invitations').set(auth(token)).send({ email: `${uniq()}@t.sa`, roleId: staff.id, siteIds: [site.id] }).expect(201)).body;
    const st = (await http.post('/v1/auth/accept-invitation').send({ token: inv.token, password: PASSWORD, fullName: 'Staff' }).expect(201)).body.accessToken;
    await http.get('/v1/savings').set(auth(st)).expect(403);
  });
});
