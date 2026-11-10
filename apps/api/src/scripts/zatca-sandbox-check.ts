/**
 * Checks Kitchain's ZATCA phase 2 documents against ZATCA's own validator.
 *
 * Onboards a throwaway EGS unit on the Fatoora Developer Portal (sandbox OTP),
 * then submits a standard invoice, credit note and debit note and a simplified
 * invoice, credit note and debit note to /compliance/invoices, chained with ICV
 * and PIH, and prints ZATCA's verdict for each.
 *
 *   pnpm --filter @boh/api zatca:check
 */
import { randomUUID } from 'node:crypto';
import { buildCsr, certFromToken, generateKeys, readCert } from '../zatca/crypto.js';
import { FIRST_PIH, signInvoice, type DocType, type InvoiceInput, type Kind } from '../zatca/ubl.js';
import { HttpFatoora } from '../zatca/fatoora.js';

const VAT = '399999999900003';
const fatoora = new HttpFatoora(60_000);

async function main() {
  const keys = generateKeys();
  const csr = buildCsr({
    privateKeyPem: keys.privateKeyPem,
    environment: 'sandbox',
    commonName: `BOH-EGS-${randomUUID().slice(0, 8)}`,
    organizationName: 'Kitchain Test Kitchens',
    organizationUnit: 'Riyadh Branch',
    egsSerial: `1-Kitchain|2-1.0|3-${randomUUID()}`,
    vatNumber: VAT,
    invoiceTypes: '1100',
    location: 'Riyadh',
    industry: 'Food',
  });
  const csid = await fatoora.compliance('sandbox', csr.base64ForApi, '123345');
  console.log('Compliance CSID issued, request', csid.requestID);
  const cert = readCert(certFromToken(csid.binarySecurityToken));
  console.log('Certificate issuer:', cert.issuer, 'serial:', cert.serialNumber);

  let pih = FIRST_PIH;
  let icv = 1;
  const docs: [Kind, DocType][] = [
    ['standard', 'invoice'],
    ['standard', 'credit_note'],
    ['standard', 'debit_note'],
    ['simplified', 'invoice'],
    ['simplified', 'credit_note'],
    ['simplified', 'debit_note'],
  ];
  let failed = 0;
  for (const [kind, type] of docs) {
    const now = new Date();
    const input: InvoiceInput = {
      kind,
      type,
      number: `BOH-${kind[0]!.toUpperCase()}${type[0]!.toUpperCase()}-${icv}`,
      uuid: randomUUID(),
      issueDate: now.toISOString().slice(0, 10),
      issueTime: now.toISOString().slice(11, 19),
      supplyDate: kind === 'standard' ? now.toISOString().slice(0, 10) : null,
      icv,
      pih,
      seller: {
        name: 'شركة كيتشين للمطابخ',
        vatNumber: VAT,
        id: { scheme: 'CRN', value: '1010010000' },
        address: { street: 'King Fahd Road', building: '1234', district: 'Al Olaya', city: 'Riyadh', postalCode: '12345', additionalNumber: '5678' },
      },
      buyer:
        kind === 'standard'
          ? { name: 'شركة مطابخ نجد', vatNumber: '310122393500003', address: { street: 'Prince Sultan Street', building: '4321', district: 'Al Malqa', city: 'Riyadh', postalCode: '13521' } }
          : null,
      lines: [
        { name: 'صدر دجاج 1 كجم', qty: 4, unitPrice: '24.75', vatCategory: 'S', vatRate: 15 },
        { name: 'طماطم 1 كجم', qty: 10, unitPrice: '5.40', vatCategory: 'S', vatRate: 15, discount: '2.00' },
      ],
      paymentMeansCode: '10',
      billingReference: type === 'invoice' ? null : 'BOH-SI-1',
      reason: type === 'invoice' ? null : type === 'credit_note' ? 'Returned items' : 'Price correction',
    };
    const signed = signInvoice(input, { privateKeyPem: keys.privateKeyPem, cert });
    const res = await fatoora.complianceCheck('sandbox', csid, { invoiceHash: signed.hash, uuid: input.uuid, invoice: Buffer.from(signed.xml).toString('base64') });
    const v = res.validationResults;
    const ok = v?.status === 'PASS' || v?.status === 'WARNING';
    if (!ok) failed++;
    console.log(`\n${kind} ${type}: HTTP ${res.httpStatus} ${v?.status ?? ''} ${res.clearanceStatus ?? res.reportingStatus ?? ''}`);
    for (const m of v?.errorMessages ?? []) console.log(`  ERROR ${m.code}: ${m.message}`);
    for (const m of v?.warningMessages ?? []) console.log(`  warning ${m.code}: ${m.message}`);
    if (process.env.ZATCA_DUMP && !ok) console.log(signed.xml);
    pih = signed.hash;
    icv++;
  }
  // Production certificate, then a real clearance and reporting call with it.
  if (!failed) {
    const prod = await fatoora.productionCsid('sandbox', csid, String(csid.requestID));
    const prodCert = readCert(certFromToken(prod.binarySecurityToken));
    console.log('\nProduction CSID issued, serial', prodCert.serialNumber);
    // The Developer Portal's production certificate is a fixed placeholder that does not carry our
    // key, so documents signed with our key can't verify against it there. The compliance checks
    // above are ZATCA's full validation; end-to-end production runs need the simulation environment.
    const placeholder = !prodCert.publicKeyDer.equals(readCert(certFromToken(csid.binarySecurityToken)).publicKeyDer);
    if (placeholder) console.log('(sandbox placeholder certificate: production results below are informational)');
    for (const kind of ['standard', 'simplified'] as Kind[]) {
      const now = new Date();
      const input: InvoiceInput = {
        kind, type: 'invoice', number: `BOH-P-${icv}`, uuid: randomUUID(), issueDate: now.toISOString().slice(0, 10), issueTime: now.toISOString().slice(11, 19),
        supplyDate: now.toISOString().slice(0, 10), icv, pih,
        seller: { name: 'شركة كيتشين للمطابخ', vatNumber: VAT, id: { scheme: 'CRN', value: '1010010000' }, address: { street: 'King Fahd Road', building: '1234', district: 'Al Olaya', city: 'Riyadh', postalCode: '12345' } },
        buyer: kind === 'standard' ? { name: 'شركة مطابخ نجد', vatNumber: '310122393500003', address: { street: 'Prince Sultan Street', building: '4321', district: 'Al Malqa', city: 'Riyadh', postalCode: '13521' } } : null,
        lines: [
          { name: 'وجبة', qty: 1, unitPrice: '100', vatCategory: 'S', vatRate: 15 },
          { name: 'Export service', qty: 1, unitPrice: '50', vatCategory: 'Z', vatRate: 0, exemptionCode: 'VATEX-SA-32', exemptionReason: 'Export of goods' },
        ],
      };
      const signed = signInvoice(input, { privateKeyPem: keys.privateKeyPem, cert: prodCert });
      const body = { invoiceHash: signed.hash, uuid: input.uuid, invoice: Buffer.from(signed.xml).toString('base64') };
      const res = kind === 'standard' ? await fatoora.clearance('sandbox', prod, body) : await fatoora.reporting('sandbox', prod, body);
      const v = res.validationResults;
      console.log(`${kind} (production): HTTP ${res.httpStatus} ${v?.status ?? ''} ${res.clearanceStatus ?? res.reportingStatus ?? ''}${res.clearedInvoice ? ' (cleared XML returned)' : ''}`);
      for (const m of v?.errorMessages ?? []) console.log(`  ERROR ${m.code}: ${m.message}`);
      for (const m of v?.warningMessages ?? []) console.log(`  warning ${m.code}: ${m.message}`);
      if (v?.status === 'ERROR' && !placeholder) failed++;
      pih = signed.hash;
      icv++;
    }
  }
  console.log(failed ? `\n${failed} document(s) failed` : '\nAll documents passed ZATCA validation');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
