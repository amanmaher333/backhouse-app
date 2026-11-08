import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { AgentRuntime } from '../src/agents/runtime.js';

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

/**
 * Olaya site; chicken (par 10 kg, reorder 4 kg) and tomato (par 20 kg, reorder 8 kg).
 * Watania is preferred for chicken; tomato from Watania (5.40) and Green Valley (4.80, cheaper).
 */
async function setup() {
  const s = await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } }).expect(201);
  const token = s.body.accessToken as string;
  const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: s.body.legalEntity.id, name: 'Olaya', nameAr: 'العليا' }).expect(201)).body;
  const chicken = (await http.post('/v1/items').set(auth(token)).send({ name: 'Chicken breast' }).expect(201)).body;
  const tomato = (await http.post('/v1/items').set(auth(token)).send({ name: 'Tomato' }).expect(201)).body;
  const wat = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Al Watania', contactEmail: 'o@w.sa' }).expect(201)).body;
  const gv = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Green Valley', contactEmail: 'o@gv.sa', minOrderValue: 200 }).expect(201)).body;
  await http.post(`/v1/suppliers/${wat.id}/items`).set(auth(token)).send({ itemId: chicken.id, packId: chicken.packs[0].id, price: 24.75, isPreferred: true }).expect(201);
  await http.post(`/v1/suppliers/${wat.id}/items`).set(auth(token)).send({ itemId: tomato.id, packId: tomato.packs[0].id, price: 5.4 }).expect(201);
  await http.post(`/v1/suppliers/${gv.id}/items`).set(auth(token)).send({ itemId: tomato.id, packId: tomato.packs[0].id, price: 4.8 }).expect(201);
  await http.put(`/v1/items/${chicken.id}/sites/${site.id}`).set(auth(token)).send({ parLevel: 10, reorderPoint: 4, unit: 'kg' }).expect(200);
  await http.put(`/v1/items/${tomato.id}/sites/${site.id}`).set(auth(token)).send({ parLevel: 20, reorderPoint: 8, unit: 'kg' }).expect(200);
  const agent = (await http.post('/v1/agents').set(auth(token)).send({ kind: 'purchasing' }).expect(201)).body;
  return { token, site, chicken, tomato, wat, gv, agentId: agent.agent.id as string, firstRun: agent.firstRun };
}

const setStock = (token: string, siteId: string, itemId: string, kg: number) =>
  http.post(`/v1/sites/${siteId}/stock/set`).set(auth(token)).send({ itemId, qty: kg, unit: 'kg' }).expect(201);

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

describe('Purchasing agent', () => {
  it('does not order items whose stock has never been counted', async () => {
    const x = await setup();
    expect(x.firstRun).toMatchObject({ status: 'succeeded', tasksCreated: 0 });
  });

  it('proposes one order per supplier back to par, and creates it on approval', async () => {
    const x = await setup();
    await setStock(x.token, x.site.id, x.chicken.id, 3); // below 4 kg reorder point
    await setStock(x.token, x.site.id, x.tomato.id, 12); // above 8 kg: no order
    expect(await runtime.run(x.agentId, 'event')).toMatchObject({ tasksCreated: 1 });

    const [task] = (await http.get('/v1/agent-tasks').set(auth(x.token)).expect(200)).body;
    expect(task.kind).toBe('reorder');
    expect(task.evidence.supplier.name).toBe('Al Watania');
    expect(task.evidence.lines).toEqual([expect.objectContaining({ item: 'Chicken breast', qty: 7, onHand: '3 kg', par: '10 kg' })]);
    expect(task.evidence.total).toBe('199.24'); // 7 × 24.75 = 173.25 + 15% VAT
    expect(task.evidence.deliveryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const done = await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(x.token)).send({ actionId: 'order' }).expect(200);
    expect(done.body.status).toBe('executed');
    expect(done.body.result).toMatchObject({ status: 'approved', total: '199.24' });
    const po = (await http.get(`/v1/purchase-orders/${done.body.result.poId}`).set(auth(x.token)).expect(200)).body;
    expect(po).toMatchObject({ source: 'agent', agentTaskId: task.id });
    expect(po.lines[0]).toMatchObject({ qty: '7.000' });

    // With the order on the way, a re-check proposes nothing new.
    expect(await runtime.run(x.agentId, 'manual', { scan: true })).toMatchObject({ tasksCreated: 0 });
  });

  it('uses the cheapest supplier when none is preferred, updates and expires suggestions', async () => {
    const x = await setup();
    await setStock(x.token, x.site.id, x.tomato.id, 5);
    await runtime.run(x.agentId, 'event');
    const [task] = (await http.get('/v1/agent-tasks').set(auth(x.token)).expect(200)).body;
    expect(task.evidence.supplier.name).toBe('Green Valley');
    expect(task.evidence.lines[0].qty).toBe(15);
    // 15 × 4.80 = SAR 72 before VAT, under Green Valley's SAR 200 minimum: flagged, and never ordered automatically.
    expect(task.evidence.belowMinimum).toBe(true);
    expect(task.summary).toContain('minimum order of SAR 200.00');
  });

  it('expires a suggestion when stock is back above the reorder point', async () => {
    const x = await setup();
    await setStock(x.token, x.site.id, x.chicken.id, 2);
    await runtime.run(x.agentId, 'event');
    expect((await http.get('/v1/agent-tasks/count').set(auth(x.token))).body.open).toBe(1);
    await setStock(x.token, x.site.id, x.chicken.id, 2.5);
    expect(await runtime.run(x.agentId, 'event')).toMatchObject({ tasksUpdated: 1 });
    await setStock(x.token, x.site.id, x.chicken.id, 9);
    await runtime.run(x.agentId, 'event');
    expect((await http.get('/v1/agent-tasks/count').set(auth(x.token))).body.open).toBe(0);
    const closed = (await http.get('/v1/agent-tasks?status=closed').set(auth(x.token)).expect(200)).body;
    expect(closed[0].status).toBe('expired');
  });

  it('orders automatically only under the limit, and respects spend limits and site permissions', async () => {
    const x = await setup();
    await http.patch(`/v1/agents/${x.agentId}`).set(auth(x.token)).send({ autonomy: { create_po: 'auto' }, settings: { maxAutoOrderSar: 100 } }).expect(200);
    await setStock(x.token, x.site.id, x.chicken.id, 3);
    expect(await runtime.run(x.agentId, 'event')).toMatchObject({ tasksCreated: 1, actionsExecuted: 0 });
    const [blocked] = (await http.get('/v1/agent-tasks').set(auth(x.token))).body;
    expect(blocked.result.autoBlocked).toContain('above the SAR 100.00');

    // A spend limit still applies to agent-created orders.
    await http.post('/v1/spend-limits').set(auth(x.token)).send({ period: 'order', amount: 150 }).expect(201);
    const done = await http.post(`/v1/agent-tasks/${blocked.id}/approve`).set(auth(x.token)).send({ actionId: 'order' }).expect(200);
    expect(done.body.result.status).toBe('pending_approval');
    expect(done.body.result.approvalReason).toContain('per-order limit');
  });

  it('only lets people approve orders for sites they manage', async () => {
    const x = await setup();
    const other = (await http.post('/v1/sites').set(auth(x.token)).send({ legalEntityId: (await http.get('/v1/legal-entities').set(auth(x.token))).body[0].id, name: 'Malqa' }).expect(201)).body;
    const mgr = await invite(x.token, 'site_manager', [other.id]); // manages Malqa, not Olaya
    await setStock(x.token, x.site.id, x.chicken.id, 1);
    await runtime.run(x.agentId, 'event');
    const [task] = (await http.get('/v1/agent-tasks').set(auth(x.token))).body;
    await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(mgr)).send({ actionId: 'order' }).expect(403);
    expect((await http.get('/v1/agent-tasks/count').set(auth(x.token))).body.open).toBe(1); // nothing changed
  });

  it('chases sent orders whose delivery is late', async () => {
    const x = await setup();
    const lines = (await http.get(`/v1/suppliers/${x.wat.id}`).set(auth(x.token))).body.items;
    const po = await http
      .post('/v1/purchase-orders')
      .set(auth(x.token))
      .send({ siteId: x.site.id, relationshipId: x.wat.id, deliveryDate: '2026-01-05', submit: true, lines: [{ supplierItemId: lines[0].id, qty: 2 }] })
      .expect(201);
    await http.post(`/v1/purchase-orders/${po.body.id}/send`).set(auth(x.token)).send({}).expect(200);
    await runtime.run(x.agentId, 'event');
    const tasks = (await http.get('/v1/agent-tasks').set(auth(x.token))).body;
    const late = tasks.find((t: any) => t.kind === 'po_overdue');
    expect(late.title).toContain(`${po.body.number} from Al Watania is`);
    expect(late.evidence.daysLate).toBeGreaterThan(300);
    const done = await http.post(`/v1/agent-tasks/${late.id}/approve`).set(auth(x.token)).send({ actionId: 'contact' }).expect(200);
    expect(done.body.result.mailto).toContain('mailto:o@w.sa');
  });
});
