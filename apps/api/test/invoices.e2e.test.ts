import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { corrections, events, runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { DbService } from '../src/common/db.service.js';
import { ubl, vat } from './invoice-fixtures.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const EMAIL_SECRET = 'test-inbound-secret';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let app: INestApplication;
let http: ReturnType<typeof request>;
let db: DbService;

async function signup() {
  const res = await http
    .post('/v1/auth/signup')
    .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } })
    .expect(201);
  return { token: res.body.accessToken as string, legalEntityId: res.body.legalEntity.id as string };
}

async function invite(owner: string, roleKey: string, siteIds?: string[]) {
  const roles = await http.get('/v1/roles').set(auth(owner)).expect(200);
  const role = roles.body.find((r: any) => r.key === roleKey);
  const inv = await http.post('/v1/invitations').set(auth(owner)).send({ email: `${uniq()}@t.sa`, roleId: role.id, siteIds }).expect(201);
  return (await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: roleKey }).expect(201)).body.accessToken as string;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const uploadXml = (token: string, xml: string, extra: Record<string, unknown> = {}) =>
  http.post('/v1/supplier-invoices/upload').set(auth(token)).send({ filename: 'invoice.xml', contentType: 'application/xml', data: b64(xml), ...extra });

/**
 * Org with a site, a supplier (VAT, invoices from billing@wafra.sa) selling chicken (SKU CH-1, 24.75)
 * and tomatoes (5.40), and an order for 4 chicken + 10 tomatoes that has been fully received.
 */
async function setup(opts: { receive?: boolean } = {}) {
  const o = await signup();
  const site = (await http.post('/v1/sites').set(auth(o.token)).send({ legalEntityId: o.legalEntityId, name: 'Olaya' }).expect(201)).body;
  const chicken = (await http.post('/v1/items').set(auth(o.token)).send({ name: 'Chicken breast', nameAr: 'صدر دجاج' }).expect(201)).body;
  const tomato = (await http.post('/v1/items').set(auth(o.token)).send({ name: 'Tomato', nameAr: 'طماطم' }).expect(201)).body;
  const supplierVat = vat();
  const sup = (
    await http
      .post('/v1/suppliers')
      .set(auth(o.token))
      .send({ displayName: 'Al Wafra Foods', displayNameAr: 'الوفرة للأغذية', vatNumber: supplierVat, contactEmail: 'sales@wafra.sa', contactPhone: '+966500000077', invoiceSenderWhitelist: ['billing@wafra.sa'], paymentTermsDays: 30 })
      .expect(201)
  ).body;
  const lc = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(o.token)).send({ itemId: chicken.id, packId: chicken.packs[0].id, supplierSku: 'CH-1', price: 24.75 }).expect(201)).body;
  const lt = (await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(o.token)).send({ itemId: tomato.id, packId: tomato.packs[0].id, price: 5.4 }).expect(201)).body;
  const po = (await http.post('/v1/purchase-orders').set(auth(o.token)).send({ siteId: site.id, relationshipId: sup.id, lines: [{ supplierItemId: lc.id, qty: 4 }, { supplierItemId: lt.id, qty: 10 }], submit: true }).expect(201)).body;
  const detail = (await http.get(`/v1/purchase-orders/${po.id}`).set(auth(o.token)).expect(200)).body;
  const chickenLine = detail.lines.find((l: any) => l.itemId === chicken.id);
  const tomatoLine = detail.lines.find((l: any) => l.itemId === tomato.id);
  if (opts.receive !== false) {
    await http.post(`/v1/purchase-orders/${po.id}/receive`).set(auth(o.token)).send({ lines: [{ lineId: chickenLine.id, qty: 4 }, { lineId: tomatoLine.id, qty: 10 }] }).expect(200);
  }
  return { ...o, site, chicken, tomato, sup, supplierVat, lc, lt, po, chickenLine, tomatoLine };
}

const exact = (x: Awaited<ReturnType<typeof setup>>, number = `INV-${uniq()}`) =>
  ubl({ number, supplierVat: x.supplierVat, po: x.po.number, lines: [{ name: 'صدر دجاج 1 كجم', sku: 'CH-1', qty: 4, price: 24.75 }, { name: 'Tomatoes 1kg', qty: 10, price: 5.4 }] });

function sign(body: string) {
  return `sha256=${createHmac('sha256', EMAIL_SECRET).update(body).digest('hex')}`;
}
const email = (body: Record<string, unknown>, signature?: string) => {
  const raw = JSON.stringify(body);
  return http.post('/v1/webhooks/invoice-email').set('Content-Type', 'application/json').set('X-Kitchain-Signature', signature ?? sign(raw)).send(raw);
};

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', INBOUND_EMAIL_SECRET: EMAIL_SECRET }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
  db = app.get(DbService);
});
afterAll(async () => {
  await app?.close();
});

describe('supplier invoices: e-invoices and the three-way match', () => {
  it('reads a ZATCA e-invoice, finds the supplier and order, matches, approves and records payment', async () => {
    const x = await setup();
    const xml = exact(x, 'INV-1001');
    const res = await uploadXml(x.token, xml).expect(201);
    expect(res.body).toMatchObject({
      ref: 'SI-00001',
      type: 'invoice',
      status: 'matched',
      number: 'INV-1001',
      source: 'upload',
      extractedBy: 'xml',
      subtotal: '153.00',
      taxTotal: '22.95',
      total: '175.95',
      claimTotal: '0.00',
      issueDate: '2026-11-08',
      dueDate: '2026-12-08', // 30 days' terms
      reviewReasons: [],
      duplicateUpload: false,
      supplier: { id: x.sup.id, vatNumber: x.supplierVat },
      site: { id: x.site.id },
      po: { id: x.po.id, number: x.po.number },
      document: { filename: 'invoice.xml', contentType: 'application/xml' },
      can: { manage: true, approve: true, dispute: true, pay: false },
    });
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.match.lines.map((l: any) => l.method)).toEqual(['sku', 'name']);

    // The same file again doesn't create a second invoice.
    const again = await uploadXml(x.token, xml).expect(201);
    expect(again.body).toMatchObject({ id: res.body.id, duplicateUpload: true });

    const doc = await http.get(`/v1/supplier-invoices/${res.body.id}/document`).set(auth(x.token)).expect(200);
    expect(doc.headers['content-type']).toContain('application/xml');

    const approved = await http.post(`/v1/supplier-invoices/${res.body.id}/approve`).set(auth(x.token)).send({}).expect(200);
    expect(approved.body).toMatchObject({ status: 'approved', approvedOverride: null, can: { pay: true } });
    await http.patch(`/v1/supplier-invoices/${res.body.id}`).set(auth(x.token)).send({ number: 'X' }).expect(400);
    const paid = await http.post(`/v1/supplier-invoices/${res.body.id}/paid`).set(auth(x.token)).send({ paidOn: '2026-11-20', reference: 'TRF-889' }).expect(200);
    expect(paid.body).toMatchObject({ status: 'paid', paymentReference: 'TRF-889' });

    const list = (await http.get('/v1/supplier-invoices?status=all').set(auth(x.token)).expect(200)).body;
    expect(list[0]).toMatchObject({ ref: 'SI-00001', status: 'paid', supplierName: 'Al Wafra Foods', poNumber: x.po.number, siteName: 'Olaya' });
    const types = await db.system((tx) => tx.select({ type: events.type }).from(events).where(eq(events.entityId, res.body.id)));
    expect(types.map((t) => t.type)).toEqual(expect.arrayContaining(['invoice.received', 'invoice.approved', 'invoice.paid']));
  });

  it('flags a price above the order, asks for a credit note, and links the credit note when it arrives', async () => {
    const x = await setup();
    const xml = ubl({ number: 'INV-2002', supplierVat: x.supplierVat, po: x.po.number, lines: [{ name: 'Chicken breast', sku: 'CH-1', qty: 4, price: 27.25 }, { name: 'Tomato', qty: 10, price: 5.4 }] });
    const inv = (await uploadXml(x.token, xml).expect(201)).body;
    expect(inv.status).toBe('mismatch');
    expect(inv.claimTotal).toBe('11.50'); // 4 × 2.50 = 10.00 + 15% VAT
    const d = inv.match.discrepancies.find((m: any) => m.kind === 'price_higher');
    expect(d).toMatchObject({ amount: '10.00', blocking: true });

    // Approving a mismatch needs a reason.
    await http.post(`/v1/supplier-invoices/${inv.id}/approve`).set(auth(x.token)).send({}).expect(400);

    const disputed = await http.post(`/v1/supplier-invoices/${inv.id}/dispute`).set(auth(x.token)).send({}).expect(200);
    expect(disputed.body.invoice.status).toBe('disputed');
    expect(disputed.body.message).toContain('INV-2002');
    expect(disputed.body.message).toContain('11.50 ر.س');
    expect(disputed.body.message).toContain('SAR 11.50');
    expect(disputed.body.links.mailto).toContain('mailto:sales@wafra.sa');
    expect(disputed.body.sent).toBeNull();

    const credit = ubl({ number: 'CN-77', supplierVat: x.supplierVat, type: '381', billingRef: 'INV-2002', lines: [{ name: 'Chicken breast price correction', qty: 4, price: 2.5 }] });
    const cn = (await uploadXml(x.token, credit).expect(201)).body;
    expect(cn).toMatchObject({ type: 'credit_note', status: 'matched', corrects: { id: inv.id, number: 'INV-2002' }, total: '11.50' });
    const original = (await http.get(`/v1/supplier-invoices/${inv.id}`).set(auth(x.token)).expect(200)).body;
    expect(original.creditNotes).toEqual([expect.objectContaining({ id: cn.id, number: 'CN-77' })]);
    const evt = await db.system((tx) => tx.select().from(events).where(eq(events.entityId, inv.id)));
    expect(evt.find((e) => e.type === 'invoice.credit_note_received')?.payload).toMatchObject({ creditNoteId: cn.id });

    const ok = await http.post(`/v1/supplier-invoices/${inv.id}/approve`).set(auth(x.token)).send({ reason: 'Credit note CN-77 covers the difference' }).expect(200);
    expect(ok.body).toMatchObject({ status: 'approved', approvedOverride: 'Credit note CN-77 covers the difference' });
  });

  it('bills only what was received, across several invoices for one order', async () => {
    const x = await setup();
    // First invoice: the chicken only.
    const a = (await uploadXml(x.token, ubl({ number: 'A-1', supplierVat: x.supplierVat, po: x.po.number, lines: [{ name: 'Chicken', sku: 'CH-1', qty: 4, price: 24.75 }] })).expect(201)).body;
    expect(a.status).toBe('matched');
    expect(a.match.discrepancies.find((m: any) => m.kind === 'not_invoiced')).toBeTruthy(); // tomatoes still to be billed
    // Second: tomatoes, and the chicken again.
    const b = (await uploadXml(x.token, ubl({ number: 'A-2', supplierVat: x.supplierVat, po: x.po.number, lines: [{ name: 'Tomato', qty: 10, price: 5.4 }, { name: 'Chicken', sku: 'CH-1', qty: 4, price: 24.75 }] })).expect(201)).body;
    expect(b.status).toBe('mismatch');
    expect(b.match.discrepancies.find((m: any) => m.kind === 'qty_not_received')).toMatchObject({ amount: '99.00' });
    // Fixing the invoice (chicken removed) makes it match.
    const fixed = await http.patch(`/v1/supplier-invoices/${b.id}`).set(auth(x.token)).send({ lines: [{ description: 'Tomato', qty: 10, unitPrice: 5.4 }] }).expect(200);
    expect(fixed.body).toMatchObject({ status: 'matched', subtotal: '54.00', taxTotal: '8.10', total: '62.10' });
    // The edit of an automatic reading is kept for training.
    const corr = await db.system((tx) => tx.select().from(corrections).where(eq(corrections.subjectId, b.id)));
    expect(corr[0]).toMatchObject({ kind: 'invoice_extraction' });
  });

  it('catches duplicates, lines not on the order, wrong VAT and a different supplier VAT number', async () => {
    const x = await setup();
    await uploadXml(x.token, exact(x, 'DUP-1')).expect(201);
    const dup = (await uploadXml(x.token, exact(x, 'DUP-1').replace('Tomatoes 1kg', 'Tomatoes')).expect(201)).body; // same number, different file
    expect(dup.status).toBe('mismatch');
    expect(dup.match.discrepancies.find((m: any) => m.kind === 'duplicate').message).toContain('SI-00001');

    const extra = ubl({ number: 'EX-1', supplierVat: x.supplierVat, po: x.po.number, lines: [{ name: 'Chicken', sku: 'CH-1', qty: 4, price: 24.75 }, { name: 'Delivery fee', qty: 1, price: 25 }], taxOverride: 40 });
    const r = (await uploadXml(x.token, extra).expect(201)).body;
    const kinds = r.match.discrepancies.filter((m: any) => m.blocking).map((m: any) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(['not_on_order', 'vat']));
    // The chicken was already billed on DUP-1 (and on its duplicate, until someone rejects it).
    expect(kinds).toContain('qty_not_received');

    // Uploaded against this supplier, but issued under someone else's VAT number.
    const other = (await uploadXml(x.token, ubl({ number: 'OV-1', supplierVat: vat(), po: x.po.number, lines: [{ name: 'Chicken', sku: 'CH-1', qty: 4, price: 24.75 }] }), { relationshipId: x.sup.id }).expect(201)).body;
    expect(other.match.discrepancies.map((m: any) => m.kind)).toContain('supplier_vat');
  });

  it('finds the order without a reference when only one delivery is waiting to be billed', async () => {
    const x = await setup();
    const inv = (await uploadXml(x.token, ubl({ number: 'NR-1', supplierVat: x.supplierVat, lines: [{ name: 'Chicken', sku: 'CH-1', qty: 4, price: 24.75 }, { name: 'Tomato', qty: 10, price: 5.4 }] })).expect(201)).body;
    expect(inv).toMatchObject({ status: 'matched', po: { id: x.po.id } });
  });
});

describe('supplier invoices: reading, review and entry by hand', () => {
  it('finds the e-invoice embedded in a ZATCA PDF', async () => {
    const x = await setup();
    const xml = exact(x, 'PDF-1');
    const stream = deflateSync(Buffer.from(xml));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode /Length ' + stream.length + ' >>\nstream\n'),
      stream,
      Buffer.from('\nendstream\nendobj\n%%EOF\n'),
    ]);
    const inv = (await http.post('/v1/supplier-invoices/upload').set(auth(x.token)).send({ filename: 'INV.pdf', contentType: 'application/pdf', data: b64(pdf) }).expect(201)).body;
    expect(inv).toMatchObject({ extractedBy: 'xml', status: 'matched', number: 'PDF-1', document: { contentType: 'application/pdf' } });
  });

  it('keeps an unreadable invoice for review, then matches once a person fills it in', async () => {
    const x = await setup();
    const scan = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(uniq().repeat(50))]);
    const inv = (await http.post('/v1/supplier-invoices/upload').set(auth(x.token)).send({ filename: 'scan.pdf', contentType: 'application/pdf', data: b64(scan) }).expect(201)).body;
    expect(inv).toMatchObject({ status: 'needs_review', extractedBy: 'none', lines: [] });
    expect(inv.reviewReasons.sort()).toEqual(['no_order', 'unknown_supplier', 'unreadable']);
    expect(inv.extraction.note).toContain('by hand');

    // Choosing the supplier lists their deliveries waiting for an invoice.
    const withSupplier = (await http.patch(`/v1/supplier-invoices/${inv.id}`).set(auth(x.token)).send({ relationshipId: x.sup.id }).expect(200)).body;
    expect(withSupplier.candidates).toEqual([expect.objectContaining({ id: x.po.id, unbilled: '153.00' })]);

    const filled = (
      await http
        .patch(`/v1/supplier-invoices/${inv.id}`)
        .set(auth(x.token))
        .send({ poId: x.po.id, number: 'P-55', issueDate: '2026-11-07', lines: [{ description: 'دجاج', qty: 4, unitPrice: 24.75, poLineId: x.chickenLine.id }, { description: 'طماطم', qty: 10, unitPrice: 5.4 }], acknowledge: true })
        .expect(200)
    ).body;
    expect(filled).toMatchObject({ status: 'matched', reviewReasons: [], total: '175.95', dueDate: '2026-12-07' });
    expect(filled.match.lines[0]).toMatchObject({ method: 'manual', poLineId: x.chickenLine.id });
  });

  it('enters an invoice by hand; someone else must approve it', async () => {
    const x = await setup();
    const accountant = await invite(x.token, 'accountant');
    const ops = await invite(x.token, 'ops_manager');
    const inv = (
      await http
        .post('/v1/supplier-invoices')
        .set(auth(accountant))
        .send({ relationshipId: x.sup.id, poId: x.po.id, number: 'H-1', issueDate: '2026-11-08', lines: [{ description: 'Chicken', sku: 'CH-1', qty: 4, unitPrice: 24.75 }, { description: 'Tomato', qty: 10, unitPrice: 5.4 }] })
        .expect(201)
    ).body;
    expect(inv).toMatchObject({ status: 'matched', source: 'manual', extractedBy: 'manual', total: '175.95' });
    await http.post(`/v1/supplier-invoices/${inv.id}/approve`).set(auth(accountant)).send({}).expect(403);
    expect((await http.post(`/v1/supplier-invoices/${inv.id}/approve`).set(auth(ops)).send({}).expect(200)).body.status).toBe('approved');
  });

  it('rejects an invoice with a reason', async () => {
    const x = await setup();
    const inv = (await uploadXml(x.token, exact(x)).expect(201)).body;
    await http.post(`/v1/supplier-invoices/${inv.id}/reject`).set(auth(x.token)).send({}).expect(400);
    const r = (await http.post(`/v1/supplier-invoices/${inv.id}/reject`).set(auth(x.token)).send({ reason: 'Sent to the wrong company' }).expect(200)).body;
    expect(r).toMatchObject({ status: 'rejected', rejectReason: 'Sent to the wrong company', can: { approve: false } });
  });

  it('keeps invoices to the right sites and organisations', async () => {
    const x = await setup();
    const inv = (await uploadXml(x.token, exact(x)).expect(201)).body;
    const malqa = (await http.post('/v1/sites').set(auth(x.token)).send({ legalEntityId: x.legalEntityId, name: 'Malqa' }).expect(201)).body;
    const malqaMgr = await invite(x.token, 'site_manager', [malqa.id]);
    const olayaMgr = await invite(x.token, 'site_manager', [x.site.id]);
    const staff = await invite(x.token, 'staff', [x.site.id]);
    await http.get(`/v1/supplier-invoices/${inv.id}`).set(auth(malqaMgr)).expect(404);
    expect((await http.get('/v1/supplier-invoices?status=all').set(auth(malqaMgr)).expect(200)).body).toEqual([]);
    const seen = (await http.get(`/v1/supplier-invoices/${inv.id}`).set(auth(olayaMgr)).expect(200)).body;
    expect(seen.can).toMatchObject({ manage: true, approve: false }); // site managers enter invoices; approving is for finance
    await http.post(`/v1/supplier-invoices/${inv.id}/approve`).set(auth(olayaMgr)).send({}).expect(403);
    await uploadXml(staff, exact(x)).expect(403);

    const other = await signup();
    await http.get(`/v1/supplier-invoices/${inv.id}`).set(auth(other.token)).expect(404);
    await http.get(`/v1/supplier-invoices/${inv.id}/document`).set(auth(other.token)).expect(404);
  });
});

describe('supplier invoices by email', () => {
  it('gives each organisation a private address and reads invoices sent to it', async () => {
    const x = await setup();
    const box = (await http.get('/v1/supplier-invoices/inbox').set(auth(x.token)).expect(200)).body;
    expect(box).toMatchObject({ enabled: true, readsAutomatically: false });
    expect(box.address).toMatch(/^invoices\+[a-f0-9]{12}@in\.kitchain\.online$/);
    expect((await http.get('/v1/supplier-invoices/inbox').set(auth(x.token)).expect(200)).body.address).toBe(box.address);

    const messageId = `<${uniq()}@mail.wafra.sa>`;
    const mail = {
      messageId,
      from: 'Wafra Billing <billing@wafra.sa>',
      to: [box.address],
      subject: 'Invoice INV-3003',
      attachments: [
        { filename: 'logo.png', contentType: 'image/png', content: b64('tiny') },
        { filename: 'INV-3003.xml', contentType: 'application/xml', content: b64(exact(x, 'INV-3003')) },
      ],
    };
    await email(mail, 'sha256=bad').expect(401);
    const ok = await email(mail).expect(200);
    expect(ok.body).toMatchObject({ outcome: 'invoices_created' });
    expect(ok.body.invoices).toHaveLength(1);
    const inv = (await http.get(`/v1/supplier-invoices/${ok.body.invoices[0]}`).set(auth(x.token)).expect(200)).body;
    expect(inv).toMatchObject({ source: 'email', emailFrom: 'Wafra Billing <billing@wafra.sa>', status: 'matched', number: 'INV-3003', createdBy: null });

    // Providers retry: the same message is processed once.
    expect((await email(mail).expect(200)).body.outcome).toBe('duplicate');
  });

  it('holds invoices from unknown senders for review, and ignores unknown addresses', async () => {
    const x = await setup();
    const box = (await http.get('/v1/supplier-invoices/inbox').set(auth(x.token)).expect(200)).body;
    const ok = await email({ messageId: uniq(), from: 'someone@elsewhere.com', to: box.address, attachments: [{ filename: 'i.xml', contentType: 'text/xml', content: b64(exact(x)) }] }).expect(200);
    const inv = (await http.get(`/v1/supplier-invoices/${ok.body.invoices[0]}`).set(auth(x.token)).expect(200)).body;
    expect(inv).toMatchObject({ status: 'needs_review', reviewReasons: ['unknown_sender'] });
    // The supplier was still recognised from the VAT number; a person confirms the sender.
    expect(inv.supplier.id).toBe(x.sup.id);
    const confirmed = (await http.patch(`/v1/supplier-invoices/${inv.id}`).set(auth(x.token)).send({ acknowledge: true }).expect(200)).body;
    expect(confirmed.status).toBe('matched');

    expect((await email({ messageId: uniq(), from: 'a@b.com', to: 'invoices+nothing@in.kitchain.online', attachments: [] }).expect(200)).body.outcome).toBe('unknown_address');
    // The header's name before the rename still works.
    const legacy = JSON.stringify({ messageId: uniq(), from: 'a@b.com', to: 'invoices+nothing@in.kitchain.online', attachments: [] });
    expect((await http.post('/v1/webhooks/invoice-email').set('Content-Type', 'application/json').set('X-Backhouse-Signature', sign(legacy)).send(legacy).expect(200)).body.outcome).toBe('unknown_address');
    expect((await email({ messageId: uniq(), from: 'billing@wafra.sa', to: box.address, attachments: [] }).expect(200)).body.outcome).toBe('no_invoice_attachments');
  });
});
