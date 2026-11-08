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

async function signup() {
  const res = await http
    .post('/v1/auth/signup')
    .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } })
    .expect(201);
  return { token: res.body.accessToken as string, orgId: res.body.organization.id as string };
}

/** Two suppliers selling tomatoes; returns ids. */
async function seedTomatoes(token: string) {
  const tomato = await http.post('/v1/items').set(auth(token)).send({ name: 'Tomato' }).expect(201);
  const packId = tomato.body.packs[0].id;
  const a = await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Fresh Farms', contactEmail: 'orders@ff.sa' }).expect(201);
  const b = await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Green Valley', contactEmail: 'sales@gv.sa' }).expect(201);
  const la = await http
    .post(`/v1/suppliers/${a.body.id}/items`)
    .set(auth(token))
    .send({ itemId: tomato.body.id, packId, price: 4.5, isPreferred: true })
    .expect(201);
  const lb = await http.post(`/v1/suppliers/${b.body.id}/items`).set(auth(token)).send({ itemId: tomato.body.id, packId, price: 4.8 }).expect(201);
  return { itemId: tomato.body.id, lineA: la.body.id as string, lineB: lb.body.id as string, supplierA: a.body.id as string };
}

async function hire(token: string) {
  const res = await http.post('/v1/agents').set(auth(token)).send({ kind: 'price_watch' }).expect(201);
  return res.body.agent.id as string;
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template' }), { logger: process.env.API_LOG === '1' });
  await app.init();
  http = request(app.getHttpServer());
  runtime = app.get(AgentRuntime);
});
afterAll(async () => {
  await app?.close();
});

describe('agent platform', () => {
  it('hires an agent as a member that cannot log in and cannot be given to people', async () => {
    const o = await signup();
    await hire(o.token);
    const members = await http.get('/v1/members').set(auth(o.token)).expect(200);
    const agentMember = members.body.find((m: any) => m.kind === 'agent');
    expect(agentMember.roleKey).toBe('agent_price_watch');
    await http.post('/v1/auth/login').send({ email: agentMember.email, password: 'anything-at-all' }).expect(401);
    const roles = await http.get('/v1/roles').set(auth(o.token)).expect(200);
    const agentRole = roles.body.find((r: any) => r.key === 'agent_price_watch');
    await http.post('/v1/invitations').set(auth(o.token)).send({ email: `${uniq()}@t.sa`, roleId: agentRole.id }).expect(400);
    await http.post('/v1/agents').set(auth(o.token)).send({ kind: 'price_watch' }).expect(400); // already hired
  });

  it('turns a price rise into a task with evidence and a cheaper alternative, then executes on approval', async () => {
    const o = await signup();
    const s = await seedTomatoes(o.token);
    const agentId = await hire(o.token);
    await http.post(`/v1/supplier-items/${s.lineA}/prices`).set(auth(o.token)).send({ price: 5.4 }).expect(201); // +20%

    const run = await runtime.run(agentId, 'event');
    expect(run).toMatchObject({ status: 'succeeded', eventsProcessed: 1, tasksCreated: 1 });

    const tasks = await http.get('/v1/agent-tasks').set(auth(o.token)).expect(200);
    expect(tasks.body).toHaveLength(1);
    const task = tasks.body[0];
    expect(task.evidence.changePct).toBe(20);
    expect(task.evidence.alternatives[0]).toMatchObject({ supplier: 'Green Valley', costPerUnit: '4.80' });
    expect(task.titleAr).toContain('٪');
    expect(task.writtenBy).toBe('template');
    expect(task.actions.map((x: any) => x.type)).toEqual(['switch_preferred', 'contact_supplier', 'accept_price']);
    expect((await http.get('/v1/agent-tasks/count').set(auth(o.token))).body.open).toBe(1);

    // Running again processes nothing new and does not duplicate the task.
    expect(await runtime.run(agentId, 'event')).toMatchObject({ eventsProcessed: 0, tasksCreated: 0 });

    const done = await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(o.token)).send({ actionId: 'switch' }).expect(200);
    expect(done.body.status).toBe('executed');
    const item = await http.get(`/v1/items/${s.itemId}`).set(auth(o.token)).expect(200);
    expect(item.body.supplierItems.find((l: any) => l.id === s.lineB).isPreferred).toBe(true);
    expect(item.body.supplierItems.find((l: any) => l.id === s.lineA).isPreferred).toBe(false);

    // The change is audited as the agent, and the decision is recorded.
    const audits = await http.get('/v1/audit-events').query({ entityType: 'supplier_item', entityId: s.lineB }).set(auth(o.token)).expect(200);
    expect(audits.body[0]).toMatchObject({ action: 'supplier_item.preferred_set', actorType: 'agent' });
    await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(o.token)).send({ actionId: 'switch' }).expect(400);
  });

  it('ignores small rises and decreases, updates an open task when the price rises again', async () => {
    const o = await signup();
    const s = await seedTomatoes(o.token);
    const agentId = await hire(o.token);
    await http.post(`/v1/supplier-items/${s.lineA}/prices`).set(auth(o.token)).send({ price: 4.6 }).expect(201); // +2.2%
    await http.post(`/v1/supplier-items/${s.lineB}/prices`).set(auth(o.token)).send({ price: 4.0 }).expect(201); // decrease
    expect(await runtime.run(agentId, 'event')).toMatchObject({ eventsProcessed: 2, tasksCreated: 0 });

    await http.post(`/v1/supplier-items/${s.lineA}/prices`).set(auth(o.token)).send({ price: 5.2 }).expect(201);
    expect(await runtime.run(agentId, 'event')).toMatchObject({ tasksCreated: 1 });
    await http.post(`/v1/supplier-items/${s.lineA}/prices`).set(auth(o.token)).send({ price: 6.0 }).expect(201);
    expect(await runtime.run(agentId, 'event')).toMatchObject({ tasksCreated: 0, tasksUpdated: 1 });
    const tasks = await http.get('/v1/agent-tasks').set(auth(o.token)).expect(200);
    expect(tasks.body).toHaveLength(1);
    expect(tasks.body[0].evidence.newPrice).toBe('6.00');
  });

  it('finds price rises from history when first hired', async () => {
    const o = await signup();
    const s = await seedTomatoes(o.token);
    await http.post(`/v1/supplier-items/${s.lineA}/prices`).set(auth(o.token)).send({ price: 5.4 }).expect(201);
    const res = await http.post('/v1/agents').set(auth(o.token)).send({ kind: 'price_watch' }).expect(201);
    expect(res.body.firstRun).toMatchObject({ status: 'succeeded', tasksCreated: 1 });
  });

  it('respects autonomy, guardrails and the pause switch', async () => {
    const o = await signup();
    const s = await seedTomatoes(o.token);
    const agentId = await hire(o.token);

    // Auto with a high saving threshold: the guardrail blocks auto-switching (saving is ~11%).
    await http.patch(`/v1/agents/${agentId}`).set(auth(o.token)).send({ autonomy: { switch_preferred: 'auto' }, settings: { minSavingPctForAuto: 50 } }).expect(200);
    await http.post(`/v1/supplier-items/${s.lineA}/prices`).set(auth(o.token)).send({ price: 5.4 }).expect(201);
    expect(await runtime.run(agentId, 'event')).toMatchObject({ tasksCreated: 1, actionsExecuted: 0 });
    let tasks = await http.get('/v1/agent-tasks').set(auth(o.token)).expect(200);
    expect(tasks.body[0].result.autoBlocked).toContain('below the 50%');
    await http.post(`/v1/agent-tasks/${tasks.body[0].id}/dismiss`).set(auth(o.token)).send({}).expect(200);

    // Lower the threshold: the next rise is switched automatically.
    await http.patch(`/v1/agents/${agentId}`).set(auth(o.token)).send({ settings: { minSavingPctForAuto: 5 } }).expect(200);
    await http.post(`/v1/supplier-items/${s.lineA}/prices`).set(auth(o.token)).send({ price: 6.0 }).expect(201);
    expect(await runtime.run(agentId, 'event')).toMatchObject({ tasksCreated: 1, actionsExecuted: 1 });
    tasks = await http.get('/v1/agent-tasks?status=closed').set(auth(o.token)).expect(200);
    expect(tasks.body[0]).toMatchObject({ status: 'executed', chosenActionId: 'switch' });

    // Messages can never be sent automatically.
    await http.patch(`/v1/agents/${agentId}`).set(auth(o.token)).send({ autonomy: { contact_supplier: 'auto' } }).expect(400);

    // Paused agents don't run and their tasks can't be executed.
    await http.patch(`/v1/agents/${agentId}`).set(auth(o.token)).send({ status: 'paused', autonomy: { switch_preferred: 'approve' } }).expect(200);
    await http.post(`/v1/supplier-items/${s.lineB}/prices`).set(auth(o.token)).send({ price: 6.5 }).expect(201);
    expect(await runtime.run(agentId, 'event')).toMatchObject({ status: 'skipped' });
  });

  it('records rejections and checks permissions', async () => {
    const o = await signup();
    const s = await seedTomatoes(o.token);
    const agentId = await hire(o.token);
    await http.post(`/v1/supplier-items/${s.lineA}/prices`).set(auth(o.token)).send({ price: 5.4 }).expect(201);
    await runtime.run(agentId, 'event');
    const [task] = (await http.get('/v1/agent-tasks').set(auth(o.token))).body;

    const roles = await http.get('/v1/roles').set(auth(o.token)).expect(200);
    const accountant = roles.body.find((r: any) => r.key === 'accountant');
    const inv = await http.post('/v1/invitations').set(auth(o.token)).send({ email: `${uniq()}@t.sa`, roleId: accountant.id }).expect(201);
    const acc = await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: 'Acc' }).expect(201);
    await http.get('/v1/agent-tasks').set(auth(acc.body.accessToken)).expect(200); // can read
    await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(acc.body.accessToken)).send({ actionId: 'switch' }).expect(403);

    const rejected = await http.post(`/v1/agent-tasks/${task.id}/reject`).set(auth(o.token)).send({ reason: 'Green Valley quality is poor' }).expect(200);
    expect(rejected.body).toMatchObject({ status: 'rejected', decisionNote: 'Green Valley quality is poor' });

    const runs = await http.get(`/v1/agents/${agentId}/runs`).set(auth(o.token)).expect(200);
    expect(runs.body.length).toBeGreaterThanOrEqual(2);
    expect(runs.body[0]).toMatchObject({ status: 'succeeded', costUsd: '0.000000' });

    const other = await signup();
    await http.get(`/v1/agent-tasks/${task.id}`).set(auth(other.token)).expect(404);
    await http.post(`/v1/agents/${agentId}/run`).set(auth(other.token)).send({}).expect(404);
  });
});
