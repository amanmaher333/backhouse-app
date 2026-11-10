import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { outboundMessages, runMigrations, savingsReports, userChannels } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { ChannelsService } from '../src/channels/channels.service.js';
import { cloudRequestBody, WHATSAPP_TRANSPORT, type SimulatedTransport } from '../src/channels/transport.js';
import { DbService } from '../src/common/db.service.js';
import { MonthlySavingsService } from '../src/modules/savings-monthly.js';
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
let monthly: MonthlySavingsService;
let sim: SimulatedTransport;
let db: DbService;

const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
let seq = 0;
function say(from: string, body: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: [{ id: `wamid.m${Date.now()}${seq++}`, from: from.slice(1), type: 'text', text: { body } }] } }] }] });
  return http.post('/v1/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sign(raw)).send(raw);
}
const sentTo = (to: string) => sim.sent.filter((m) => m.to === to);
/** Deliver only this test's queued messages (the worker's batch spans every org in the shared database). */
async function deliverTo(...numbers: string[]) {
  const rows = await db.system((tx) => tx.select({ id: outboundMessages.id }).from(outboundMessages).where(and(eq(outboundMessages.status, 'queued'), inArray(outboundMessages.toAddress, numbers))));
  if (rows.length) await channels.deliver(rows.map((r) => r.id));
}
/** 09:00 in Riyadh on the 1st of next month: when this month's report goes out. */
function firstOfNextMonth() {
  const riyadh = new Date(Date.now() + 3 * 3600_000);
  return new Date(Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth() + 1, 1, 6, 0));
}

async function signup(locale?: 'en') {
  return (await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', locale, organization: { name: `Najd ${uniq()}` } }).expect(201)).body;
}
async function link(token: string) {
  const number = phone();
  const { code } = (await http.post('/v1/me/whatsapp/link').set(auth(token)).expect(201)).body;
  await say(number, code).expect(200);
  await deliverTo(number);
  return number;
}
/** A duplicate invoice rejected this month: a saving of its whole total. */
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
    (await http.post('/v1/supplier-invoices/upload').set(auth(token)).send({ filename: 'i.xml', contentType: 'application/xml', data: Buffer.from(ubl({ number: 'INV-77', supplierVat, po: po.number, lines: [{ name: desc, sku: 'CH-1', qty: 20, price: 24.75 }] })).toString('base64') }).expect(201)).body;
  await upload('Chicken');
  const dup = await upload('Chicken breast');
  await http.post(`/v1/supplier-invoices/${dup.id}/reject`).set(auth(token)).send({ reason: 'Duplicate' }).expect(200);
  return dup.total as string; // 20 × 24.75 + 15% VAT = 569.25
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', WHATSAPP_MODE: 'simulated', WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me', NODE_ENV: 'test' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
  channels = app.get(ChannelsService);
  monthly = app.get(MonthlySavingsService);
  sim = app.get(WHATSAPP_TRANSPORT);
  db = app.get(DbService);
});
afterAll(async () => {
  await app?.close();
});

describe('Monthly savings report on WhatsApp', () => {
  it('sends last month’s savings on the 1st, once, and skips quiet months', async () => {
    const o = await signup('en');
    const number = await link(o.accessToken);
    const total = await duplicateSaving(o);
    expect(total).toBe('569.25');

    // A second organisation with nothing to report.
    const quiet = await signup('en');
    const quietNumber = await link(quiet.accessToken);

    const when = firstOfNextMonth();
    const before = sentTo(number).length;
    // The last day of this month is not the 1st: nothing yet.
    expect(await monthly.runDue(new Date(when.getTime() - 24 * 3600_000))).toBeGreaterThanOrEqual(0);
    await deliverTo(number);
    expect(sentTo(number).length).toBe(before);

    await monthly.runDue(when);
    await monthly.runDue(when); // a second worker, or a restart: no repeat
    await deliverTo(number, quietNumber);
    const sent = sentTo(number).slice(before);
    expect(sent).toHaveLength(1);
    const text = sent[0]!.content.text;
    expect(text).toContain('Savings in');
    expect(text).toContain('Kitchain saved you *SAR 569.25*');
    expect(text).toContain('Duplicate invoices stopped: SAR 569.25');
    expect(text).toMatch(/savings\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}/);
    expect(sent[0]!.form).toBe('text'); // they wrote in the last 24 hours (linking)

    // Recorded once per person, organisation and month, with the figures.
    const [row] = await db.system((tx) => tx.select().from(savingsReports).where(eq(savingsReports.orgId, o.organization.id)));
    expect(row).toMatchObject({ saved: '569.25', inProgress: '0.00' });
    expect(row!.outboundMessageId).toBeTruthy();
    // The quiet organisation: recorded, not sent.
    const [q] = await db.system((tx) => tx.select().from(savingsReports).where(eq(savingsReports.orgId, quiet.organization.id)));
    expect(q).toMatchObject({ saved: '0.00', outboundMessageId: null });
    expect(sentTo(quietNumber).filter((m) => m.content.text?.includes('Savings in'))).toHaveLength(0);
  });

  it('uses the approved template outside the 24-hour window, and can be turned off', async () => {
    const o = await signup('en');
    const number = await link(o.accessToken);
    await duplicateSaving(o);
    await db.system((tx) => tx.update(userChannels).set({ lastInboundAt: new Date(Date.now() - 30 * 3600_000) }).where(eq(userChannels.address, number)));

    await monthly.runDue(firstOfNextMonth());
    await deliverTo(number);
    const msg = sentTo(number).at(-1)!;
    expect(msg.form).toBe('template');
    const body = cloudRequestBody(number, msg.content, msg.form) as any;
    expect(body.template.name).toBe('boh_monthly_savings');
    const params = body.template.components.find((c: any) => c.type === 'body').parameters.map((p: any) => p.text);
    expect(params[2]).toBe('SAR 569.25');
    expect(params[3]).toBe('Duplicate invoices stopped: SAR 569.25');
    const button = body.template.components.find((c: any) => c.type === 'button');
    expect(button).toMatchObject({ sub_type: 'url', index: '0' });

    // Turned off: nothing the next month either.
    const off = await signup('en');
    const n2 = await link(off.accessToken);
    await duplicateSaving(off);
    await http.patch('/v1/me/whatsapp').set(auth(off.accessToken)).send({ monthlySavingsEnabled: false }).expect(200);
    expect((await http.get('/v1/me/whatsapp').set(auth(off.accessToken))).body.linked.monthlySavingsEnabled).toBe(false);
    const before = sentTo(n2).length;
    await monthly.runDue(firstOfNextMonth());
    await deliverTo(n2);
    expect(sentTo(n2).length).toBe(before);
  });

  it('previews last month’s report and can send it now', async () => {
    const o = await signup('en');
    const number = await link(o.accessToken);
    const p = (await http.post('/v1/savings/monthly-message').set(auth(o.accessToken)).send({}).expect(200)).body;
    expect(p).toMatchObject({ empty: true, queued: false });
    expect(p.text).toMatch(/No confirmed savings in \w+ \d{4}\./);
    const before = sentTo(number).length;
    const s = (await http.post('/v1/savings/monthly-message').set(auth(o.accessToken)).send({ send: true }).expect(200)).body;
    expect(s.queued).toBe(true);
    expect(sentTo(number).length).toBe(before + 1);
  });
});
