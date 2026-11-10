import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, isNull } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { billingInvoices, memberships, organizations, roles, runMigrations, subscriptions } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { DbService } from '../src/common/db.service.js';
import { BillingService } from '../src/billing/billing.service.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const DAY = 86400_000;
let app: INestApplication;
let http: ReturnType<typeof request>;
let db: DbService;
let billing: BillingService;

async function signup() {
  return (await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', locale: 'en', organization: { name: `Najd ${uniq()}` } }).expect(201)).body;
}
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
const sub = async (orgId: string) => (await db.system((tx) => tx.select().from(subscriptions).where(eq(subscriptions.orgId, orgId))))[0]!;
const invoices = (orgId: string) => db.system((tx) => tx.select().from(billingInvoices).where(eq(billingInvoices.orgId, orgId)));

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(
    loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', BOH_BANK_NAME: 'Saudi National Bank', BOH_BANK_ACCOUNT_NAME: 'Kitchain', BOH_BANK_IBAN: 'SA0380000000608010167519' }),
    { logger: false },
  );
  await app.init();
  http = request(app.getHttpServer());
  db = app.get(DbService);
  billing = app.get(BillingService);
});
afterAll(async () => {
  await app?.close();
});

describe('Bank transfer billing (agreed with Kitchain staff)', () => {
  it('invoices wait for a transfer; unpaid → past due → suspended; staff marking it paid reactivates', async () => {
    const admin = await staff();
    const c = await signup();
    const orgId = c.organization.id;

    // Customers can't switch themselves; without it a card is needed.
    await http.put(`/v1/platform/organizations/${orgId}/payment-mode`).set(auth(c.accessToken)).send({ mode: 'bank_transfer' }).expect(403);
    await http.post('/v1/billing/subscribe').set(auth(c.accessToken)).send({ interval: 'month' }).expect(400);

    const row = (await http.put(`/v1/platform/organizations/${orgId}/payment-mode`).set(auth(admin)).send({ mode: 'bank_transfer' }).expect(200)).body;
    expect(row.paymentMode).toBe('bank_transfer');
    await http.post('/v1/billing/subscribe').set(auth(c.accessToken)).send({ interval: 'month' }).expect(200);
    const view = (await http.get('/v1/billing').set(auth(c.accessToken)).expect(200)).body;
    expect(view).toMatchObject({ paymentMode: 'bank_transfer', bank: { bankName: 'Saudi National Bank', accountName: 'Kitchain', iban: 'SA0380000000608010167519' } });

    // Trial ends: an invoice awaiting transfer, due in 14 days; the service carries on.
    await db.system((tx) => tx.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 60_000) }).where(eq(subscriptions.orgId, orgId)));
    await billing.runDue();
    let s = await sub(orgId);
    expect(s.status).toBe('active');
    const [inv] = await invoices(orgId);
    expect(inv).toMatchObject({ status: 'awaiting_transfer', total: '460.00' });
    expect(Math.round((inv!.dueAt!.getTime() - inv!.issuedAt.getTime()) / DAY)).toBe(14);
    const detail = (await http.get(`/v1/billing/invoices/${inv!.id}`).set(auth(c.accessToken)).expect(200)).body;
    expect(detail).toMatchObject({ status: 'awaiting_transfer', bank: { iban: 'SA0380000000608010167519' } });
    expect((await http.get('/v1/billing/status').set(auth(c.accessToken))).body.entitled).toBe(true);

    // Staff see it as unpaid.
    const listed = (await http.get(`/v1/platform/organizations?q=${encodeURIComponent(c.organization.name)}`).set(auth(admin)).expect(200)).body[0];
    expect(listed.unpaid).toEqual([expect.objectContaining({ id: inv!.id, number: inv!.number, status: 'awaiting_transfer' })]);

    // Past the due date: past due, still usable, with the same time again as grace.
    await db.system((tx) => tx.update(billingInvoices).set({ dueAt: new Date(Date.now() - DAY) }).where(eq(billingInvoices.id, inv!.id)));
    await billing.runDue();
    s = await sub(orgId);
    expect(s.status).toBe('past_due');
    expect(Math.round((s.nextRetryAt!.getTime() - (Date.now() - DAY)) / DAY)).toBe(14);
    expect((await http.get('/v1/billing/status').set(auth(c.accessToken))).body.entitled).toBe(true);

    // Grace over and still unpaid: suspended (read-only).
    await db.system((tx) => tx.update(subscriptions).set({ nextRetryAt: new Date(Date.now() - 60_000) }).where(eq(subscriptions.orgId, orgId)));
    await billing.runDue();
    expect((await sub(orgId)).status).toBe('suspended');
    expect((await http.get('/v1/billing/status').set(auth(c.accessToken))).body.entitled).toBe(false);

    // The money arrives: staff mark it paid with the bank reference, and the account is back.
    await http.post(`/v1/platform/organizations/invoices/${inv!.id}/paid`).set(auth(c.accessToken)).send({ reference: 'X' }).expect(403);
    await http.post(`/v1/platform/organizations/invoices/${inv!.id}/paid`).set(auth(admin)).send({ reference: 'SNB-TRF-88213' }).expect(200);
    const [paid] = await invoices(orgId);
    expect(paid).toMatchObject({ status: 'paid', paymentReference: 'SNB-TRF-88213', providerPaymentId: `transfer:${inv!.id}` });
    expect((await sub(orgId)).status).toBe('active');
    expect((await http.get('/v1/billing/status').set(auth(c.accessToken))).body.entitled).toBe(true);
    await http.post(`/v1/platform/organizations/invoices/${inv!.id}/paid`).set(auth(admin)).send({ reference: 'again' }).expect(400);
  });

  it('paying on time just closes the invoice', async () => {
    const admin = await staff();
    const c = await signup();
    const orgId = c.organization.id;
    await http.put(`/v1/platform/organizations/${orgId}/payment-mode`).set(auth(admin)).send({ mode: 'bank_transfer' }).expect(200);
    await http.post('/v1/billing/subscribe').set(auth(c.accessToken)).send({ interval: 'year' }).expect(200);
    await db.system((tx) => tx.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 60_000) }).where(eq(subscriptions.orgId, orgId)));
    await billing.runDue();
    const [inv] = await invoices(orgId);
    expect(inv).toMatchObject({ status: 'awaiting_transfer', interval: 'year', total: '4600.00' }); // 400 × 10 months + VAT
    await http.post(`/v1/platform/organizations/invoices/${inv!.id}/paid`).set(auth(admin)).send({ reference: 'TRF-1' }).expect(200);
    await billing.runDue();
    expect((await sub(orgId)).status).toBe('active');
  });
});
