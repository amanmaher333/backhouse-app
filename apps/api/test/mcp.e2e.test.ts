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

async function signup() {
  const res = await http
    .post('/v1/auth/signup')
    .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } })
    .expect(201);
  return { token: res.body.accessToken as string, orgId: res.body.organization.id as string };
}

let rpcId = 1;
/** One JSON-RPC call to the MCP endpoint (stateless Streamable HTTP, JSON responses). */
function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  return http
    .post('/mcp')
    .set(auth(token))
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', id: rpcId++, method, params });
}

const init = (token: string) =>
  mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});

describe('personal access tokens', () => {
  it('creates a token shown once, authenticates with it, and stops working when revoked', async () => {
    const o = await signup();
    const created = await http.post('/v1/access-tokens').set(auth(o.token)).send({ name: 'Claude Desktop' }).expect(201);
    expect(created.body.token).toMatch(/^boh_pat_/);
    const pat = created.body.token as string;

    const listed = await http.get('/v1/access-tokens').set(auth(o.token)).expect(200);
    expect(listed.body[0]).toMatchObject({ name: 'Claude Desktop', tokenPrefix: pat.slice(0, 14) });
    expect(JSON.stringify(listed.body)).not.toContain(pat);

    await http.get('/v1/items').set(auth(pat)).expect(200);
    await http.get('/v1/items').set(auth('boh_pat_not-a-real-token')).expect(401);

    await http.delete(`/v1/access-tokens/${created.body.id}`).set(auth(o.token)).expect(204);
    await http.get('/v1/items').set(auth(pat)).expect(401);
  });

  it('stops working when the user leaves the organisation', async () => {
    const o = await signup();
    const roles = await http.get('/v1/roles').set(auth(o.token)).expect(200);
    const ops = roles.body.find((r: any) => r.key === 'ops_manager');
    const inv = await http.post('/v1/invitations').set(auth(o.token)).send({ email: `${uniq()}@t.sa`, roleId: ops.id }).expect(201);
    const acc = await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: 'Ops' }).expect(201);
    const pat = (await http.post('/v1/access-tokens').set(auth(acc.body.accessToken)).send({ name: 'script' }).expect(201)).body.token;
    await http.get('/v1/suppliers').set(auth(pat)).expect(200);
    const members = await http.get('/v1/members').set(auth(o.token)).expect(200);
    const m = members.body.find((x: any) => x.roleKey === 'ops_manager');
    await http.delete(`/v1/members/${m.membershipId}`).set(auth(o.token)).expect(204);
    await http.get('/v1/suppliers').set(auth(pat)).expect(401);
  });
});

describe('MCP server', () => {
  it('lists tools filtered by permission and runs them under the caller identity', async () => {
    const o = await signup();
    const pat = (await http.post('/v1/access-tokens').set(auth(o.token)).send({ name: 'mcp' }).expect(201)).body.token;

    const hello = await init(pat).expect(200);
    expect(hello.body.result.serverInfo.name).toBe('boh');

    const tools = await mcp(pat, 'tools/list').expect(200);
    const names = tools.body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['search_items', 'get_item', 'match_ingredients', 'list_suppliers', 'recent_price_changes', 'set_supplier_price', 'list_agent_tasks', 'approve_agent_task', 'list_supplier_invoices', 'get_supplier_invoice']),
    );

    // Set up data through REST, then use MCP to read it and approve an agent action.
    const tomato = await http.post('/v1/items').set(auth(o.token)).send({ name: 'Tomato' }).expect(201);
    const packId = tomato.body.packs[0].id;
    const a = await http.post('/v1/suppliers').set(auth(o.token)).send({ displayName: 'Fresh Farms', contactEmail: 'o@ff.sa' }).expect(201);
    const b = await http.post('/v1/suppliers').set(auth(o.token)).send({ displayName: 'Green Valley', contactEmail: 'o@gv.sa' }).expect(201);
    const la = await http.post(`/v1/suppliers/${a.body.id}/items`).set(auth(o.token)).send({ itemId: tomato.body.id, packId, price: 4.5, isPreferred: true }).expect(201);
    await http.post(`/v1/suppliers/${b.body.id}/items`).set(auth(o.token)).send({ itemId: tomato.body.id, packId, price: 4.8 }).expect(201);
    const agent = await http.post('/v1/agents').set(auth(o.token)).send({ kind: 'price_watch' }).expect(201);

    const match = await mcp(pat, 'tools/call', { name: 'match_ingredients', arguments: { names: ['طماطم بلدي ١ كجم'] } }).expect(200);
    expect(JSON.parse(match.body.result.content[0].text)[0].auto.slug).toBe('tomato');

    const priced = await mcp(pat, 'tools/call', { name: 'set_supplier_price', arguments: { supplier_item_id: la.body.id, price: 5.4 } }).expect(200);
    expect(JSON.parse(priced.body.result.content[0].text).changed).toBe(true);
    await app.get(AgentRuntime).run(agent.body.agent.id, 'event');

    const inbox = await mcp(pat, 'tools/call', { name: 'list_agent_tasks', arguments: {} }).expect(200);
    const [task] = JSON.parse(inbox.body.result.content[0].text);
    expect(task.evidence.changePct).toBe(20);

    const approved = await mcp(pat, 'tools/call', { name: 'approve_agent_task', arguments: { task_id: task.id, action_id: 'switch' } }).expect(200);
    expect(JSON.parse(approved.body.result.content[0].text).status).toBe('executed');

    // Errors come back as tool errors, not crashes.
    const again = await mcp(pat, 'tools/call', { name: 'approve_agent_task', arguments: { task_id: task.id, action_id: 'switch' } }).expect(200);
    expect(again.body.result.isError).toBe(true);
  });

  it('gives limited roles fewer tools and requires authentication', async () => {
    const o = await signup();
    const site = await http.post('/v1/sites').set(auth(o.token)).send({ legalEntityId: (await http.get('/v1/legal-entities').set(auth(o.token))).body[0].id, name: 'S1' }).expect(201);
    const roles = await http.get('/v1/roles').set(auth(o.token)).expect(200);
    const staff = roles.body.find((r: any) => r.key === 'staff');
    const inv = await http.post('/v1/invitations').set(auth(o.token)).send({ email: `${uniq()}@t.sa`, roleId: staff.id, siteIds: [site.body.id] }).expect(201);
    const acc = await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: 'Staff' }).expect(201);
    const tools = await mcp(acc.body.accessToken, 'tools/list').expect(200);
    const names = tools.body.result.tools.map((t: any) => t.name);
    expect(names).toContain('search_items');
    expect(names).not.toContain('recent_price_changes');
    expect(names).not.toContain('approve_agent_task');

    await http.post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(401);
    await http.get('/mcp').set(auth(o.token)).expect(405);
  });
});
