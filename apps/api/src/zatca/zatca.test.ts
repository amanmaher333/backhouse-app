import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCsr, certFromToken, generateKeys, readCert, verifyHash } from './crypto.js';
import { FatooraRejected, SimulatedFatoora } from './fatoora.js';
import { FIRST_PIH, computeTotals, readQr, signInvoice, type InvoiceInput } from './ubl.js';

const dir = mkdtempSync(join(tmpdir(), 'zatca-'));
const csrInput = (privateKeyPem: string) => ({
  privateKeyPem,
  environment: 'sandbox' as const,
  commonName: 'BOH-EGS-1',
  organizationName: 'Najd Kitchens Co.',
  organizationUnit: 'Olaya',
  egsSerial: `1-Backhouse|2-1.0|3-${randomUUID()}`,
  vatNumber: '399999999900003',
  invoiceTypes: '1100',
  location: 'Riyadh',
  industry: 'Food',
});

async function onboard() {
  const keys = generateKeys();
  const sim = new SimulatedFatoora();
  const csid = await sim.compliance('sandbox', buildCsr(csrInput(keys.privateKeyPem)).base64ForApi, '123456');
  return { keys, sim, csid, cert: readCert(certFromToken(csid.binarySecurityToken)) };
}

const invoice = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  kind: 'simplified',
  type: 'invoice',
  number: 'SI-1',
  uuid: randomUUID(),
  issueDate: '2026-11-09',
  issueTime: '10:15:00',
  icv: 1,
  pih: FIRST_PIH,
  seller: { name: 'شركة مطابخ نجد & شركاه', vatNumber: '399999999900003', id: { scheme: 'CRN', value: '1010010000' }, address: { street: 'King Fahd Road', building: '1234', district: 'Olaya', city: 'Riyadh', postalCode: '12345' } },
  lines: [
    { name: 'صدر دجاج <1 كجم>', qty: 4, unitPrice: '24.75', vatCategory: 'S', vatRate: 15 },
    { name: 'Tomato', qty: '2.5', unitPrice: '5.40', vatCategory: 'S', vatRate: 15, discount: '1.00' },
  ],
  ...over,
});

describe('ZATCA certificate request', () => {
  it('is a valid PKCS#10 request with ZATCA’s template name and EGS details', () => {
    const { privateKeyPem } = generateKeys();
    const csr = buildCsr(csrInput(privateKeyPem));
    expect(Buffer.from(csr.base64ForApi, 'base64').toString()).toBe(csr.pem);
    const file = join(dir, 'req.csr');
    writeFileSync(file, csr.pem);
    // OpenSSL versions differ in spacing around "=" (1.1/3.x: "C = SA", some 3.0 builds: "C=SA").
    const out = execFileSync('openssl', ['req', '-in', file, '-noout', '-verify', '-text'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\s*=\s*/g, '=');
    expect(out).toContain('C=SA, OU=Olaya, O=Najd Kitchens Co., CN=BOH-EGS-1');
    expect(out).toContain('secp256k1');
    expect(out).toContain('TSTZATCA-Code-Signing');
    expect(out).toMatch(/SN=1-Backhouse\|2-1\.0\|3-/);
    expect(out).toContain('399999999900003');
    expect(out).toContain('1100');
  });
});

describe('ZATCA documents', () => {
  it('computes line and category totals in halalas', () => {
    const t = computeTotals(invoice().lines);
    expect(t.lines).toEqual([
      { net: '99.00', vat: '14.85', gross: '113.85' },
      { net: '12.50', vat: '1.88', gross: '14.38' },
    ]);
    expect(t).toMatchObject({ lineExtension: '111.50', tax: '16.73', taxInclusive: '128.23', groups: [{ category: 'S', rate: '15.00', taxable: '111.50', tax: '16.73' }] });
  });

  it('hashes exactly what a C14N 1.1 implementation produces for the document without the signature', async () => {
    const { keys, cert } = await onboard();
    const s = signInvoice(invoice(), { privateKeyPem: keys.privateKeyPem, cert });
    // Remove the three parts the signature's transforms exclude, then canonicalise with libxml2.
    const stripped = s.xml
      .replace(/<ext:UBLExtensions>[\s\S]*<\/ext:UBLExtensions>/, '')
      .replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, '')
      .replace(/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/, '');
    const file = join(dir, 'inv.xml');
    writeFileSync(file, stripped);
    const canonical = execFileSync('xmllint', ['--c14n11', file]);
    expect(createHash('sha256').update(canonical).digest('base64')).toBe(s.hash);
    // The whole document is already in canonical form.
    writeFileSync(file, s.xml);
    expect(execFileSync('xmllint', ['--c14n11', file]).toString()).toBe(s.xml.replace(/^<\?xml[^>]*>\n/, ''));
  });

  it('signs with the unit’s key and puts tags 1–9 in the QR code', async () => {
    const { keys, cert } = await onboard();
    const s = signInvoice(invoice(), { privateKeyPem: keys.privateKeyPem, cert });
    expect(verifyHash(s.hash, s.signature, cert.publicKey)).toBe(true);
    const qr = readQr(s.qr);
    expect(qr.map((b) => b.length > 0)).toHaveLength(9);
    expect(qr[0]!.toString()).toBe('شركة مطابخ نجد & شركاه');
    expect(qr[1]!.toString()).toBe('399999999900003');
    expect(qr[2]!.toString()).toBe('2026-11-09T10:15:00');
    expect(qr[3]!.toString()).toBe('128.23');
    expect(qr[4]!.toString()).toBe('16.73');
    expect(qr[5]!.toString()).toBe(s.hash);
    expect(qr[6]!.toString()).toBe(s.signature);
    expect(qr[7]!.equals(cert.publicKeyDer)).toBe(true);
    expect(qr[8]!.equals(cert.signature)).toBe(true);
    // Standard (B2B) invoices carry tags 1–8; ZATCA stamps them when clearing.
    const std = signInvoice(invoice({ kind: 'standard', buyer: { name: 'Buyer', vatNumber: '310122393500003' } }), { privateKeyPem: keys.privateKeyPem, cert });
    expect(readQr(std.qr)).toHaveLength(8);
    expect(std.xml).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
  });

  it('writes credit notes with the invoice they correct and the reason', async () => {
    const { keys, cert } = await onboard();
    const s = signInvoice(invoice({ type: 'credit_note', billingReference: 'SI-1', reason: 'Returned' }), { privateKeyPem: keys.privateKeyPem, cert });
    expect(s.xml).toContain('name="0200000">381<');
    expect(s.xml).toContain('<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>SI-1</cbc:ID>');
    expect(s.xml).toContain('<cbc:InstructionNote>Returned</cbc:InstructionNote>');
  });

  it('is accepted by the simulated ZATCA, and tampering is caught', async () => {
    const { keys, sim, csid, cert } = await onboard();
    const s = signInvoice(invoice(), { privateKeyPem: keys.privateKeyPem, cert });
    const body = { invoiceHash: s.hash, uuid: invoice().uuid, invoice: Buffer.from(s.xml).toString('base64') };
    const uuid = s.xml.match(/<cbc:UUID>([^<]+)<\/cbc:UUID>/)![1]!;
    const ok = await sim.complianceCheck('sandbox', csid, { ...body, uuid });
    expect(ok).toMatchObject({ httpStatus: 200, reportingStatus: 'REPORTED', validationResults: { status: 'PASS' } });
    const bad = await sim.complianceCheck('sandbox', csid, { ...body, uuid, invoiceHash: createHash('sha256').update('x').digest('base64') });
    expect(bad.validationResults?.status).toBe('ERROR');
    await expect(sim.compliance('sandbox', 'x', '000000')).rejects.toBeInstanceOf(FatooraRejected);
    await expect(sim.complianceCheck('sandbox', { ...csid, secret: 'wrong' }, body)).rejects.toBeInstanceOf(FatooraRejected);
    // Production certificate for the same key.
    const prod = await sim.productionCsid('sandbox', csid, String(csid.requestID));
    expect(readCert(certFromToken(prod.binarySecurityToken)).publicKeyDer.equals(cert.publicKeyDer)).toBe(true);
    expect((await sim.reporting('sandbox', prod, { ...body, uuid })).reportingStatus).toBe('REPORTED');
  });
});
