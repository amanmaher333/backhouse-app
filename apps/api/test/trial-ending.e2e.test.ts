import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { outboundMessages, runMigrations, subscriptions, trialNotices, userChannels } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { ChannelsService } from '../src/channels/channels.service.js';
import { cloudRequestBody, WHATSAPP_TRANSPORT, type SimulatedTransport } from '../src/channels/transport.js';
import { DbService } from '../src/common/db.service.js';
import { TrialEndingService } from '../src/modules/trial-ending.js';
import { ubl, vat } from './invoice-fixtures.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const SECRET = 'test-app-secret';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const phone = () => `+9665${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
let app: INestApplication;
let http: ReturnType<typeof request>;
let channels: ChannelsService;
let trial: TrialEndingService;
let sim: SimulatedTransport;
let db: DbService;

const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
let seq = 0;
function say(from: string, body: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: [{ id: `wamid.t${Date.now()}${seq++}`, from: from.slice(1), type: 'text', text: { body } }] } }] }] });
  return http.post('/v1/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sign(raw)).send(raw);
}
const sentTo = (to: string) => sim.sent.filter((m) => m.to === to);
/** Deliver only this test's queued messages (the worker's batch spans every org in the shared database). */
async function deliverTo(...numbers: string[]) {
  const rows = await db.system((tx) => tx.select({ id: outboundMessages.id }).from(outboundMessages).where(and(eq(outboundMessages.status, 'queued'), inArray(outboundMessages.toAddress, numbers))));
  if (rows.length) await channels.deliver(rows.map((r) => r.id));
}
const endsIn = (orgId: string, hours: number) => db.system((tx) => tx.update(subscriptions).set({ trialEndsAt: new Date(Date.now() + hours * 3600_000) }).where(eq(subscriptions.orgId, orgId)));
const trialText = (n: string) => sentTo(n).filter((m) => (m.content.text ?? '').includes('trial ends on') || m.form === 'template');

async function signup() {
  return (await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', locale: 'en', organization: { name: `Najd ${uniq()}` } }).expect(201)).body;
}
async function link(token: string) {
  const number = phone();
  const { code } = (await http.post('/v1/me/whatsapp/link').set(auth(token)).expect(201)).body;
  await say(number, code).expect(200);
  await deliverTo(number);
  return number;
}
/** A duplicate invoice rejected during the trial: 20 × 24.75 + VAT = 569.25 saved. */
async function duplicateSaving(o: any) {
  const token = o.accessToken;
  const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: o.legalEntity.id, name: 'Olaya' }).expect(201)).body;
  const supplierVat = vat();
  const chicken = (await http.post('/v1/items').set(auth(token)).send({ name: 'Chicken breast' }).expect(201)).body;
  const sup = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Al Wafra Foods', vatNumber: supplierVat, contactEmail: 'sales@wafra.sa' }).expect(201)).body;
  const line = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(token)).send({ itemId: chicken.id, packId: chicken.packs[0].id, supplierSku: 'CH-1', price: 24.75 }).expect(201)).body;
  const po = (await http.post('/v1/purchase-orders').set(auth(token)).send({ siteId: site.id, relationshipId: sup.id, lines: [{ supplierItemId: line.id, qty: 20 }], submit: true }).expect(201)).body;
  const pl = (await http.get(`/v1/purchase-orders/${po.id}`).set(auth(token)).expect(200)).body.lines[0];
  await http.post(`/v1/purchase-orders/${po.id}/receive`).set(auth(token)).send({ lines: [{ lineId: pl.id, qty: 20 }] }).expect(200);
  const upload = async (desc: string) =>
    (await http.post('/v1/supplier-invoices/upload').set(auth(token)).send({ filename: 'i.xml', contentType: 'application/xml', data: Buffer.from(ubl({ number: 'INV-9', supplierVat, po: po.number, lines: [{ name: desc, sku: 'CH-1', qty: 20, price: 24.75 }] })).toString('base64') }).expect(201)).body;
  await upload('Chicken');
  const dup = await upload('Chicken breast');
  await http.post(`/v1/supplier-invoices/${dup.id}/reject`).set(auth(token)).send({ reason: 'Duplicate' }).expect(200);
  return site;
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', WHATSAPP_MODE: 'simulated', WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me', NODE_ENV: 'test' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
  channels = app.get(ChannelsService);
  trial = app.get(TrialEndingService);
  sim = app.get(WHATSAPP_TRANSPORT);
  db = app.get(DbService);
});
afterAll(async () => {
  await app?.close();
});

describe('Trial ending reminder on WhatsApp', () => {
  it('tells the owner what the trial saved against the price, once, a few days before the end', async () => {
    const o = await signup();
    const number = await link(o.accessToken);
    const site = await duplicateSaving(o);

    // Someone who can't decide on billing gets nothing, even with WhatsApp linked.
    const roles = (await http.get('/v1/roles').set(auth(o.accessToken)).expect(200)).body;
    const inv = (await http.post('/v1/invitations').set(auth(o.accessToken)).send({ email: `${uniq()}@t.sa`, roleId: roles.find((r: any) => r.key === 'staff').id, siteIds: [site.id] }).expect(201)).body;
    const staff = (await http.post('/v1/auth/accept-invitation').send({ token: inv.token, password: PASSWORD, fullName: 'Staff', locale: 'en' }).expect(201)).body.accessToken;
    const staffNumber = await link(staff);

    // A month away: not yet.
    await trial.runDue();
    await deliverTo(number);
    expect(trialText(number)).toHaveLength(0);

    // Less than a day left: due at any hour.
    await endsIn(o.organization.id, 20);
    await trial.runDue();
    await trial.runDue(); // a second worker, or a restart: no repeat
    await deliverTo(number, staffNumber);
    const msgs = trialText(number);
    expect(msgs).toHaveLength(1);
    const text = msgs[0]!.content.text;
    expect(text).toContain('Your Kitchain trial ends on');
    expect(text).toContain('So far Kitchain has saved you *SAR 569.25*');
    expect(text).toContain('Duplicate invoices stopped: SAR 569.25');
    expect(text).toMatch(/The plan is SAR [\d,.]+ a month; what you saved already covers it [\d.]+×\./);
    expect(text).toContain('1 day left. Choose a plan to keep your agents working:');
    expect(text).toMatch(/\/billing$/);
    expect(trialText(staffNumber)).toHaveLength(0);

    const notices = await db.system((tx) => tx.select().from(trialNotices).where(eq(trialNotices.orgId, o.organization.id)));
    const owner = notices.find((n) => n.outboundMessageId);
    expect(owner?.details).toMatchObject({ saved: '569.25', planChosen: false });
    expect(notices.find((n) => !n.outboundMessageId)?.details).toMatchObject({ skipped: 'not a billing manager' });
  });

  it('asks for nothing when a plan is already chosen, and uses the template outside the window', async () => {
    const o = await signup();
    const number = await link(o.accessToken);
    await http.post('/v1/billing/payment-method').set(auth(o.accessToken)).send({ token: 'tok_sim_visa_4242' }).expect(200);
    await http.post('/v1/billing/subscribe').set(auth(o.accessToken)).send({ interval: 'month' }).expect(200);
    await endsIn(o.organization.id, 20);
    await trial.runDue();
    await deliverTo(number);
    const text = trialText(number).at(-1)!.content.text;
    expect(text).toContain('Your monthly plan starts by itself on');
    expect(text).toContain('Nothing to do.');
    expect(text).not.toContain('Choose a plan');

    // Outside the 24-hour window: the approved template, with the price and a link to Billing.
    const late = await signup();
    const n2 = await link(late.accessToken);
    await db.system((tx) => tx.update(userChannels).set({ lastInboundAt: new Date(Date.now() - 30 * 3600_000) }).where(eq(userChannels.address, n2)));
    await endsIn(late.organization.id, 20);
    await trial.runDue();
    await deliverTo(n2);
    const msg = sentTo(n2).at(-1)!;
    expect(msg.form).toBe('template');
    const body = cloudRequestBody(n2, msg.content, msg.form) as any;
    expect(body.template.name).toBe('boh_trial_ending');
    const params = body.template.components.find((c: any) => c.type === 'body').parameters.map((p: any) => p.text);
    expect(params[2]).toBe('SAR 0.00');
    expect(params[3]).toMatch(/^SAR [\d,.]+$/);
    expect(body.template.components.find((c: any) => c.type === 'button')).toMatchObject({ sub_type: 'url', index: '0', parameters: [{ text: 'billing' }] });
  });
});
