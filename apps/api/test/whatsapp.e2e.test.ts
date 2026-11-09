import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { agentTasks, approvalPrompts, outboundMessages, runMigrations, userChannels } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { ChannelsService } from '../src/channels/channels.service.js';
import { WHATSAPP_TRANSPORT, type SimulatedTransport } from '../src/channels/transport.js';
import { DigestService } from '../src/channels/digest.js';
import { digestRuns } from '@boh/db';
import { cloudRequestBody } from '../src/channels/transport.js';
import { DbService } from '../src/common/db.service.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const SECRET = 'test-app-secret';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const phone = () => `+9665${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
let app: INestApplication;
let http: ReturnType<typeof request>;
let runtime: AgentRuntime;
let channels: ChannelsService;
let sim: SimulatedTransport;
let db: DbService;
let digests: DigestService;

const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;

/** Post a webhook body exactly as Meta would: signed over the raw bytes. */
function webhook(value: Record<string, unknown>, opts: { signature?: string } = {}) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...value } }] }] });
  return http
    .post('/v1/webhooks/whatsapp')
    .set('content-type', 'application/json')
    .set('x-hub-signature-256', opts.signature ?? sign(raw))
    .send(raw);
}
let seq = 0;
const text = (from: string, body: string, id = `wamid.t${Date.now()}${seq++}`) => webhook({ messages: [{ id, from: from.slice(1), type: 'text', text: { body } }] });
const tap = (from: string, payload: string, id = `wamid.b${Date.now()}${seq++}`) =>
  webhook({ messages: [{ id, from: from.slice(1), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: payload, title: 'x' } } }] });
const sentTo = (to: string) => sim.sent.filter((m) => m.to === to);
const lastTo = (to: string) => sentTo(to).at(-1)!;

async function link(token: string, number = phone()) {
  const { code } = (await http.post('/v1/me/whatsapp/link').set(auth(token)).expect(201)).body;
  await text(number, `my code ${code}`).expect(200);
  return number;
}

async function invite(owner: string, roleKey: string, siteIds?: string[]) {
  const roles = await http.get('/v1/roles').set(auth(owner)).expect(200);
  const role = roles.body.find((r: any) => r.key === roleKey);
  const inv = await http.post('/v1/invitations').set(auth(owner)).send({ email: `${uniq()}@t.sa`, roleId: role.id, siteIds }).expect(201);
  return (await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: roleKey }).expect(201)).body.accessToken as string;
}

/** An org whose Purchasing agent proposes a chicken order for Olaya (SAR 199.24). */
async function setup(locale: 'ar' | 'en' = 'en') {
  const s = await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Sara', locale, organization: { name: `Org ${uniq()}` } }).expect(201);
  const token = s.body.accessToken as string;
  const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: s.body.legalEntity.id, name: 'Olaya', nameAr: 'العليا' }).expect(201)).body;
  const chicken = (await http.post('/v1/items').set(auth(token)).send({ name: 'Chicken breast', nameAr: 'صدور دجاج' }).expect(201)).body;
  const wat = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Al Watania', contactEmail: 'o@w.sa' }).expect(201)).body;
  const line = (await http.post(`/v1/suppliers/${wat.id}/items`).set(auth(token)).send({ itemId: chicken.id, packId: chicken.packs[0].id, price: 24.75, isPreferred: true }).expect(201)).body;
  await http.put(`/v1/items/${chicken.id}/sites/${site.id}`).set(auth(token)).send({ parLevel: 10, reorderPoint: 4, unit: 'kg' }).expect(200);
  const agent = (await http.post('/v1/agents').set(auth(token)).send({ kind: 'purchasing' }).expect(201)).body;
  return { token, site, chicken, wat, lineId: line.id as string, agentId: agent.agent.id as string, legalEntityId: s.body.legalEntity.id as string };
}

/** Make the agent propose the order, then run the notifier until this task has been handled. */
async function propose(x: Awaited<ReturnType<typeof setup>>, kg = 3) {
  await http.post(`/v1/sites/${x.site.id}/stock/set`).set(auth(x.token)).send({ itemId: x.chicken.id, qty: kg, unit: 'kg' }).expect(201);
  await runtime.run(x.agentId, 'event');
  const [task] = (await http.get('/v1/agent-tasks').set(auth(x.token)).expect(200)).body;
  for (let i = 0; i < 50; i++) {
    await channels.notifyPending();
    const [t] = await db.system((tx) => tx.select({ n: agentTasks.notifiedAt }).from(agentTasks).where(eq(agentTasks.id, task.id)));
    if (t?.n) break;
  }
  await channels.deliver();
  return task;
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(
    loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', WHATSAPP_MODE: 'simulated', WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me', NODE_ENV: 'test' }),
    { logger: false },
  );
  await app.init();
  http = request(app.getHttpServer());
  runtime = app.get(AgentRuntime);
  channels = app.get(ChannelsService);
  sim = app.get(WHATSAPP_TRANSPORT);
  db = app.get(DbService);
  digests = app.get(DigestService);
});
afterAll(async () => {
  await app?.close();
});

describe('WhatsApp webhook', () => {
  it('answers Meta’s subscription check only with the right verify token', async () => {
    const ok = await http.get('/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1158201444' }).expect(200);
    expect(ok.text).toBe('1158201444');
    await http.get('/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }).expect(401);
  });

  it('rejects unsigned and wrongly signed deliveries', async () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    await http.post('/v1/webhooks/whatsapp').set('content-type', 'application/json').send(raw).expect(401);
    await webhook({ messages: [] }, { signature: sign('something else') }).expect(401);
  });
});

describe('Linking a number', () => {
  it('links the number that sends the code, once, and ignores provider retries', async () => {
    const x = await setup();
    const { code, waLink } = (await http.post('/v1/me/whatsapp/link').set(auth(x.token)).expect(201)).body;
    expect(code).toMatch(/^BOH-[2-9A-HJKMNP-Z]{6}$/);
    expect(waLink).toContain(encodeURIComponent(code));
    const number = phone();
    const id = `wamid.link${uniq()}`;
    await text(number, code.toLowerCase(), id).expect(200);
    await text(number, code.toLowerCase(), id).expect(200); // Meta retries the same message
    expect(sentTo(number)).toHaveLength(1);
    expect(lastTo(number).content.text).toContain('WhatsApp is now linked');

    const mine = (await http.get('/v1/me/whatsapp').set(auth(x.token)).expect(200)).body;
    expect(mine.linked).toMatchObject({ address: number, approvalsEnabled: true, windowOpen: true });

    // The code is single-use; another account cannot take the number.
    const other = await setup();
    await text(number, code).expect(200);
    expect(lastTo(number).content.text).toContain('wrong or has expired');
    const { code: code2 } = (await http.post('/v1/me/whatsapp/link').set(auth(other.token)).expect(201)).body;
    await text(number, code2).expect(200);
    expect(lastTo(number).content.text).toContain('linked to another Backhouse account');
  });

  it('answers unknown numbers and supports STOP / START', async () => {
    const stranger = phone();
    await text(stranger, 'hello').expect(200);
    expect(lastTo(stranger).content.text).toContain('not linked to a Backhouse account');

    const x = await setup('ar');
    const number = await link(x.token);
    expect(lastTo(number).content.text).toContain('تم ربط واتساب');
    await text(number, 'إيقاف').expect(200);
    expect((await http.get('/v1/me/whatsapp').set(auth(x.token))).body.linked.approvalsEnabled).toBe(false);
    await text(number, 'START').expect(200);
    expect((await http.get('/v1/me/whatsapp').set(auth(x.token))).body.linked.approvalsEnabled).toBe(true);
  });
});

describe('Approving on WhatsApp', () => {
  it('sends a card to people who can approve, and a tap carries it out as them', async () => {
    const x = await setup();
    const number = await link(x.token);
    const task = await propose(x);

    const card = lastTo(number);
    expect(card.form).toBe('interactive'); // inside the 24-hour window opened by linking
    expect(card.content.text).toContain('needs your decision');
    expect(card.content.text).toContain('Chicken breast: 7 × 1 kg');
    expect(card.content.text).toContain('Total: SAR 199.24 incl. VAT');
    expect(card.content.text).toContain(`/inbox?task=${task.id}`);
    expect(card.content.buttons!.map((b) => b.title)).toEqual(['Approve', 'Reject']);
    const body = cloudRequestBody(number, card.content, card.form) as any;
    expect(body.interactive.action.buttons).toHaveLength(2);
    expect(body.to).toBe(number.slice(1));

    await tap(number, card.content.buttons![0]!.id).expect(200);
    const done = (await http.get(`/v1/agent-tasks/${task.id}`).set(auth(x.token)).expect(200)).body;
    expect(done).toMatchObject({ status: 'executed', decidedVia: 'whatsapp' });
    expect(done.result.number).toMatch(/^PO-\d{5}$/);
    expect(lastTo(number).content.text).toContain(`order ${done.result.number} created`);

    // A second tap (or a retry) does not order twice.
    await tap(number, card.content.buttons![0]!.id).expect(200);
    expect(lastTo(number).content.text).toContain('was already done on WhatsApp');
    const orders = (await http.get('/v1/purchase-orders?status=all').set(auth(x.token)).expect(200)).body;
    expect(orders).toHaveLength(1);

    // The decision is audited with the WhatsApp message id.
    const log = (await http.get('/v1/audit-events').set(auth(x.token)).expect(200)).body;
    const approved = (log.items ?? log).find((e: any) => e.action === 'agent_task.approved');
    expect(approved.requestId).toMatch(/^whatsapp:wamid\./);
  });

  it('ignores buttons tapped from another number', async () => {
    const x = await setup();
    const number = await link(x.token);
    const task = await propose(x);
    const intruder = await link((await setup()).token);
    await tap(intruder, lastTo(number).content.buttons![0]!.id).expect(200);
    expect(lastTo(intruder).content.text).toContain('not for this number');
    expect((await http.get(`/v1/agent-tasks/${task.id}`).set(auth(x.token))).body.status).toBe('proposed');
  });

  it('above the WhatsApp cap, offers only Reject and refuses a forged Approve', async () => {
    const x = await setup();
    await http.patch('/v1/channels/settings').set(auth(x.token)).send({ whatsappApprovalMax: 100 }).expect(200);
    const number = await link(x.token);
    const task = await propose(x);
    const card = lastTo(number);
    expect(card.content.buttons!.map((b) => b.title)).toEqual(['Reject']);
    expect(card.content.text).toContain('above the SAR 100.00 limit');
    expect(card.content.template!.name).toBe('boh_task_notice');

    const [prompt] = await db.system((tx) => tx.select().from(approvalPrompts).where(eq(approvalPrompts.taskId, task.id)));
    await tap(number, `apr:${prompt!.id}:a`).expect(200);
    expect(lastTo(number).content.text).toContain('above the limit');
    expect((await http.get(`/v1/agent-tasks/${task.id}`).set(auth(x.token))).body.status).toBe('proposed');

    await tap(number, card.content.buttons![0]!.id).expect(200);
    expect((await http.get(`/v1/agent-tasks/${task.id}`).set(auth(x.token))).body).toMatchObject({ status: 'rejected', decidedVia: 'whatsapp' });
    expect(lastTo(number).content.text).toContain('Rejected');
  });

  it('uses the approved template outside the 24-hour window', async () => {
    const x = await setup('ar');
    const number = await link(x.token);
    await db.system((tx) => tx.update(userChannels).set({ lastInboundAt: new Date(Date.now() - 30 * 3600_000) }).where(eq(userChannels.address, number)));
    await propose(x);
    const card = lastTo(number);
    expect(card.form).toBe('template');
    const body = cloudRequestBody(number, card.content, card.form) as any;
    expect(body.template).toMatchObject({ name: 'boh_approval_request', language: { code: 'ar' } });
    const [bodyParams, approve, reject, url] = body.template.components;
    expect(bodyParams.parameters).toHaveLength(3);
    expect(bodyParams.parameters.every((p: any) => !/\n/.test(p.text))).toBe(true);
    expect(approve).toMatchObject({ sub_type: 'quick_reply', index: '0' });
    expect(reject).toMatchObject({ sub_type: 'quick_reply', index: '1' });
    expect(url).toMatchObject({ sub_type: 'url', index: '2' });
  });

  it('only notifies people allowed to decide for that site, and respects STOP', async () => {
    const x = await setup();
    const malqa = (await http.post('/v1/sites').set(auth(x.token)).send({ legalEntityId: x.legalEntityId, name: 'Malqa' }).expect(201)).body;
    const malqaMgr = await link(await invite(x.token, 'site_manager', [malqa.id]));
    const olayaMgr = await link(await invite(x.token, 'site_manager', [x.site.id]));
    const viewer = await link(await invite(x.token, 'accountant'));
    const owner = await link(x.token);
    await text(owner, 'STOP').expect(200);
    const before = { malqa: sentTo(malqaMgr).length, viewer: sentTo(viewer).length, owner: sentTo(owner).length };
    await propose(x);
    expect(sentTo(malqaMgr)).toHaveLength(before.malqa);
    expect(sentTo(viewer)).toHaveLength(before.viewer);
    expect(sentTo(owner)).toHaveLength(before.owner);
    expect(lastTo(olayaMgr).content.buttons).toHaveLength(2);
  });

  it('re-checks membership, expiry and earlier decisions at the moment of the tap', async () => {
    const x = await setup();
    const mgrToken = await invite(x.token, 'site_manager', [x.site.id]);
    const mgr = await link(mgrToken);
    const owner = await link(x.token);
    const task = await propose(x);
    const mgrApprove = lastTo(mgr).content.buttons![0]!.id;

    // Expired card
    await db.system((tx) => tx.update(approvalPrompts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvalPrompts.taskId, task.id)));
    await tap(mgr, mgrApprove).expect(200);
    expect(lastTo(mgr).content.text).toContain('انتهت صلاحية'); // invited people default to Arabic
    await db.system((tx) => tx.update(approvalPrompts).set({ expiresAt: new Date(Date.now() + 3600_000) }).where(eq(approvalPrompts.taskId, task.id)));

    // Removed from the org
    const members = (await http.get('/v1/members').set(auth(x.token))).body;
    const me = (await http.get('/v1/auth/me').set(auth(mgrToken))).body;
    await http.delete(`/v1/members/${members.find((m: any) => m.userId === me.user.id).membershipId}`).set(auth(x.token)).expect(204);
    await tap(mgr, mgrApprove).expect(200);
    expect(lastTo(mgr).content.text).toContain('لم تعد عضوًا');

    // Decided in the web meanwhile
    await http.post(`/v1/agent-tasks/${task.id}/reject`).set(auth(x.token)).send({}).expect(200);
    await tap(owner, lastTo(owner).content.buttons![0]!.id).expect(200);
    expect(lastTo(owner).content.text).toContain('was already rejected in Backhouse');
    expect((await http.get('/v1/purchase-orders?status=all').set(auth(x.token))).body).toHaveLength(0);
  });

  it('tracks delivery statuses without moving backwards', async () => {
    const x = await setup();
    const number = await link(x.token);
    await propose(x);
    const id = lastTo(number).id;
    await webhook({ statuses: [{ id, status: 'read', timestamp: '1', recipient_id: number.slice(1) }] }).expect(200);
    await webhook({ statuses: [{ id, status: 'delivered', timestamp: '0', recipient_id: number.slice(1) }] }).expect(200);
    const [row] = await db.system((tx) => tx.select().from(outboundMessages).where(eq(outboundMessages.providerMessageId, id)));
    expect(row!.status).toBe('read');
    const log = (await http.get('/v1/channels/messages').set(auth(x.token)).expect(200)).body;
    expect(log.some((m: any) => m.kind === 'approval_card' && m.status === 'read')).toBe(true);
  });

  it('lets a developer play the phone in simulated mode', async () => {
    const x = await setup();
    const number = phone();
    const { code } = (await http.post('/v1/me/whatsapp/link').set(auth(x.token)).expect(201)).body;
    await http.post('/v1/me/whatsapp/simulator').set(auth(x.token)).send({ from: '0' + number.slice(4), text: code }).expect(200);
    const task = await propose(x);
    const thread = (await http.get('/v1/me/whatsapp/simulator').set(auth(x.token)).expect(200)).body;
    expect(thread.phone).toBe(number);
    const card = thread.items.filter((m: any) => m.kind === 'approval_card').at(-1);
    await http.post('/v1/me/whatsapp/simulator').set(auth(x.token)).send({ payload: card.content.buttons[1].id, title: 'Reject' }).expect(200);
    expect((await http.get(`/v1/agent-tasks/${task.id}`).set(auth(x.token))).body.status).toBe('rejected');
    // No stray prompts for this task remain usable.
    const open = await db.system((tx) => tx.select().from(approvalPrompts).where(and(eq(approvalPrompts.taskId, task.id), inArray(approvalPrompts.outcome, ['rejected']))));
    expect(open).toHaveLength(1);
  });
});

describe('Daily digest', () => {
  /** 17:30 UTC = 20:30 in Riyadh: outside the default 08:00 slot, so other test users stay quiet. */
  const EVENING = new Date('2026-11-08T17:30:00Z');

  it('summarises what needs the person, scoped to what they may see', async () => {
    const x = await setup();
    await link(x.token);
    await propose(x); // chicken at 3 kg (reorder at 4): one decision waiting, one item low
    await http.post(`/v1/supplier-items/${x.lineId}/prices`).set(auth(x.token)).send({ price: 26.5 }).expect(201); // +7.1%
    const late = (
      await http
        .post('/v1/purchase-orders')
        .set(auth(x.token))
        .send({ siteId: x.site.id, relationshipId: x.wat.id, deliveryDate: '2026-01-05', submit: true, lines: [{ supplierItemId: x.lineId, qty: 1 }] })
        .expect(201)
    ).body;
    await http.post(`/v1/purchase-orders/${late.id}/send`).set(auth(x.token)).send({ via: 'email' }).expect((r) => expect([200, 201]).toContain(r.status));

    const d = (await http.post('/v1/me/whatsapp/digest').set(auth(x.token)).send({}).expect(200)).body;
    expect(d.counts).toMatchObject({ waiting: 1, lowItems: 1, lowSites: 1, priceRises: 1, late: 1 });
    expect(d.text).toContain('*Waiting for your decision (1)*');
    expect(d.text).toContain('Order for Olaya from Al Watania');
    expect(d.text).toContain('*Stock*: 1 item low at 1 site: Chicken breast');
    expect(d.text).toContain('Chicken breast +7.1%');
    expect(d.text).toContain(`1 late: ${late.number}`);
    expect(d.summary).toBe('1 decision waiting · 1 late · 1 item low · 1 price rise');
    expect(d.queued).toBe(false);

    // A manager of another site sees none of Olaya's business.
    const malqa = (await http.post('/v1/sites').set(auth(x.token)).send({ legalEntityId: x.legalEntityId, name: 'Malqa' }).expect(201)).body;
    const mgr = await invite(x.token, 'site_manager', [malqa.id]);
    const md = (await http.post('/v1/me/whatsapp/digest').set(auth(mgr)).send({}).expect(200)).body;
    expect(md.counts).toMatchObject({ waiting: 0, lowItems: 0, late: 0 });
    expect(md.counts.priceRises).toBe(1); // prices are org-wide catalogue data, and site managers may read them
  });

  it('goes out once a day at the chosen hour, as a template outside the 24-hour window', async () => {
    const x = await setup();
    const number = await link(x.token);
    await propose(x);
    await http.patch('/v1/me/whatsapp').set(auth(x.token)).send({ digestHour: 20 }).expect(200);
    await db.system((tx) => tx.update(userChannels).set({ lastInboundAt: new Date(Date.now() - 30 * 3600_000) }).where(eq(userChannels.address, number)));

    expect(await digests.runDue(new Date('2026-11-08T16:59:00Z'))).toBe(0); // 19:59: not yet
    const before = sentTo(number).length;
    await digests.runDue(EVENING);
    await digests.runDue(EVENING); // a second worker, or a restart: no repeat
    await channels.deliver();
    const sent = sentTo(number).slice(before);
    expect(sent).toHaveLength(1);
    const body = cloudRequestBody(number, sent[0]!.content, sent[0]!.form) as any;
    expect(sent[0]!.form).toBe('template');
    expect(body.template.name).toBe('boh_daily_digest');
    const [params, show, url] = body.template.components;
    expect(params.parameters[2].text).toContain('1 decision waiting');
    expect(show.parameters[0].payload).toMatch(/^dig:/);
    expect(url).toMatchObject({ sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'inbox' }] });

    // "Show decisions" opens the window: the waiting card comes again, interactive.
    await tap(number, show.parameters[0].payload).expect(200);
    const card = lastTo(number);
    expect(card.form).toBe('interactive');
    expect(card.content.buttons!.map((b) => b.title)).toEqual(['Approve', 'Reject']);
    await tap(number, card.content.buttons![0]!.id).expect(200);
    expect(lastTo(number).content.text).toContain('order PO-');
  });

  it('records quiet days without sending, and respects the off switch', async () => {
    const quiet = await setup();
    const n1 = await link(quiet.token);
    await http.patch('/v1/me/whatsapp').set(auth(quiet.token)).send({ digestHour: 20 }).expect(200);
    const off = await setup();
    const n2 = await link(off.token);
    await propose(off);
    await http.patch('/v1/me/whatsapp').set(auth(off.token)).send({ digestHour: 20, digestEnabled: false }).expect(200);
    const before = [sentTo(n1).length, sentTo(n2).length];
    await digests.runDue(EVENING);
    await channels.deliver();
    expect([sentTo(n1).length, sentTo(n2).length]).toEqual(before);
    const me = (await http.get('/v1/auth/me').set(auth(quiet.token))).body;
    const runs = await db.system((tx) => tx.select().from(digestRuns).where(eq(digestRuns.userId, me.user.id)));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outboundMessageId).toBeNull();

    // Nothing waiting: the button says so.
    await tap(n1, `dig:${me.currentOrgId}`).expect(200);
    expect(lastTo(n1).content.text).toContain('Nothing is waiting');
  });

  it('validates preferences', async () => {
    const x = await setup();
    await link(x.token);
    await http.patch('/v1/me/whatsapp').set(auth(x.token)).send({ digestHour: 25 }).expect(400);
    await http.patch('/v1/me/whatsapp').set(auth(x.token)).send({ timeZone: 'Mars/Olympus' }).expect(400); // any real IANA zone is fine; made-up ones are not
    const ok = (await http.patch('/v1/me/whatsapp').set(auth(x.token)).send({ digestHour: 7, timeZone: 'Asia/Dubai' }).expect(200)).body;
    expect(ok.linked).toMatchObject({ digestEnabled: true, digestHour: 7, timeZone: 'Asia/Dubai' });
  });
});
