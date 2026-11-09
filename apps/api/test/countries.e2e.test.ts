import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let app: INestApplication;
let http: ReturnType<typeof request>;

const signup = (organization: Record<string, unknown>, legalEntity?: Record<string, unknown>) =>
  http.post('/v1/auth/signup').send({ email: `${uniq()}@t.ae`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}`, ...organization }, legalEntity });

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});

describe('Organisations outside Saudi Arabia', () => {
  it('signs up a UAE group with AED, UAE VAT rules and Dubai time', async () => {
    // A Saudi VAT number is not a valid UAE TRN.
    await signup({ country: 'AE' }, { name: 'Gulf Bites LLC', vatNumber: '310122393500003' }).expect(400);
    await signup({ country: 'XX' }).expect(400);

    const s = (await signup({ country: 'AE' }, { name: 'Gulf Bites LLC', vatNumber: '100123456789012', crNumber: 'CN-1234567' }).expect(201)).body;
    expect(s.organization).toMatchObject({ country: 'AE', defaultCurrency: 'AED' });
    expect(s.legalEntity).toMatchObject({ country: 'AE', currency: 'AED' });
    // No automatic register for the UAE: Backhouse reviews it (not rejected for failing a Saudi lookup).
    expect(s.legalEntity.verificationStatus).toBe('needs_review');
    const token = s.accessToken as string;

    const me = (await http.get('/v1/auth/me').set(auth(token)).expect(200)).body;
    expect(me.organizations[0]).toMatchObject({ country: 'AE', currency: 'AED', vatRate: '0.05', timezone: 'Asia/Dubai', phoneCode: '971', eInvoicing: null });

    const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: s.legalEntity.id, name: 'JBR' }).expect(201)).body;
    expect(site.timezone).toBe('Asia/Dubai');
    await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: s.legalEntity.id, name: 'X', timezone: 'Mars/Base' }).expect(400);

    // Suppliers: local ones charge UAE VAT in AED; a Saudi supplier bills in SAR with no UAE VAT.
    const local = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Dubai Fresh', contactEmail: 'o@df.ae', vatNumber: '100987654321098' }).expect(201)).body;
    expect(local).toMatchObject({ currency: 'AED', taxRate: '0.0500' });
    const saudi = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Riyadh Dates', contactEmail: 'o@rd.sa', country: 'SA', vatNumber: '310122393500003' }).expect(201)).body;
    expect(saudi).toMatchObject({ currency: 'SAR', taxRate: '0.0000' });
    await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Bad', contactEmail: 'o@b.ae', vatNumber: '310122393500003' }).expect(400);

    // Orders: 5% VAT, and limits written in dirhams.
    const item = (await http.post('/v1/items').set(auth(token)).send({ name: 'Chicken breast' }).expect(201)).body;
    const line = (await http.post(`/v1/suppliers/${local.id}/items`).set(auth(token)).send({ itemId: item.id, packId: item.packs[0].id, price: 20 }).expect(201)).body;
    await http.post('/v1/spend-limits').set(auth(token)).send({ period: 'order', amount: 50 }).expect(201);
    const po = (await http.post('/v1/purchase-orders').set(auth(token)).send({ siteId: site.id, relationshipId: local.id, lines: [{ supplierItemId: line.id, qty: 5 }], submit: true }).expect(201)).body;
    expect(po).toMatchObject({ currency: 'AED', subtotal: '100.00', taxTotal: '5.00', total: '105.00', status: 'pending_approval' });
    expect(po.approvalReason).toContain('AED 105.00');
    expect(po.approvalReason).toContain('105.00 د.إ');

    // Supplier invoices are checked in the invoice's currency at the UAE rate.
    const inv = (
      await http
        .post('/v1/supplier-invoices')
        .set(auth(token))
        .send({ relationshipId: local.id, number: 'DF-1', issueDate: '2026-11-08', lines: [{ description: 'Delivery fee', qty: 1, unitPrice: 30 }] })
        .expect(201)
    ).body;
    expect(inv).toMatchObject({ currency: 'AED', taxTotal: '1.50', total: '31.50' });

    // ZATCA is Saudi-only.
    const z = await http.post('/v1/zatca/units').set(auth(token)).send({ legalEntityId: s.legalEntity.id, name: 'Main', environment: 'simulation' }).expect(400);
    expect(z.body.message).toContain('Saudi Arabia');
  });

  it('accepts Kuwait (no VAT) and Egypt, each with its own defaults', async () => {
    const kw = (await signup({ country: 'KW' }, { name: 'Kuwait Kitchens', crNumber: '123456' }).expect(201)).body;
    expect(kw.organization).toMatchObject({ country: 'KW', defaultCurrency: 'KWD' });
    const sup = (await http.post('/v1/suppliers').set(auth(kw.accessToken)).send({ displayName: 'Local', contactEmail: 'a@b.kw' }).expect(201)).body;
    expect(sup).toMatchObject({ currency: 'KWD', taxRate: '0.0000' });

    const eg = (await signup({ country: 'EG' }, { name: 'Cairo Foods', vatNumber: '123456789' }).expect(201)).body;
    expect(eg.legalEntity).toMatchObject({ country: 'EG', currency: 'EGP' });
    const site = (await http.post('/v1/sites').set(auth(eg.accessToken)).send({ legalEntityId: eg.legalEntity.id, name: 'Zamalek' }).expect(201)).body;
    expect(site.timezone).toBe('Africa/Cairo');
  });

  it('keeps Saudi Arabia as the default when no country is given', async () => {
    const sa = (await signup({}, { name: 'Najd Kitchens', vatNumber: '310122393500003', crNumber: '1010121234' }).expect(201)).body;
    expect(sa.organization).toMatchObject({ country: 'SA', defaultCurrency: 'SAR' });
    expect(sa.legalEntity.verificationStatus).toBe('verified');
    await signup({}, { name: 'X', vatNumber: '100123456789012' }).expect(400);
  });
});
