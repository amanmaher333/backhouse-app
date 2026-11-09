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
let app: INestApplication;
let http: ReturnType<typeof request>;
let runtime: AgentRuntime;

async function invite(owner: string, roleKey: string, siteIds?: string[]) {
  const roles = await http.get('/v1/roles').set(auth(owner)).expect(200);
  const role = roles.body.find((r: any) => r.key === roleKey);
  const inv = await http.post('/v1/invitations').set(auth(owner)).send({ email: `${uniq()}@t.sa`, roleId: role.id, siteIds }).expect(201);
  return (await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: roleKey }).expect(201)).body.accessToken as string;
}

/** A received order for 4 chicken (24.75) + 10 tomatoes (5.40) from Al Wafra, and the Invoice agent hired. */
async function setup() {
  const s = await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } }).expect(201);
  const token = s.body.accessToken as string;
  const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: s.body.legalEntity.id, name: 'Olaya', nameAr: 'العليا' }).expect(201)).body;
  const chicken = (await http.post('/v1/items').set(auth(token)).send({ name: 'Chicken breast' }).expect(201)).body;
  const tomato = (await http.post('/v1/items').set(auth(token)).send({ name: 'Tomato' }).expect(201)).body;
  const supplierVat = vat();
  const sup = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Al Wafra Foods', displayNameAr: 'الوفرة للأغذية', vatNumber: supplierVat, contactEmail: 'sales@wafra.sa' }).expect(201)).body;
  const lc = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(token)).send({ itemId: chicken.id, packId: chicken.packs[0].id, supplierSku: 'CH-1', price: 24.75 }).expect(201)).body;
  const lt = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(token)).send({ itemId: tomato.id, packId: tomato.packs[0].id, price: 5.4 }).expect(201)).body;
  const po = (await http.post('/v1/purchase-orders').set(auth(token)).send({ siteId: site.id, relationshipId: sup.id, lines: [{ supplierItemId: lc.id, qty: 4 }, { supplierItemId: lt.id, qty: 10 }], submit: true }).expect(201)).body;
  const detail = (await http.get(`/v1/purchase-orders/${po.id}`).set(auth(token)).expect(200)).body;
  await http.post(`/v1/purchase-orders/${po.id}/receive`).set(auth(token)).send({ lines: detail.lines.map((l: any) => ({ lineId: l.id, qty: Number(l.qty) })) }).expect(200);
  const agent = (await http.post('/v1/agents').set(auth(token)).send({ kind: 'invoice' }).expect(201)).body;
  return { token, site, sup, supplierVat, po, agentId: agent.agent.id as string, agentUserId: agent.agent.userId as string, firstRun: agent.firstRun };
}

const upload = (token: string, xml: string) =>
  http.post('/v1/supplier-invoices/upload').set(auth(token)).send({ filename: 'inv.xml', contentType: 'application/xml', data: Buffer.from(xml).toString('base64') }).expect(201);
const invoiceXml = (x: Awaited<ReturnType<typeof setup>>, number: string, chickenPrice = 24.75) =>
  ubl({ number, supplierVat: x.supplierVat, po: x.po.number, lines: [{ name: 'Chicken breast', sku: 'CH-1', qty: 4, price: chickenPrice }, { name: 'Tomato', qty: 10, price: 5.4 }] });
const openTasks = async (token: string) => (await http.get('/v1/agent-tasks').set(auth(token)).expect(200)).body as any[];

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

describe('Invoice agent', () => {
  it('is offered for hire and starts with nothing to do', async () => {
    const x = await setup();
    expect(x.firstRun).toMatchObject({ status: 'succeeded', tasksCreated: 0 });
    const list = (await http.get('/v1/agents').set(auth(x.token)).expect(200)).body;
    expect(list.available.map((a: any) => a.kind)).toContain('invoice');
  });

  it('proposes approving a matching invoice, and approves it when a person agrees', async () => {
    const x = await setup();
    const inv = (await upload(x.token, invoiceXml(x, 'INV-1'))).body;
    expect(await runtime.run(x.agentId, 'event')).toMatchObject({ tasksCreated: 1 });
    const [task] = await openTasks(x.token);
    expect(task).toMatchObject({ kind: 'invoice_approve', subjectKey: `invoice:${inv.id}`, title: 'Approve invoice INV-1 from Al Wafra Foods: SAR 175.95', titleAr: expect.stringContaining('الوفرة للأغذية') });
    expect(task.evidence).toMatchObject({ ref: inv.ref, poNumber: x.po.number, total: '175.95', site: { name: 'Olaya' } });

    // Site managers decide tasks, but approving invoices for payment is for finance.
    const mgr = await invite(x.token, 'site_manager', [x.site.id]);
    await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(mgr)).send({ actionId: 'approve' }).expect(403);

    const done = (await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(x.token)).send({ actionId: 'approve' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'executed', result: { status: 'approved', ref: inv.ref } });
    expect((await http.get(`/v1/supplier-invoices/${inv.id}`).set(auth(x.token))).body.status).toBe('approved');
    await runtime.run(x.agentId, 'event');
    expect(await openTasks(x.token)).toEqual([]);
  });

  it('asks for a credit note when the invoice overcharges, then offers to approve once it arrives', async () => {
    const x = await setup();
    const inv = (await upload(x.token, invoiceXml(x, 'INV-2', 27.25))).body;
    await runtime.run(x.agentId, 'event');
    const [task] = await openTasks(x.token);
    expect(task).toMatchObject({ kind: 'invoice_dispute', priority: 1, title: 'Invoice INV-2 from Al Wafra Foods is SAR 11.50 more than it should be' });
    expect(task.actions.map((a: any) => a.id)).toEqual(['credit_note', 'approve_anyway']);
    expect(task.actions[0].params.messageAr).toContain('إشعار دائن');

    const sent = (await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(x.token)).send({ actionId: 'credit_note' }).expect(200)).body;
    expect(sent).toMatchObject({ status: 'executed', result: { prepared: true } });
    expect(sent.result.mailto).toContain('mailto:sales@wafra.sa');
    expect((await http.get(`/v1/supplier-invoices/${inv.id}`).set(auth(x.token))).body.status).toBe('disputed');

    await upload(x.token, ubl({ number: 'CN-1', supplierVat: x.supplierVat, type: '381', billingRef: 'INV-2', lines: [{ name: 'Price correction', qty: 4, price: 2.5 }] }));
    await runtime.run(x.agentId, 'event');
    const follow = (await openTasks(x.token)).find((t) => t.subjectKey === `invoice:${inv.id}`);
    expect(follow).toMatchObject({ kind: 'invoice_credit_note', evidence: { covers: true, creditNote: { number: 'CN-1', total: '11.50' } } });
    const ok = (await http.post(`/v1/agent-tasks/${follow.id}/approve`).set(auth(x.token)).send({ actionId: 'approve_anyway' }).expect(200)).body;
    expect(ok.result).toMatchObject({ status: 'approved', override: 'Credit note CN-1 (SAR 11.50) received' });
  });

  it('approves on its own only within the limit set by the customer', async () => {
    const x = await setup();
    await http.patch(`/v1/agents/${x.agentId}`).set(auth(x.token)).send({ autonomy: { approve_invoice: 'auto' }, settings: { maxAutoApproveSar: 100 } }).expect(200);
    const big = (await upload(x.token, invoiceXml(x, 'BIG-1'))).body;
    expect(await runtime.run(x.agentId, 'event')).toMatchObject({ tasksCreated: 1, actionsExecuted: 0 });
    expect((await http.get(`/v1/supplier-invoices/${big.id}`).set(auth(x.token))).body.status).toBe('matched');
    await http.post(`/v1/supplier-invoices/${big.id}/reject`).set(auth(x.token)).send({ reason: 'Testing the limit' }).expect(200);

    await http.patch(`/v1/agents/${x.agentId}`).set(auth(x.token)).send({ settings: { maxAutoApproveSar: 1000 } }).expect(200);
    const small = (await upload(x.token, invoiceXml(x, 'SMALL-1'))).body;
    expect(await runtime.run(x.agentId, 'event')).toMatchObject({ actionsExecuted: 1 });
    const after = (await http.get(`/v1/supplier-invoices/${small.id}`).set(auth(x.token))).body;
    expect(after).toMatchObject({ status: 'approved', approvedBy: x.agentUserId });
    // Rejecting the first invoice closed its task.
    expect((await openTasks(x.token)).filter((t) => t.kind.startsWith('invoice'))).toEqual([]);
  });

  it('never approves a mismatch on its own', async () => {
    const x = await setup();
    await http.patch(`/v1/agents/${x.agentId}`).set(auth(x.token)).send({ autonomy: { approve_invoice: 'auto' } }).expect(200);
    const inv = (await upload(x.token, invoiceXml(x, 'MM-1', 30))).body;
    expect(await runtime.run(x.agentId, 'event')).toMatchObject({ actionsExecuted: 0 });
    expect((await http.get(`/v1/supplier-invoices/${inv.id}`).set(auth(x.token))).body.status).toBe('mismatch');
  });

  it('points out invoices a person must check, and moves on once they are fixed', async () => {
    const x = await setup();
    const scan = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(uniq().repeat(40))]);
    const inv = (await http.post('/v1/supplier-invoices/upload').set(auth(x.token)).send({ filename: 's.pdf', contentType: 'application/pdf', data: scan.toString('base64') }).expect(201)).body;
    await runtime.run(x.agentId, 'event');
    const [review] = await openTasks(x.token);
    expect(review).toMatchObject({ kind: 'invoice_review', actions: [] });
    expect(review.summary).toContain('the supplier is not recognised');

    await http
      .patch(`/v1/supplier-invoices/${inv.id}`)
      .set(auth(x.token))
      .send({ relationshipId: x.sup.id, poId: x.po.id, number: 'P-9', issueDate: '2026-11-08', lines: [{ description: 'Chicken', sku: 'CH-1', qty: 4, unitPrice: 24.75 }, { description: 'Tomato', qty: 10, unitPrice: 5.4 }], acknowledge: true })
      .expect(200);
    await runtime.run(x.agentId, 'event');
    const tasks = await openTasks(x.token);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'invoice_approve', subjectKey: `invoice:${inv.id}` });
  });
});
