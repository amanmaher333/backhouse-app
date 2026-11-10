import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { auditEvents, billingInvoices, memberships, organizations, roles, runMigrations, subscriptions } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { DbService } from '../src/common/db.service.js';
import { BillingService } from '../src/billing/billing.service.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let app: INestApplication;
let http: ReturnType<typeof request>;
let db: DbService;
let billing: BillingService;

async function signup() {
  return (await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', locale: 'en', organization: { name: `Najd ${uniq()}` } }).expect(201)).body;
}
/** A Kitchain staff member: a member of the platform organisation (what scripts/platform-admin does). */
async function staff() {
  const s = await signup();
  await db.system(async (tx) => {
    let [org] = await tx.select().from(organizations).where(eq(organizations.type, 'platform')).limit(1);
    if (!org) [org] = await tx.insert(organizations).values({ type: 'platform', name: 'Kitchain', nameAr: 'Kitchain' }).returning();
    const [role] = await tx.select().from(roles).where(and(isNull(roles.orgId), eq(roles.key, 'org_admin')));
    await tx.insert(memberships).values({ orgId: org!.id, userId: s.user.id, roleId: role!.id }).onConflictDoNothing();
  });
  return s.accessToken as string;
}
/** A restaurant group with one site and Price Watch hired: list price 400 + 150 = 550 + VAT = 632.50 a month. */
async function customer() {
  const o = await signup();
  await http.post('/v1/sites').set(auth(o.accessToken)).send({ legalEntityId: o.legalEntity.id, name: 'Olaya' }).expect(201);
  await http.post('/v1/agents').set(auth(o.accessToken)).send({ kind: 'price_watch' }).expect(201);
  return o;
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
  db = app.get(DbService);
  billing = app.get(BillingService);
});
afterAll(async () => {
  await app?.close();
});

describe('Custom pricing per organisation (Kitchain staff)', () => {
  it('lets staff agree prices that the customer’s bill then uses; customers cannot', async () => {
    const admin = await staff();
    const c = await customer();
    expect((await http.get('/v1/billing').set(auth(c.accessToken)).expect(200)).body).toMatchObject({ pricing: null, estimates: { month: { total: '632.50' } } });

    // Only Kitchain staff.
    await http.get('/v1/platform/organizations').set(auth(c.accessToken)).expect(403);
    await http.put(`/v1/platform/organizations/${c.organization.id}/pricing`).set(auth(c.accessToken)).send({ pricing: { label: 'Free', discountPct: 100 } }).expect(403);

    const list = (await http.get(`/v1/platform/organizations?q=${encodeURIComponent(c.organization.name)}`).set(auth(admin)).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ id: c.organization.id, status: 'trialing', activeSites: 1, agents: ['price_watch'], pricing: null, monthly: { list: '632.50', agreed: '632.50' } })]);

    await http.put(`/v1/platform/organizations/${c.organization.id}/pricing`).set(auth(admin)).send({ pricing: { label: 'Design partner', discountPct: 120 } }).expect(400);
    const set = (
      await http
        .put(`/v1/platform/organizations/${c.organization.id}/pricing`)
        .set(auth(admin))
        .send({ pricing: { label: 'Design partner', labelAr: 'شريك تصميم', platformFee: 200, discountPct: 20, until: '2099-12-31', note: 'Agreed with Noura in the pilot call' } })
        .expect(200)
    ).body;
    // (200 + 150) × 0.8 = 280 + VAT = 322.00
    expect(set).toMatchObject({ pricingActive: true, monthly: { list: '632.50', agreed: '322.00' }, pricing: { label: 'Design partner', platformFee: '200.00', discountPct: 20 } });

    const b = (await http.get('/v1/billing').set(auth(c.accessToken)).expect(200)).body;
    expect(b.pricing).toEqual({ label: 'Design partner', labelAr: 'شريك تصميم', platformFee: '200.00', discountPct: 20, until: '2099-12-31' }); // no internal note
    expect(b.estimates.month.lines.map((l: any) => [l.code, l.amount])).toEqual([['platform', '200.00'], ['agent:price_watch', '150.00'], ['discount', '-70.00']]);
    expect(b.estimates.month.total).toBe('322.00');

    const [audit] = await db.system((tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.orgId, c.organization.id), eq(auditEvents.action, 'billing.pricing_set'))).orderBy(desc(auditEvents.occurredAt)).limit(1));
    expect(audit).toBeTruthy();

    // Back to list prices.
    await http.put(`/v1/platform/organizations/${c.organization.id}/pricing`).set(auth(admin)).send({ pricing: null }).expect(200);
    expect((await http.get('/v1/billing').set(auth(c.accessToken)).expect(200)).body).toMatchObject({ pricing: null, estimates: { month: { total: '632.50' } } });
  });

  it('a free plan starts without a card and renews at zero', async () => {
    const admin = await staff();
    const c = await customer();
    // Without agreed pricing a card is needed.
    await http.post('/v1/billing/subscribe').set(auth(c.accessToken)).send({ interval: 'month' }).expect(400);
    await http.put(`/v1/platform/organizations/${c.organization.id}/pricing`).set(auth(admin)).send({ pricing: { label: 'Founding partner', discountPct: 100 } }).expect(200);
    await http.post('/v1/billing/subscribe').set(auth(c.accessToken)).send({ interval: 'month' }).expect(200);

    // The trial ends: the first period is "paid" at zero, no card involved.
    await db.system((tx) => tx.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 60_000) }).where(eq(subscriptions.orgId, c.organization.id)));
    await billing.runDue();
    const [sub] = await db.system((tx) => tx.select().from(subscriptions).where(eq(subscriptions.orgId, c.organization.id)));
    expect(sub).toMatchObject({ status: 'active', paymentMethod: null });
    const [inv] = await db.system((tx) => tx.select().from(billingInvoices).where(eq(billingInvoices.orgId, c.organization.id)));
    expect(inv).toMatchObject({ status: 'paid', total: '0.00', providerPaymentId: `no-charge:${inv!.id}` });
    expect((inv!.lines as any[]).map((l) => l.code)).toEqual(['platform', 'agent:price_watch', 'discount']);
  });

  it('extends a trial, and restarts an expired one', async () => {
    const admin = await staff();
    const c = await customer();
    await db.system((tx) => tx.update(subscriptions).set({ status: 'expired', trialEndsAt: new Date(Date.now() - 86400_000) }).where(eq(subscriptions.orgId, c.organization.id)));
    expect((await http.get('/v1/billing/status').set(auth(c.accessToken)).expect(200)).body.entitled).toBe(false);

    await http.post(`/v1/platform/organizations/${c.organization.id}/trial`).set(auth(admin)).send({ trialEndsOn: '2020-01-01' }).expect(400);
    const later = new Date(Date.now() + 45 * 86400_000).toISOString().slice(0, 10);
    const r = (await http.post(`/v1/platform/organizations/${c.organization.id}/trial`).set(auth(admin)).send({ trialEndsOn: later }).expect(200)).body;
    expect(r.status).toBe('trialing');
    const st = (await http.get('/v1/billing/status').set(auth(c.accessToken)).expect(200)).body;
    expect(st).toMatchObject({ status: 'trialing', entitled: true });
    expect(st.trialEndsAt.slice(0, 10)).toBe(later);
  });
});
