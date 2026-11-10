import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { runMigrations, salesInvoices, zatcaUnits } from '@boh/db';
import { parseUblInvoice } from '@boh/domain';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { DbService } from '../src/common/db.service.js';
import { ZatcaService } from '../src/zatca/zatca.service.js';
import { FIRST_PIH, readQr } from '../src/zatca/ubl.js';
import type { SimulatedFatoora } from '../src/zatca/fatoora.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const cr = () => `10${String(Math.floor(Math.random() * 1e4)).padStart(4, '1')}1234`;
let app: INestApplication;
let http: ReturnType<typeof request>;
let db: DbService;
let zatca: ZatcaService;

const ADDRESS = { street: 'King Fahd Road', buildingNumber: '1234', district: 'Al Olaya', city: 'Riyadh', postalCode: '12345', additionalNumber: '5678' };
const BUYER = { name: 'شركة الضيافة الراقية', vatNumber: '310122393500003', address: { street: 'Prince Sultan Street', building: '4321', district: 'Al Malqa', city: 'Riyadh', postalCode: '13521' } };
const LINES = [
  { name: 'وجبات مطبوخة (صينية 10 أشخاص)', qty: 3, unitPrice: 450 },
  { name: 'Delivery', qty: 1, unitPrice: 50, discount: 10 },
];

async function invite(owner: string, roleKey: string) {
  const roles = await http.get('/v1/roles').set(auth(owner)).expect(200);
  const role = roles.body.find((r: any) => r.key === roleKey);
  const inv = await http.post('/v1/invitations').set(auth(owner)).send({ email: `${uniq()}@t.sa`, roleId: role.id }).expect(201);
  return (await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: roleKey }).expect(201)).body.accessToken as string;
}

async function setup(opts: { address?: boolean; onboard?: boolean } = {}) {
  const s = await http
    .post('/v1/auth/signup')
    .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` }, legalEntity: { name: 'Najd Kitchens Co.', nameAr: 'شركة مطابخ نجد', crNumber: cr(), vatNumber: '310122393500003' } })
    .expect(201);
  const token = s.body.accessToken as string;
  const le = s.body.legalEntity;
  if (opts.address !== false) await http.patch(`/v1/legal-entities/${le.id}`).set(auth(token)).send({ address: ADDRESS }).expect(200);
  let unit: any = null;
  if (opts.onboard !== false && opts.address !== false) {
    unit = (await http.post('/v1/zatca/units').set(auth(token)).send({ legalEntityId: le.id, name: 'Central kitchen', environment: 'simulation' }).expect(201)).body;
    unit = (await http.post(`/v1/zatca/units/${unit.id}/onboard`).set(auth(token)).send({ otp: '123456' }).expect(200)).body;
  }
  return { token, le, unit };
}

const sell = (x: { token: string; le: any }, body: Record<string, unknown>) => http.post('/v1/sales-invoices').set(auth(x.token)).send({ legalEntityId: x.le.id, lines: LINES, ...body });

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', ZATCA_MODE: 'simulated' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
  db = app.get(DbService);
  zatca = app.get(ZatcaService);
});
afterAll(async () => {
  await app?.close();
});

describe('ZATCA onboarding', () => {
  it('needs complete company details, then onboards with the OTP: compliance, checks, production certificate', async () => {
    const x = await setup({ address: false });
    const missing = await http.post('/v1/zatca/units').set(auth(x.token)).send({ legalEntityId: x.le.id, name: 'Main', environment: 'simulation' }).expect(400);
    expect(missing.body.message).toContain('building number (4 digits)');
    await http.patch(`/v1/legal-entities/${x.le.id}`).set(auth(x.token)).send({ address: ADDRESS }).expect(200);

    const unit = (await http.post('/v1/zatca/units').set(auth(x.token)).send({ legalEntityId: x.le.id, name: 'Main', environment: 'simulation' }).expect(201)).body;
    expect(unit).toMatchObject({ status: 'new', environment: 'simulation', invoiceTypes: '1100', icv: 0 });
    expect(unit.egsSerial).toMatch(/^1-Kitchain\|2-1\.0\|3-/);
    expect(unit).not.toHaveProperty('privateKeyEnc');

    const bad = await http.post(`/v1/zatca/units/${unit.id}/onboard`).set(auth(x.token)).send({ otp: '000000' }).expect(400);
    expect(bad.body.message).toContain('Invalid-OTP');
    expect((await http.get('/v1/zatca/units').set(auth(x.token))).body.units[0]).toMatchObject({ status: 'failed', lastError: expect.stringContaining('Invalid-OTP') });

    const active = (await http.post(`/v1/zatca/units/${unit.id}/onboard`).set(auth(x.token)).send({ otp: '123456' }).expect(200)).body;
    expect(active).toMatchObject({ status: 'active', lastError: null });
    expect(active.checks).toHaveLength(6);
    expect(active.checks.every((c: any) => c.status === 'PASS')).toBe(true);
    expect(active.certSerial).toBeTruthy();

    // Keys and secrets are stored encrypted.
    const [row] = await db.system((tx) => tx.select().from(zatcaUnits).where(eq(zatcaUnits.id, unit.id)));
    expect(row!.privateKeyEnc).toMatch(/^v1:/);
    expect(row!.privateKeyEnc).not.toContain('PRIVATE KEY');
    expect(row!.productionSecretEnc).toMatch(/^v1:/);
  });

  it('only admins register units; accountants issue invoices; staff do neither', async () => {
    const x = await setup();
    const accountant = await invite(x.token, 'accountant');
    const staff = await invite(x.token, 'staff');
    await http.post('/v1/zatca/units').set(auth(accountant)).send({ legalEntityId: x.le.id, name: 'X', environment: 'simulation' }).expect(403);
    await sell({ token: accountant, le: x.le }, { kind: 'simplified', issue: true }).expect(201);
    await sell({ token: staff, le: x.le }, { kind: 'simplified' }).expect(403);
  });
});

describe('Issuing', () => {
  it('reports simplified invoices, chaining each one to the last', async () => {
    const x = await setup();
    const a = (await sell(x, { kind: 'simplified', issue: true }).expect(201)).body;
    expect(a).toMatchObject({ number: 'INV-00001', status: 'reported', zatcaStatus: 'REPORTED', icv: 1, pih: FIRST_PIH, subtotal: '1390.00', taxTotal: '208.50', total: '1598.50', hasXml: true });
    expect(readQr(a.qr)[3]!.toString()).toBe('1598.50');
    const b = (await sell(x, { kind: 'simplified', issue: true }).expect(201)).body;
    expect(b).toMatchObject({ number: 'INV-00002', status: 'reported', icv: 2, pih: a.hash });

    // The XML is a ZATCA e-invoice Kitchain (or anyone) can read back.
    const xml = await http.get(`/v1/sales-invoices/${a.id}/xml`).set(auth(x.token)).expect(200);
    expect(xml.headers['content-type']).toContain('application/xml');
    const parsed = parseUblInvoice(xml.text);
    expect(parsed).toMatchObject({ type: 'invoice', number: 'INV-00001', total: '1598.5', taxTotal: '208.5', supplier: { vatNumber: '310122393500003' } });
    expect(parsed.lines.map((l) => l.lineTotal)).toEqual(['1350', '40']);
  });

  it('clears tax invoices, and corrects them with credit notes', async () => {
    const x = await setup();
    await sell(x, { kind: 'standard', issue: true }).expect(400); // no buyer
    await sell(x, { kind: 'standard', buyer: { ...BUYER, vatNumber: '123' }, issue: true }).expect(400);
    const inv = (await sell(x, { kind: 'standard', buyer: BUYER, supplyDate: '2026-11-08', issue: true }).expect(201)).body;
    expect(inv).toMatchObject({ status: 'cleared', zatcaStatus: 'CLEARED', hasClearedXml: true, kind: 'standard' });

    await sell(x, { kind: 'standard', type: 'credit_note', buyer: BUYER, originalInvoiceId: inv.id, lines: [{ name: 'Returned tray', qty: 1, unitPrice: 450 }], issue: true }).expect(400); // no reason
    const draft = (await sell(x, { kind: 'standard', buyer: BUYER }).expect(201)).body;
    await sell(x, { kind: 'standard', type: 'credit_note', buyer: BUYER, originalInvoiceId: draft.id, reason: 'x', lines: [{ name: 'y', qty: 1, unitPrice: 1 }] }).expect(400); // not issued
    const cn = (await sell(x, { kind: 'standard', type: 'credit_note', buyer: BUYER, originalInvoiceId: inv.id, reason: 'One tray returned', lines: [{ name: 'Returned tray', qty: 1, unitPrice: 450 }], issue: true }).expect(201)).body;
    expect(cn).toMatchObject({ number: 'CN-00001', type: 'credit_note', status: 'cleared', billingReference: inv.number, total: '517.50' });
    expect((await http.get(`/v1/sales-invoices/${inv.id}`).set(auth(x.token))).body.notes).toEqual([expect.objectContaining({ id: cn.id, number: 'CN-00001' })]);

    // The unit's chain covers both documents (and the draft got no number in it).
    const [unit] = await db.system((tx) => tx.select().from(zatcaUnits).where(eq(zatcaUnits.id, x.unit.id)));
    expect(unit).toMatchObject({ icv: 2, lastHash: cn.hash });
  });

  it('keeps signed invoices waiting when ZATCA is down, and the worker sends them later', async () => {
    const x = await setup();
    (zatca.fatoora as SimulatedFatoora).failNext = 1;
    const inv = (await sell(x, { kind: 'simplified', issue: true }).expect(201)).body;
    expect(inv).toMatchObject({ status: 'issued', submitAttempts: 1, lastError: expect.stringContaining('unavailable') });
    expect(new Date(inv.nextSubmitAt).getTime()).toBeGreaterThan(Date.now());
    // Not due yet: nothing happens. Once due, the worker reports it.
    await zatca.submitDue();
    expect((await http.get(`/v1/sales-invoices/${inv.id}`).set(auth(x.token))).body.status).toBe('issued');
    await db.system((tx) => tx.update(salesInvoices).set({ nextSubmitAt: new Date(Date.now() - 1000) }).where(eq(salesInvoices.id, inv.id)));
    await zatca.submitDue();
    expect((await http.get(`/v1/sales-invoices/${inv.id}`).set(auth(x.token))).body).toMatchObject({ status: 'reported', submitAttempts: 2, lastError: null });
  });

  it('never changes or deletes a signed invoice; drafts can go', async () => {
    const x = await setup();
    const inv = (await sell(x, { kind: 'simplified', issue: true }).expect(201)).body;
    await http.delete(`/v1/sales-invoices/${inv.id}`).set(auth(x.token)).expect(400);
    await expect(db.system((tx) => tx.execute(sql`update sales_invoices set total = 1 where id = ${inv.id}`))).rejects.toThrow(/cannot be changed/);
    await expect(db.system((tx) => tx.execute(sql`delete from sales_invoices where id = ${inv.id}`))).rejects.toThrow(/cannot be deleted/);
    const draft = (await sell(x, { kind: 'simplified' }).expect(201)).body;
    expect(draft).toMatchObject({ status: 'draft', icv: null, hasXml: false });
    await http.delete(`/v1/sales-invoices/${draft.id}`).set(auth(x.token)).expect(204);
  });

  it('needs a registered unit, and keeps organisations apart', async () => {
    const x = await setup({ onboard: false });
    const draft = (await sell(x, { kind: 'simplified' }).expect(201)).body;
    const r = await http.post(`/v1/sales-invoices/${draft.id}/issue`).set(auth(x.token)).expect(409);
    expect(r.body.message).toContain('E-invoicing');
    const other = await setup();
    await http.get(`/v1/sales-invoices/${draft.id}`).set(auth(other.token)).expect(404);
    await http.get(`/v1/sales-invoices/${draft.id}/xml`).set(auth(other.token)).expect(404);
  });

  it('requires an exemption reason for zero-rated lines', async () => {
    const x = await setup();
    await sell(x, { kind: 'simplified', lines: [{ name: 'Export', qty: 1, unitPrice: 100, vatCategory: 'Z' }] }).expect(400);
    const ok = (await sell(x, { kind: 'simplified', lines: [{ name: 'Export', qty: 1, unitPrice: 100, vatCategory: 'Z', exemptionCode: 'VATEX-SA-32', exemptionReason: 'Export of goods' }], issue: true }).expect(201)).body;
    expect(ok).toMatchObject({ status: 'reported', taxTotal: '0.00', total: '100.00' });
  });
});
