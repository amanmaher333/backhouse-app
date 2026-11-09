import { createHash } from 'node:crypto';
import { Decimal } from '@boh/domain';
import { signHash, type CertInfo } from './crypto.js';
import { c14n, el, excC14n, without, xmlDocument, type El } from './xml.js';

/*
 * ZATCA phase 2 tax invoices, credit notes and debit notes as UBL 2.1 XML,
 * following ZATCA's "Electronic Invoice XML Implementation Standard" and
 * "Security Features Implementation Standards":
 * - invoice counter (ICV) and previous invoice hash (PIH) chain per EGS unit;
 * - invoice hash over the canonical document without the signature parts;
 * - XAdES enveloped signature with the EGS unit's certificate;
 * - QR code with tags 1–9.
 */

export const NS = {
  inv: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  sig: 'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2',
  sac: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2',
  sbc: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  xades: 'http://uri.etsi.org/01903/v1.3.2#',
};

/** PIH of the first document of an EGS unit: base64 of the hex SHA-256 of "0". */
export const FIRST_PIH = Buffer.from(createHash('sha256').update('0').digest('hex')).toString('base64');

export type VatCategory = 'S' | 'Z' | 'E' | 'O';

export interface Address {
  street: string;
  building: string;
  district: string;
  city: string;
  postalCode: string;
  additionalNumber?: string | null;
  country?: string;
}

export interface Party {
  name: string;
  vatNumber?: string | null;
  /** Other identifier: CRN (commercial registration), MOM, MLS, 700, SAG, NAT, GCC, IQA, PAS, OTH. */
  id?: { scheme: string; value: string } | null;
  address?: Address | null;
}

export interface Line {
  name: string;
  qty: Decimal.Value;
  unitPrice: Decimal.Value;
  discount?: Decimal.Value | null;
  vatCategory: VatCategory;
  /** Percent, e.g. 15. */
  vatRate: Decimal.Value;
  exemptionCode?: string | null;
  exemptionReason?: string | null;
}

export type DocType = 'invoice' | 'credit_note' | 'debit_note';
export type Kind = 'standard' | 'simplified';

export interface InvoiceInput {
  kind: Kind;
  type: DocType;
  number: string;
  uuid: string;
  issueDate: string;
  issueTime: string;
  supplyDate?: string | null;
  currency?: string;
  icv: number;
  pih: string;
  seller: Party;
  buyer?: Party | null;
  lines: Line[];
  /** UN/ECE 4461: 10 cash, 30 credit transfer, 42 bank account, 48 card, 1 not defined. */
  paymentMeansCode?: string;
  /** Credit/debit notes: the invoice corrected, and why. */
  billingReference?: string | null;
  reason?: string | null;
  note?: string | null;
}

const TYPE_CODE: Record<DocType, string> = { invoice: '388', credit_note: '381', debit_note: '383' };
const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const amt = (d: Decimal.Value) => new Decimal(d).toFixed(2);
const qtyText = (d: Decimal.Value) => new Decimal(d).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

export interface Totals {
  lines: { net: string; vat: string; gross: string }[];
  groups: { category: VatCategory; rate: string; taxable: string; tax: string; exemptionCode?: string | null; exemptionReason?: string | null }[];
  lineExtension: string;
  taxExclusive: string;
  tax: string;
  taxInclusive: string;
  payable: string;
}

/** Line amounts rounded to halalas; VAT per category on the category's total. */
export function computeTotals(lines: Line[]): Totals {
  const ls = lines.map((l) => {
    const net = r2(new Decimal(l.qty).mul(l.unitPrice).minus(l.discount ?? 0));
    const vat = r2(net.mul(l.vatRate).div(100));
    return { net, vat, gross: net.plus(vat), l };
  });
  const groups = new Map<string, { category: VatCategory; rate: Decimal; taxable: Decimal; exemptionCode?: string | null; exemptionReason?: string | null }>();
  for (const x of ls) {
    const key = `${x.l.vatCategory}:${new Decimal(x.l.vatRate).toFixed(2)}`;
    const g = groups.get(key) ?? { category: x.l.vatCategory, rate: new Decimal(x.l.vatRate), taxable: new Decimal(0), exemptionCode: x.l.exemptionCode, exemptionReason: x.l.exemptionReason };
    g.taxable = g.taxable.plus(x.net);
    groups.set(key, g);
  }
  const gs = [...groups.values()].map((g) => ({ ...g, tax: r2(g.taxable.mul(g.rate).div(100)) }));
  const lineExtension = ls.reduce((s, x) => s.plus(x.net), new Decimal(0));
  const tax = gs.reduce((s, g) => s.plus(g.tax), new Decimal(0));
  return {
    lines: ls.map((x) => ({ net: amt(x.net), vat: amt(x.vat), gross: amt(x.gross) })),
    groups: gs.map((g) => ({ category: g.category, rate: g.rate.toFixed(2), taxable: amt(g.taxable), tax: amt(g.tax), exemptionCode: g.exemptionCode, exemptionReason: g.exemptionReason })),
    lineExtension: amt(lineExtension),
    taxExclusive: amt(lineExtension),
    tax: amt(tax),
    taxInclusive: amt(lineExtension.plus(tax)),
    payable: amt(lineExtension.plus(tax)),
  };
}

const money = (name: string, v: Decimal.Value, currency: string) => el(name, { currencyID: currency }, amt(v));

function party(p: Party, role: 'supplier' | 'customer'): El {
  const a = p.address;
  return el('cac:Party', [
    p.id ? el('cac:PartyIdentification', [el('cbc:ID', { schemeID: p.id.scheme }, p.id.value)]) : null,
    a
      ? el('cac:PostalAddress', [
          el('cbc:StreetName', [a.street]),
          el('cbc:BuildingNumber', [a.building]),
          a.additionalNumber ? el('cbc:PlotIdentification', [a.additionalNumber]) : null,
          el('cbc:CitySubdivisionName', [a.district]),
          el('cbc:CityName', [a.city]),
          el('cbc:PostalZone', [a.postalCode]),
          el('cac:Country', [el('cbc:IdentificationCode', [a.country ?? 'SA'])]),
        ])
      : null,
    p.vatNumber
      ? el('cac:PartyTaxScheme', [el('cbc:CompanyID', [p.vatNumber]), el('cac:TaxScheme', [el('cbc:ID', ['VAT'])])])
      : role === 'customer'
        ? el('cac:PartyTaxScheme', [el('cac:TaxScheme', [el('cbc:ID', ['VAT'])])])
        : null,
    el('cac:PartyLegalEntity', [el('cbc:RegistrationName', [p.name])]),
  ]);
}

const embedded = (id: string, value: string) => el('cac:AdditionalDocumentReference', [el('cbc:ID', [id]), el('cac:Attachment', [el('cbc:EmbeddedDocumentBinaryObject', { mimeCode: 'text/plain' }, value)])]);

/** The document body: everything but the signature, with or without the QR code. */
function body(i: InvoiceInput, t: Totals, extras: { qr?: string; ublExtensions?: El }): El {
  const cur = i.currency ?? 'SAR';
  const isNote = i.type !== 'invoice';
  return el(
    'Invoice',
    { xmlns: NS.inv, 'xmlns:cac': NS.cac, 'xmlns:cbc': NS.cbc, 'xmlns:ext': NS.ext },
    extras.ublExtensions,
    el('cbc:ProfileID', ['reporting:1.0']),
    el('cbc:ID', [i.number]),
    el('cbc:UUID', [i.uuid]),
    el('cbc:IssueDate', [i.issueDate]),
    el('cbc:IssueTime', [i.issueTime]),
    el('cbc:InvoiceTypeCode', { name: i.kind === 'standard' ? '0100000' : '0200000' }, TYPE_CODE[i.type]),
    i.note ? el('cbc:Note', [i.note]) : null,
    el('cbc:DocumentCurrencyCode', [cur]),
    el('cbc:TaxCurrencyCode', ['SAR']),
    isNote && i.billingReference ? el('cac:BillingReference', [el('cac:InvoiceDocumentReference', [el('cbc:ID', [i.billingReference])])]) : null,
    el('cac:AdditionalDocumentReference', [el('cbc:ID', ['ICV']), el('cbc:UUID', [String(i.icv)])]),
    embedded('PIH', i.pih),
    extras.qr ? embedded('QR', extras.qr) : null,
    extras.ublExtensions ? el('cac:Signature', [el('cbc:ID', ['urn:oasis:names:specification:ubl:signature:Invoice']), el('cbc:SignatureMethod', ['urn:oasis:names:specification:ubl:dsig:enveloped:xades'])]) : null,
    el('cac:AccountingSupplierParty', [party(i.seller, 'supplier')]),
    el('cac:AccountingCustomerParty', i.buyer ? [party(i.buyer, 'customer')] : []),
    i.supplyDate ? el('cac:Delivery', [el('cbc:ActualDeliveryDate', [i.supplyDate])]) : null,
    el('cac:PaymentMeans', [el('cbc:PaymentMeansCode', [i.paymentMeansCode ?? '10']), isNote && i.reason ? el('cbc:InstructionNote', [i.reason]) : null]),
    el('cac:TaxTotal', [
      money('cbc:TaxAmount', t.tax, cur),
      ...t.groups.map((g) =>
        el('cac:TaxSubtotal', [
          money('cbc:TaxableAmount', g.taxable, cur),
          money('cbc:TaxAmount', g.tax, cur),
          el('cac:TaxCategory', [
            el('cbc:ID', { schemeAgencyID: '6', schemeID: 'UN/ECE 5305' }, g.category),
            el('cbc:Percent', [g.rate]),
            g.exemptionCode ? el('cbc:TaxExemptionReasonCode', [g.exemptionCode]) : null,
            g.exemptionReason ? el('cbc:TaxExemptionReason', [g.exemptionReason]) : null,
            el('cac:TaxScheme', [el('cbc:ID', { schemeAgencyID: '6', schemeID: 'UN/ECE 5153' }, 'VAT')]),
          ]),
        ]),
      ),
    ]),
    el('cac:TaxTotal', [money('cbc:TaxAmount', t.tax, 'SAR')]),
    el('cac:LegalMonetaryTotal', [
      money('cbc:LineExtensionAmount', t.lineExtension, cur),
      money('cbc:TaxExclusiveAmount', t.taxExclusive, cur),
      money('cbc:TaxInclusiveAmount', t.taxInclusive, cur),
      money('cbc:AllowanceTotalAmount', 0, cur),
      money('cbc:PrepaidAmount', 0, cur),
      money('cbc:PayableAmount', t.payable, cur),
    ]),
    ...i.lines.map((l, n) =>
      el('cac:InvoiceLine', [
        el('cbc:ID', [String(n + 1)]),
        el('cbc:InvoicedQuantity', { unitCode: 'PCE' }, qtyText(l.qty)),
        money('cbc:LineExtensionAmount', t.lines[n]!.net, cur),
        // A line discount is an invoice line allowance (BT-136): net = qty × price − allowance.
        l.discount && new Decimal(l.discount).gt(0)
          ? el('cac:AllowanceCharge', [el('cbc:ChargeIndicator', ['false']), el('cbc:AllowanceChargeReasonCode', ['95']), el('cbc:AllowanceChargeReason', ['Discount']), money('cbc:Amount', l.discount, cur)])
          : null,
        el('cac:TaxTotal', [money('cbc:TaxAmount', t.lines[n]!.vat, cur), money('cbc:RoundingAmount', t.lines[n]!.gross, cur)]),
        el('cac:Item', [
          el('cbc:Name', [l.name]),
          el('cac:ClassifiedTaxCategory', [el('cbc:ID', [l.vatCategory]), el('cbc:Percent', [new Decimal(l.vatRate).toFixed(2)]), el('cac:TaxScheme', [el('cbc:ID', ['VAT'])])]),
        ]),
        el('cac:Price', [money('cbc:PriceAmount', l.unitPrice, cur)]),
      ]),
    ),
  );
}

/** Invoice hash: SHA-256 of the canonical document without UBLExtensions, cac:Signature and the QR. */
export function invoiceHash(root: El): string {
  const stripped = without(root, (x) => x.name === 'ext:UBLExtensions' || x.name === 'cac:Signature' || (x.name === 'cac:AdditionalDocumentReference' && x.children?.some((c) => c && typeof c !== 'string' && c.name === 'cbc:ID' && c.children?.[0] === 'QR') === true));
  return createHash('sha256').update(c14n(stripped), 'utf8').digest('base64');
}

/** QR code: TLV (tag, length, value) of tags 1–9, base64. */
export function qrTlv(fields: (string | Buffer)[]): string {
  return Buffer.concat(
    fields.map((v, i) => {
      const b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
      if (b.length > 255) throw new Error(`QR tag ${i + 1} is too long`);
      return Buffer.concat([Buffer.from([i + 1, b.length]), b]);
    }),
  ).toString('base64');
}

export function readQr(base64: string): Buffer[] {
  const b = Buffer.from(base64, 'base64');
  const out: Buffer[] = [];
  let p = 0;
  while (p < b.length) {
    const tag = b[p]!;
    const n = b[p + 1]!;
    out[tag - 1] = b.subarray(p + 2, p + 2 + n);
    p += 2 + n;
  }
  return out;
}

function signedProperties(signingTime: string, cert: CertInfo): El {
  return el('xades:SignedProperties', { Id: 'xadesSignedProperties' }, [
    el('xades:SignedSignatureProperties', [
      el('xades:SigningTime', [signingTime]),
      el('xades:SigningCertificate', [
        el('xades:Cert', [
          el('xades:CertDigest', [el('ds:DigestMethod', { Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }), el('ds:DigestValue', [cert.digest])]),
          el('xades:IssuerSerial', [el('ds:X509IssuerName', [cert.issuer]), el('ds:X509SerialNumber', [cert.serialNumber])]),
        ]),
      ]),
    ]),
  ]);
}

export interface Signed {
  xml: string;
  hash: string;
  signature: string;
  qr: string;
  totals: Totals;
}

/** Build, hash, sign and add the QR code. */
export function signInvoice(i: InvoiceInput, keys: { privateKeyPem: string; cert: CertInfo }, signingTime = `${i.issueDate}T${i.issueTime}`): Signed {
  const totals = computeTotals(i.lines);
  const hash = invoiceHash(body(i, totals, {}));
  const signature = signHash(hash, keys.privateKeyPem);
  const props = signedProperties(signingTime, keys.cert);
  // Digest of the signed properties: exclusive canonical form, then base64 of the hex SHA-256.
  const propsDigest = Buffer.from(createHash('sha256').update(excC14n(props, new Map([['xades', NS.xades], ['ds', NS.ds]]))).digest('hex')).toString('base64');

  const qrFields: (string | Buffer)[] = [i.seller.name, i.seller.vatNumber ?? '', `${i.issueDate}T${i.issueTime}`, totals.taxInclusive, totals.tax, hash, signature, keys.cert.publicKeyDer];
  if (i.kind === 'simplified') qrFields.push(keys.cert.signature);
  const qr = qrTlv(qrFields);

  const xpath = (expr: string) => el('ds:Transform', { Algorithm: 'http://www.w3.org/TR/1999/REC-xpath-19991116' }, [el('ds:XPath', [expr])]);
  const ublExtensions = el('ext:UBLExtensions', [
    el('ext:UBLExtension', [
      el('ext:ExtensionURI', ['urn:oasis:names:specification:ubl:dsig:enveloped:xades']),
      el('ext:ExtensionContent', [
        el('sig:UBLDocumentSignatures', { 'xmlns:sig': NS.sig, 'xmlns:sac': NS.sac, 'xmlns:sbc': NS.sbc }, [
          el('sac:SignatureInformation', [
            el('cbc:ID', ['urn:oasis:names:specification:ubl:signature:1']),
            el('sbc:ReferencedSignatureID', ['urn:oasis:names:specification:ubl:signature:Invoice']),
            el('ds:Signature', { 'xmlns:ds': NS.ds, Id: 'signature' }, [
              el('ds:SignedInfo', [
                el('ds:CanonicalizationMethod', { Algorithm: 'http://www.w3.org/2006/12/xml-c14n11' }),
                el('ds:SignatureMethod', { Algorithm: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256' }),
                el('ds:Reference', { Id: 'invoiceSignedData', URI: '' }, [
                  el('ds:Transforms', [
                    xpath('not(//ancestor-or-self::ext:UBLExtensions)'),
                    xpath('not(//ancestor-or-self::cac:Signature)'),
                    xpath("not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])"),
                    el('ds:Transform', { Algorithm: 'http://www.w3.org/2006/12/xml-c14n11' }),
                  ]),
                  el('ds:DigestMethod', { Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }),
                  el('ds:DigestValue', [hash]),
                ]),
                el('ds:Reference', { Type: 'http://www.w3.org/2000/09/xmldsig#SignatureProperties', URI: '#xadesSignedProperties' }, [
                  el('ds:DigestMethod', { Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' }),
                  el('ds:DigestValue', [propsDigest]),
                ]),
              ]),
              el('ds:SignatureValue', [signature]),
              el('ds:KeyInfo', [el('ds:X509Data', [el('ds:X509Certificate', [keys.cert.base64])])]),
              el('ds:Object', [el('xades:QualifyingProperties', { 'xmlns:xades': NS.xades, Target: 'signature' }, [props])]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);
  const root = body(i, totals, { qr, ublExtensions });
  // The signed document must hash to the same value as the unsigned body.
  if (invoiceHash(root) !== hash) throw new Error('Invoice hash changed while signing');
  return { xml: xmlDocument(root), hash, signature, qr, totals };
}
