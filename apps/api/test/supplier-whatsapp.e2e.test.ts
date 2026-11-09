import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { ChannelsService } from '../src/channels/channels.service.js';
import { cloudRequestBody, WHATSAPP_TRANSPORT, type SimulatedTransport } from '../src/channels/transport.js';

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

const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
function webhook(value: Record<string, unknown>) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...value } }] }] });
  return http.post('/v1/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sign(raw)).send(raw);
}
let seq = 0;
const text = (from: string, body: string) => webhook({ messages: [{ id: `wamid.s${Date.now()}${seq++}`, from: from.slice(1), type: 'text', text: { body } }] });
const tap = (from: string, payload: string, title = 'x') =>
  webhook({ messages: [{ id: `wamid.s${Date.now()}${seq++}`, from: from.slice(1), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: payload, title } } }] });
const sentTo = (to: string) => sim.sent.filter((m) => m.to === to);
const lastTo = (to: string) => sentTo(to).at(-1)!;

async function link(token: string) {
  const number = phone();
  const { code } = (await http.post('/v1/me/whatsapp/link').set(auth(token)).expect(201)).body;
  await text(number, code).expect(200);
  return number;
}

/** A restaurant whose supplier takes orders on WhatsApp, an approved order to it, and the owner's WhatsApp linked. */
async function setup(opts: { channel?: 'whatsapp' | 'email'; deliveryDate?: string; hidePrices?: boolean; cr?: string } = {}) {
  const s = await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Sara', locale: 'en', organization: { name: 'Najd Kitchens', nameAr: 'مطابخ نجد' }, legalEntity: { name: 'Najd Kitchens Co.', nameAr: 'شركة مطابخ نجد', crNumber: opts.cr ?? `101${String(Math.floor(Math.random() * 1e7)).padStart(7, '1')}` } }).expect(201);
  const token = s.body.accessToken as string;
  const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: s.body.legalEntity.id, name: 'Olaya', nameAr: 'العليا' }).expect(201)).body;
  const chicken = (await http.post('/v1/items').set(auth(token)).send({ name: 'Chicken breast', nameAr: 'صدور دجاج' }).expect(201)).body;
  const supplierPhone = phone();
  const wat = (
    await http
      .post('/v1/suppliers')
      .set(auth(token))
      .send({ displayName: 'Al Watania', displayNameAr: 'الوطنية', orderChannel: opts.channel ?? 'whatsapp', contactPhone: supplierPhone, contactEmail: 'o@w.sa', hidePricesOnPo: opts.hidePrices ?? false })
      .expect(201)
  ).body;
  const line = (await http.post(`/v1/suppliers/${wat.id}/items`).set(auth(token)).send({ itemId: chicken.id, packId: chicken.packs[0].id, price: 24.75, isPreferred: true, supplierSku: 'WT-310' }).expect(201)).body;
  const agent = (await http.post('/v1/agents').set(auth(token)).send({ kind: 'purchasing' }).expect(201)).body;
  const po = (
    await http
      .post('/v1/purchase-orders')
      .set(auth(token))
      .send({ siteId: site.id, relationshipId: wat.id, deliveryDate: opts.deliveryDate ?? '2026-11-10', submit: true, lines: [{ supplierItemId: line.id, qty: 9 }] })
      .expect(201)
  ).body;
  const owner = await link(token);
  return { token, site, wat, po, supplierPhone, owner, agentId: agent.agent.id as string };
}

async function sendDirect(x: Awaited<ReturnType<typeof setup>>) {
  const sent = (await http.post(`/v1/purchase-orders/${x.po.id}/send`).set(auth(x.token)).send({}).expect(200)).body;
  await channels.deliver();
  const msg = lastTo(x.supplierPhone);
  const token = msg.content.template!.urlSuffix!;
  return { sent, msg, token };
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(
    loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', WHATSAPP_MODE: 'simulated', WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'v', NODE_ENV: 'test' }),
    { logger: false },
  );
  await app.init();
  http = request(app.getHttpServer());
  runtime = app.get(AgentRuntime);
  channels = app.get(ChannelsService);
  sim = app.get(WHATSAPP_TRANSPORT);
});
afterAll(async () => {
  await app?.close();
});

describe('Sending orders to suppliers on WhatsApp', () => {
  it('sends the order from Backhouse with Confirm / Problem buttons and a private link', async () => {
    const x = await setup();
    const { sent, msg, token } = await sendDirect(x);
    expect(sent).toMatchObject({ status: 'sent', sentVia: 'whatsapp_direct', direct: { to: x.supplierPhone } });
    expect(sent.direct.viewUrl).toContain(`/s/${token}`);

    // The supplier never wrote to Backhouse: the approved template is used.
    expect(msg.form).toBe('template');
    const body = cloudRequestBody(x.supplierPhone, msg.content, msg.form) as any;
    expect(body.template).toMatchObject({ name: 'boh_purchase_order', language: { code: 'ar' } });
    const [params, confirm, problem, url] = body.template.components;
    expect(params.parameters.map((p: any) => p.text)).toEqual(['مطابخ نجد', x.po.number, 'العليا', '2026-11-10', '1 صنف · 256.16 ر.س شامل الضريبة']);
    expect(confirm.parameters[0].payload).toMatch(/^sup:.+:c$/);
    expect(problem.parameters[0].payload).toMatch(/^sup:.+:p$/);
    expect(url).toMatchObject({ sub_type: 'url', parameters: [{ text: token }] });
    expect(msg.content.text).toContain('صدور دجاج — 9 × 1 كجم (WT-310)');

    // The private link shows the order without an account.
    const view = (await http.get(`/v1/supplier-orders/${token}`).expect(200)).body;
    expect(view).toMatchObject({ number: x.po.number, restaurant: { nameAr: 'مطابخ نجد' }, site: { name: 'Olaya' }, canAnswer: true, confirmedAt: null });
    expect(view.lines[0]).toMatchObject({ itemName: 'Chicken breast', supplierSku: 'WT-310', unitPrice: '24.7500' });
    await http.get('/v1/supplier-orders/not-a-real-token').expect(404);

    // Confirm from the supplier's phone.
    await tap(x.supplierPhone, confirm.parameters[0].payload, 'تأكيد / Confirm').expect(200);
    expect(lastTo(x.supplierPhone)).toMatchObject({ form: 'text' }); // the tap opened the window
    expect(lastTo(x.supplierPhone).content.text).toContain(`order ${x.po.number} is confirmed`);
    const po = (await http.get(`/v1/purchase-orders/${x.po.id}`).set(auth(x.token)).expect(200)).body;
    expect(po).toMatchObject({ supplierConfirmedVia: 'whatsapp' });
    expect(po.supplierConfirmedAt).toBeTruthy();
    expect(po.conversation.map((m: any) => [m.dir, m.kind])).toEqual([
      ['to_supplier', 'supplier_order'],
      ['from_supplier', 'interactive'],
      ['to_supplier', 'supplier_ack'],
    ]);
    await tap(x.supplierPhone, confirm.parameters[0].payload).expect(200);
    expect(lastTo(x.supplierPhone).content.text).toContain('already confirmed');
  });

  it('takes a problem, tells the restaurant and puts it in the inbox', async () => {
    const x = await setup();
    const { msg } = await sendDirect(x);
    const problemPayload = msg.content.buttons![1]!.id;

    // Someone else's phone cannot answer for the supplier.
    const stranger = phone();
    await tap(stranger, problemPayload).expect(200);
    expect(lastTo(stranger).content.text).toContain('not for this number');

    await tap(x.supplierPhone, problemPayload, 'مشكلة / Problem').expect(200);
    expect(lastTo(x.supplierPhone).content.text).toContain('describe the problem');
    const ownerBefore = sentTo(x.owner).length;
    await text(x.supplierPhone, 'No chicken until Thursday, can deliver 5 kg tomorrow').expect(200);
    expect(lastTo(x.supplierPhone).content.text).toContain('we have told Najd Kitchens');

    const po = (await http.get(`/v1/purchase-orders/${x.po.id}`).set(auth(x.token)).expect(200)).body;
    expect(po.supplierIssue).toBe('No chicken until Thursday, can deliver 5 kg tomorrow');
    // The owner manages this site's orders and has WhatsApp: they hear about it.
    const notice = sentTo(x.owner).slice(ownerBefore).at(-1)!;
    expect(notice.content.text).toContain(`*Al Watania* reported a problem with order ${x.po.number}`);
    expect(notice.content.text).toContain(`/orders/${x.po.id}`);

    await runtime.run(x.agentId, 'event');
    const tasks = (await http.get('/v1/agent-tasks').set(auth(x.token)).expect(200)).body;
    const t = tasks.find((k: any) => k.kind === 'supplier_reply');
    expect(t).toMatchObject({ priority: 1, title: `Al Watania reported a problem with ${x.po.number}` });
    expect(t.evidence).toMatchObject({ poId: x.po.id, replyKind: 'problem', via: 'whatsapp' });
  });

  it('relays other messages from the supplier onto their latest order', async () => {
    const x = await setup();
    await sendDirect(x);
    await text(x.supplierPhone, 'Driver will arrive around 9am').expect(200);
    expect(lastTo(x.supplierPhone).content.text).toContain('your message has been passed to Najd Kitchens');
    await runtime.run(x.agentId, 'event');
    const t = (await http.get('/v1/agent-tasks').set(auth(x.token)).expect(200)).body.find((k: any) => k.kind === 'supplier_reply');
    expect(t).toMatchObject({ priority: 2, summary: '“Driver will arrive around 9am”' });
  });

  it('lets the supplier confirm or report a problem from the link, and can hide prices', async () => {
    const x = await setup({ hidePrices: true });
    const { token, msg } = await sendDirect(x);
    expect((cloudRequestBody(x.supplierPhone, msg.content, msg.form) as any).template.components[0].parameters[4].text).toBe('1 صنف');
    const view = (await http.get(`/v1/supplier-orders/${token}`).expect(200)).body;
    expect(view.lines[0].unitPrice).toBeNull();
    expect(view.totals).toBeNull();
    await http.post(`/v1/supplier-orders/${token}/problem`).send({ message: '' }).expect(400);
    await http.post(`/v1/supplier-orders/${token}/problem`).send({ message: 'Price changed to 26.50' }).expect(200);
    expect((await http.post(`/v1/supplier-orders/${token}/confirm`).expect(200)).body.outcome).toBe('confirmed');
    const po = (await http.get(`/v1/purchase-orders/${x.po.id}`).set(auth(x.token))).body;
    expect(po).toMatchObject({ supplierConfirmedVia: 'link', supplierIssue: 'Price changed to 26.50' });
  });

  it('keeps the old way for email suppliers, and refuses direct sending without a number', async () => {
    const x = await setup({ channel: 'email' });
    const sent = (await http.post(`/v1/purchase-orders/${x.po.id}/send`).set(auth(x.token)).send({}).expect(200)).body;
    expect(sent.direct).toBeNull();
    expect(sent.links.mailto).toContain('mailto:o@w.sa');

    const y = await setup();
    await http.patch(`/v1/suppliers/${y.wat.id}`).set(auth(y.token)).send({ contactPhone: null, orderChannel: 'email' }).expect(200);
    await http.post(`/v1/purchase-orders/${y.po.id}/send`).set(auth(y.token)).send({ direct: true }).expect(400);
  });

  it('only lets verified companies send through Backhouse’s number', async () => {
    const x = await setup({ cr: '1010120000' }); // not in the register: rejected
    const res = await http.post(`/v1/purchase-orders/${x.po.id}/send`).set(auth(x.token)).send({ direct: true }).expect(400);
    expect(res.body.message).toContain('Verify your company');
    // Sending it themselves still works.
    expect((await http.post(`/v1/purchase-orders/${x.po.id}/send`).set(auth(x.token)).send({ direct: false }).expect(200)).body.direct).toBeNull();
  });

  it('sends the Purchasing agent’s late-delivery chaser directly once approved', async () => {
    const x = await setup({ deliveryDate: '2026-01-05' });
    await sendDirect(x);
    await runtime.run(x.agentId, 'manual', { scan: true });
    const task = (await http.get('/v1/agent-tasks').set(auth(x.token)).expect(200)).body.find((k: any) => k.kind === 'po_overdue');
    const done = (await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(x.token)).send({ actionId: 'contact' }).expect(200)).body;
    expect(done.result).toMatchObject({ sentDirect: true, to: x.supplierPhone });
    await channels.deliver();
    const chaser = lastTo(x.supplierPhone);
    expect(chaser.form).toBe('template');
    expect(chaser.content.template!.name).toBe('boh_supplier_followup');
    expect(chaser.content.text).toContain(`طلبنا ${x.po.number}`);
    const po = (await http.get(`/v1/purchase-orders/${x.po.id}`).set(auth(x.token))).body;
    expect(po.conversation.at(-1)).toMatchObject({ dir: 'to_supplier', kind: 'supplier_followup' });
  });
});
