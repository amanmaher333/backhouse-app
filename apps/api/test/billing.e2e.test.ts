import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { agentRuns, runMigrations, subscriptions } from '@boh/db';
import { decodeZatcaQr } from '@boh/domain';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { BillingService } from '../src/billing/billing.service.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { DbService } from '../src/common/db.service.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let app: INestApplication;
let http: ReturnType<typeof request>;
let billing: BillingService;
let runtime: AgentRuntime;
let db: DbService;

async function signup(type: 'restaurant_group' | 'supplier' = 'restaurant_group') {
  const s = await http
    .post('/v1/auth/signup')
    .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Sara', organization: { name: `Org ${uniq()}`, type }, legalEntity: { name: 'Najd Kitchens LLC', vatNumber: '310122393500003', crNumber: '1010123456' } })
    .expect(201);
  return { token: s.body.accessToken as string, orgId: s.body.organization?.id as string, legalEntityId: s.body.legalEntity?.id as string };
}

/** A restaurant group with two sites and the Purchasing agent: SAR 400 + 2 × 350 = 1,100 + VAT. */
async function restaurant() {
  const x = await signup();
  const le = (await http.get('/v1/legal-entities').set(auth(x.token))).body[0];
  for (const name of ['Olaya', 'Malqa']) await http.post('/v1/sites').set(auth(x.token)).send({ legalEntityId: le.id, name }).expect(201);
  const agent = (await http.post('/v1/agents').set(auth(x.token)).send({ kind: 'purchasing' }).expect(201)).body;
  const me = (await http.get('/v1/auth/me').set(auth(x.token))).body;
  return { ...x, orgId: me.currentOrgId as string, agentId: agent.agent.id as string };
}

const setSub = (orgId: string, values: Partial<typeof subscriptions.$inferInsert>) => db.system((tx) => tx.update(subscriptions).set(values).where(eq(subscriptions.orgId, orgId)));
const past = (mins = 1) => new Date(Date.now() - mins * 60_000);

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', BILLING_PROVIDER: 'simulated', NODE_ENV: 'test' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
  billing = app.get(BillingService);
  runtime = app.get(AgentRuntime);
  db = app.get(DbService);
});
afterAll(async () => {
  await app?.close();
});

describe('Billing', () => {
  it('starts restaurants on a 30-day trial and suppliers free, with a live estimate', async () => {
    const x = await restaurant();
    const b = (await http.get('/v1/billing').set(auth(x.token)).expect(200)).body;
    expect(b).toMatchObject({ plan: 'restaurant', status: 'trialing', entitled: true, paymentMethod: null, interval: null });
    const days = (new Date(b.trialEndsAt).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(b.estimates.month.lines.map((l: any) => [l.code, l.quantity, l.amount])).toEqual([
      ['platform', 1, '400.00'],
      ['agent:purchasing', 2, '700.00'],
    ]);
    expect(b.estimates.month.total).toBe('1265.00');
    expect(b.estimates.year.total).toBe('12650.00'); // ten months for twelve

    const supplier = await signup('supplier');
    expect((await http.get('/v1/billing/status').set(auth(supplier.token)).expect(200)).body).toMatchObject({ plan: 'supplier_free', status: 'free', entitled: true });
  });

  it('only admins and finance see billing; every member sees the status', async () => {
    const x = await restaurant();
    const roles = (await http.get('/v1/roles').set(auth(x.token))).body;
    const inv = await http.post('/v1/invitations').set(auth(x.token)).send({ email: `${uniq()}@t.sa`, roleId: roles.find((r: any) => r.key === 'ops_manager').id }).expect(201);
    const ops = (await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: 'Ops' }).expect(201)).body.accessToken;
    await http.get('/v1/billing').set(auth(ops)).expect(403);
    await http.post('/v1/billing/payment-method').set(auth(ops)).send({ token: 'tok_sim_visa_4242' }).expect(403);
    expect((await http.get('/v1/billing/status').set(auth(ops)).expect(200)).body.status).toBe('trialing');
  });

  it('converts the trial to a paid plan when it ends, with a ZATCA-style invoice', async () => {
    const x = await restaurant();
    await http.post('/v1/billing/payment-method').set(auth(x.token)).send({ token: 'not-a-token' }).expect(400);
    const withCard = (await http.post('/v1/billing/payment-method').set(auth(x.token)).send({ token: 'tok_sim_mada_4321' }).expect(200)).body;
    expect(withCard.paymentMethod).toEqual({ brand: 'mada', last4: '4321', expMonth: 12, expYear: 2030 });
    const chosen = (await http.post('/v1/billing/subscribe').set(auth(x.token)).send({ interval: 'month' }).expect(200)).body;
    expect(chosen).toMatchObject({ status: 'trialing', interval: 'month', invoices: [] }); // nothing charged during the trial

    const trialEnd = past(1);
    await setSub(x.orgId, { trialEndsAt: trialEnd });
    await billing.runDue();
    const b = (await http.get('/v1/billing').set(auth(x.token))).body;
    expect(b).toMatchObject({ status: 'active', entitled: true });
    expect(new Date(b.currentPeriodStart).getTime()).toBe(trialEnd.getTime());
    expect(b.invoices).toHaveLength(1);
    const inv = (await http.get(`/v1/billing/invoices/${b.invoices[0].id}`).set(auth(x.token)).expect(200)).body;
    expect(inv).toMatchObject({ status: 'paid', total: '1265.00', vat: '165.00', interval: 'month', buyer: { vatNumber: '310122393500003', crNumber: '1010123456' } });
    expect(inv.number).toMatch(/^BOH-\d{4}-\d{6}$/);
    const qr = decodeZatcaQr(inv.qr);
    expect([qr[0], qr[1], qr[3], qr[4]]).toEqual(['شركة باك هاوس للتقنية', '300000000000003', '1265.00', '165.00']);

    // Another worker running at the same time does not charge again.
    await billing.runDue();
    expect((await http.get('/v1/billing').set(auth(x.token))).body.invoices).toHaveLength(1);
  });

  it('makes Backhouse read-only when the trial ends without a plan, and pauses agents', async () => {
    const x = await restaurant();
    await setSub(x.orgId, { trialEndsAt: past(1) });
    await billing.runDue();
    expect((await http.get('/v1/billing/status').set(auth(x.token))).body).toMatchObject({ status: 'expired', entitled: false });

    const blocked = await http.post('/v1/items').set(auth(x.token)).send({ name: 'Tomato' }).expect(402);
    expect(blocked.body.code).toBe('subscription_inactive');
    await http.get('/v1/items').set(auth(x.token)).expect(200); // their data stays readable
    const runsBefore = await db.system((tx) => tx.select().from(agentRuns).where(eq(agentRuns.agentId, x.agentId)));
    await db.system((tx) => tx.update(agentRuns).set({ startedAt: past(48 * 60) }).where(eq(agentRuns.agentId, x.agentId))); // daily scan would be due
    await runtime.runDue();
    const runsAfter = await db.system((tx) => tx.select().from(agentRuns).where(eq(agentRuns.agentId, x.agentId)));
    expect(runsAfter).toHaveLength(runsBefore.length);

    // Paying brings it back at once.
    await http.post('/v1/billing/payment-method').set(auth(x.token)).send({ token: 'tok_sim_visa_4242' }).expect(200);
    const paid = (await http.post('/v1/billing/subscribe').set(auth(x.token)).send({ interval: 'year' }).expect(200)).body;
    expect(paid).toMatchObject({ status: 'active', interval: 'year' });
    expect(paid.invoices[0]).toMatchObject({ status: 'paid', total: '12650.00' });
    await http.post('/v1/items').set(auth(x.token)).send({ name: 'Tomato' }).expect(201);
  });

  it('retries a failed renewal, suspends after the third failure, and recovers on payment', async () => {
    const x = await restaurant();
    await http.post('/v1/billing/payment-method').set(auth(x.token)).send({ token: 'tok_sim_visa_0002_decline' }).expect(200);
    await setSub(x.orgId, { status: 'active', interval: 'month', currentPeriodStart: past(31 * 24 * 60), currentPeriodEnd: past(1) });

    await billing.runDue();
    let b = (await http.get('/v1/billing').set(auth(x.token))).body;
    expect(b).toMatchObject({ status: 'past_due', entitled: true, failedAttempts: 1 }); // a grace period
    expect(b.invoices[0]).toMatchObject({ status: 'failed', failureMessage: 'Card declined by the bank' });
    expect((new Date(b.nextRetryAt).getTime() - Date.now()) / 86400_000).toBeCloseTo(1, 1);

    await setSub(x.orgId, { nextRetryAt: past(1) });
    await billing.runDue();
    b = (await http.get('/v1/billing').set(auth(x.token))).body;
    expect(b).toMatchObject({ status: 'past_due', failedAttempts: 2 });
    expect(b.invoices).toHaveLength(1); // the same invoice is retried

    await setSub(x.orgId, { nextRetryAt: past(1) });
    await billing.runDue();
    expect((await http.get('/v1/billing/status').set(auth(x.token))).body).toMatchObject({ status: 'suspended', entitled: false });
    await http.post('/v1/items').set(auth(x.token)).send({ name: 'Rice' }).expect(402);

    await http.post('/v1/billing/payment-method').set(auth(x.token)).send({ token: 'tok_sim_visa_4242' }).expect(200);
    b = (await http.post('/v1/billing/pay-now').set(auth(x.token)).send({}).expect(200)).body;
    expect(b).toMatchObject({ status: 'active', failedAttempts: 0 });
    expect(b.invoices[0].status).toBe('paid');
  });

  it('ends at the period end after cancelling, unless resumed', async () => {
    const x = await restaurant();
    await http.post('/v1/billing/payment-method').set(auth(x.token)).send({ token: 'tok_sim_visa_4242' }).expect(200);
    await setSub(x.orgId, { status: 'active', interval: 'month', currentPeriodStart: past(60), currentPeriodEnd: new Date(Date.now() + 3600_000) });
    expect((await http.post('/v1/billing/cancel').set(auth(x.token)).send({}).expect(200)).body.cancelAtPeriodEnd).toBe(true);
    expect((await http.post('/v1/billing/resume').set(auth(x.token)).send({}).expect(200)).body.cancelAtPeriodEnd).toBe(false);
    await http.post('/v1/billing/cancel').set(auth(x.token)).send({}).expect(200);
    await setSub(x.orgId, { currentPeriodEnd: past(1) });
    await billing.runDue();
    expect((await http.get('/v1/billing/status').set(auth(x.token))).body).toMatchObject({ status: 'canceled', entitled: false });
  });

  it('handles card verification (3-D Secure) through the provider webhook, once', async () => {
    const x = await restaurant();
    await setSub(x.orgId, { status: 'expired' });
    await http.post('/v1/billing/payment-method').set(auth(x.token)).send({ token: 'tok_sim_visa_4242_3ds' }).expect(200);
    const r = (await http.post('/v1/billing/subscribe').set(auth(x.token)).send({ interval: 'month' }).expect(200)).body;
    expect(r.status).toBe('expired');
    expect(r.actionUrl).toMatch(/\/billing\?sim_payment=sim_pay_/);
    const paymentId = new URL(r.actionUrl).searchParams.get('sim_payment')!;

    await http.post('/v1/webhooks/payments').send({ id: 'evt1', type: 'payment_paid', secret_token: 'wrong', data: { id: paymentId } }).expect(401);
    await http.post(`/v1/billing/simulate/${paymentId}`).set(auth(x.token)).send({ outcome: 'paid' }).expect(200);
    const again = await http.post(`/v1/billing/simulate/${paymentId}`).set(auth(x.token)).send({ outcome: 'paid' }).expect(200);
    expect(again.body).toEqual({ duplicate: true });
    expect((await http.get('/v1/billing').set(auth(x.token))).body).toMatchObject({ status: 'active', invoices: [{ status: 'paid' }] });
  });
});
