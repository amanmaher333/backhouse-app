import { Decimal } from 'decimal.js';
import { XMLParser } from 'fast-xml-parser';
import { normalizeName } from './text.js';
import { currencyAr } from './countries.js';

/*
 * Supplier invoices: what an invoice says (from a ZATCA e-invoice, AI extraction
 * or typed in), and the three-way match against the purchase order and what
 * was actually received. Everything here is deterministic: the AI only reads
 * documents; code decides whether the restaurant should pay.
 */

export type InvoiceDocType = 'invoice' | 'credit_note' | 'debit_note';

export interface InvoiceLineDraft {
  description: string;
  sku?: string | null;
  qty: string;
  unit?: string | null;
  /** Price per unit, before VAT. */
  unitPrice: string;
  /** qty × unitPrice before VAT, as printed. */
  lineTotal: string;
  /** VAT rate as a fraction (0.15). */
  taxRate?: string | null;
}

export interface InvoiceDraft {
  type: InvoiceDocType;
  number: string;
  uuid?: string | null;
  issueDate: string | null;
  dueDate?: string | null;
  currency: string;
  supplier: { name?: string | null; vatNumber?: string | null; crNumber?: string | null };
  buyer: { name?: string | null; vatNumber?: string | null };
  /** The buyer's order number printed on the invoice (our PO number). */
  orderReference?: string | null;
  /** For credit and debit notes: the invoice they correct. */
  billingReference?: string | null;
  lines: InvoiceLineDraft[];
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
}

// ---------------------------------------------------------------------------
// ZATCA / UBL 2.1 e-invoices
// ---------------------------------------------------------------------------

const ARRAYS = new Set(['InvoiceLine', 'CreditNoteLine', 'DebitNoteLine', 'TaxTotal', 'TaxSubtotal', 'PartyIdentification', 'PartyTaxScheme', 'AdditionalDocumentReference', 'BillingReference']);

type Node = Record<string, unknown> | string | undefined;

/** Text of a UBL element, whether it is plain text or has attributes. */
function text(n: unknown): string | null {
  if (n === undefined || n === null) return null;
  if (typeof n === 'string' || typeof n === 'number') return String(n).trim() || null;
  if (Array.isArray(n)) return text(n[0]);
  if (typeof n === 'object' && '#text' in (n as Record<string, unknown>)) return text((n as Record<string, unknown>)['#text']);
  return null;
}
const child = (n: Node, ...path: string[]): Node => {
  let cur: unknown = n;
  for (const p of path) {
    if (Array.isArray(cur)) cur = cur[0];
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return Array.isArray(cur) ? (cur[0] as Node) : (cur as Node);
};
const list = (n: Node, key: string): Record<string, unknown>[] => {
  if (!n || typeof n !== 'object') return [];
  const v = (n as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : v ? [v as Record<string, unknown>] : [];
};
const attr = (n: unknown, name: string): string | null =>
  n && typeof n === 'object' && !Array.isArray(n) ? text((n as Record<string, unknown>)[`@_${name}`]) : null;
const num = (v: string | null): string | null => (v !== null && v !== '' && !Number.isNaN(Number(v)) ? new Decimal(v).toString() : null);

export class InvoiceParseError extends Error {}

/**
 * Read a UBL 2.1 invoice, credit note or debit note, as issued under ZATCA phase 2
 * (and by most GCC e-invoicing systems). Unknown elements are ignored.
 */
export function parseUblInvoice(xml: string): InvoiceDraft {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true,
    isArray: (name) => ARRAYS.has(name),
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (e) {
    throw new InvoiceParseError(`Not valid XML: ${(e as Error).message}`);
  }
  const rootName = ['Invoice', 'CreditNote', 'DebitNote'].find((k) => k in doc);
  if (!rootName) throw new InvoiceParseError('Not a UBL invoice (no Invoice, CreditNote or DebitNote element)');
  const root = doc[rootName] as Record<string, unknown>;

  // ZATCA uses <Invoice> for all three, with InvoiceTypeCode 388 / 381 / 383.
  const code = text(child(root, 'InvoiceTypeCode')) ?? text(child(root, 'CreditNoteTypeCode'));
  const type: InvoiceDocType =
    rootName === 'CreditNote' || code === '381' ? 'credit_note' : rootName === 'DebitNote' || code === '383' ? 'debit_note' : 'invoice';

  const party = (key: string) => child(root, key, 'Party');
  const supplierParty = party('AccountingSupplierParty');
  const buyerParty = party('AccountingCustomerParty');
  const vatOf = (p: Node) => {
    for (const s of list(p, 'PartyTaxScheme')) {
      const id = text(s['CompanyID']);
      if (id) return id;
    }
    return null;
  };
  const crOf = (p: Node) => {
    for (const s of list(p, 'PartyIdentification')) {
      const id = s['ID'];
      if (attr(id, 'schemeID') === 'CRN') return text(id);
    }
    return null;
  };
  const nameOf = (p: Node) => text(child(p, 'PartyLegalEntity', 'RegistrationName')) ?? text(child(p, 'PartyName', 'Name'));

  const lineKey = rootName === 'CreditNote' ? 'CreditNoteLine' : rootName === 'DebitNote' ? 'DebitNoteLine' : 'InvoiceLine';
  const qtyKey = rootName === 'CreditNote' ? 'CreditedQuantity' : rootName === 'DebitNote' ? 'DebitedQuantity' : 'InvoicedQuantity';
  const lines: InvoiceLineDraft[] = list(root, lineKey).map((l) => {
    const qtyNode = l[qtyKey];
    const qty = num(text(qtyNode)) ?? '1';
    const lineTotal = num(text(l['LineExtensionAmount'])) ?? '0';
    const price = num(text(child(l as Node, 'Price', 'PriceAmount')));
    const base = num(text(child(l as Node, 'Price', 'BaseQuantity'))) ?? '1';
    const unitPrice = price !== null ? new Decimal(price).div(new Decimal(base).isZero() ? 1 : base) : new Decimal(qty).isZero() ? new Decimal(0) : new Decimal(lineTotal).div(qty);
    const percent = num(text(child(l as Node, 'Item', 'ClassifiedTaxCategory', 'Percent')));
    return {
      description: text(child(l as Node, 'Item', 'Name')) ?? text(child(l as Node, 'Item', 'Description')) ?? '',
      sku: text(child(l as Node, 'Item', 'SellersItemIdentification', 'ID')),
      qty,
      unit: attr(qtyNode, 'unitCode'),
      unitPrice: unitPrice.toDecimalPlaces(4).toString(),
      lineTotal,
      taxRate: percent !== null ? new Decimal(percent).div(100).toString() : null,
    };
  });

  // The first TaxTotal is in the document currency; ZATCA adds a second one in SAR without subtotals.
  const taxTotals = list(root, 'TaxTotal');
  const taxTotal = num(text(taxTotals[0]?.['TaxAmount']));
  const totals = child(root, 'LegalMonetaryTotal') ?? child(root, 'RequestedMonetaryTotal');
  const number = text(child(root, 'ID'));
  if (!number) throw new InvoiceParseError('The invoice has no number (cbc:ID)');

  return {
    type,
    number,
    uuid: text(child(root, 'UUID')),
    issueDate: text(child(root, 'IssueDate')),
    dueDate: text(child(root, 'DueDate')) ?? text(child(root, 'PaymentMeans', 'PaymentDueDate')),
    currency: text(child(root, 'DocumentCurrencyCode')) ?? 'SAR',
    supplier: { name: nameOf(supplierParty), vatNumber: vatOf(supplierParty), crNumber: crOf(supplierParty) },
    buyer: { name: nameOf(buyerParty), vatNumber: vatOf(buyerParty) },
    orderReference: text(child(root, 'OrderReference', 'ID')),
    billingReference: text(child(root, 'BillingReference', 'InvoiceDocumentReference', 'ID')),
    lines,
    subtotal: num(text(child(totals, 'TaxExclusiveAmount'))) ?? num(text(child(totals, 'LineExtensionAmount'))),
    taxTotal,
    total: num(text(child(totals, 'TaxInclusiveAmount'))) ?? num(text(child(totals, 'PayableAmount'))),
  };
}

/** Quick check before parsing: does this text look like a UBL document? */
export function looksLikeUbl(s: string): boolean {
  return /<(?:\w+:)?(Invoice|CreditNote|DebitNote)[\s>]/.test(s.slice(0, 4000)) && /urn:oasis:names:specification:ubl/.test(s.slice(0, 4000));
}

// ---------------------------------------------------------------------------
// Three-way match
// ---------------------------------------------------------------------------

export interface MatchPoLine {
  id: string;
  itemName: string;
  itemNameAr?: string | null;
  supplierName?: string | null;
  supplierSku?: string | null;
  packName?: string | null;
  qty: Decimal.Value;
  unitPrice: Decimal.Value;
  receivedQty: Decimal.Value;
  /** Average price recorded on the delivery receipts; null when nothing was received. */
  receivedUnitPrice?: Decimal.Value | null;
  /** Quantity already billed on other (not rejected) invoices for this order. */
  invoicedElsewhere?: Decimal.Value;
}

export interface MatchInvoiceLine {
  description: string;
  sku?: string | null;
  qty: Decimal.Value;
  unitPrice: Decimal.Value;
  lineTotal: Decimal.Value;
  taxRate?: Decimal.Value | null;
  /** Set by a person: this invoice line is that order line. */
  poLineId?: string | null;
}

export interface MatchTolerance {
  /** A price may be this fraction above the expected price (0.01 = 1%)… */
  pricePct: number;
  /** …or this many riyals per unit, whichever is larger. */
  priceAbs: number;
  /** Rounding allowed on totals, in riyals. */
  totalAbs: number;
}
export const DEFAULT_TOLERANCE: MatchTolerance = { pricePct: 0.01, priceAbs: 0.05, totalAbs: 1 };

export type DiscrepancyKind =
  | 'price_higher'
  | 'price_lower'
  | 'qty_not_received'
  | 'not_on_order'
  | 'not_invoiced'
  | 'line_total'
  | 'totals'
  | 'vat'
  | 'vat_rate'
  | 'duplicate'
  | 'supplier_vat'
  | 'no_order';

export interface Discrepancy {
  kind: DiscrepancyKind;
  lineIndex?: number;
  poLineId?: string;
  message: string;
  messageAr: string;
  /** Overcharge before VAT, in riyals ("0.00" when nothing to claim). */
  amount: string;
  /** Blocking discrepancies stop the invoice being approved as matched. */
  blocking: boolean;
}

export interface MatchedLine {
  index: number;
  poLineId: string | null;
  method: 'manual' | 'sku' | 'name' | null;
  expectedPrice: string | null;
  billableQty: string | null;
}

export interface MatchResult {
  status: 'matched' | 'mismatch' | 'no_order';
  lines: MatchedLine[];
  discrepancies: Discrepancy[];
  /** What to ask the supplier to credit. */
  claim: { subtotal: string; tax: string; total: string };
}

export interface MatchInput {
  type: InvoiceDocType;
  lines: MatchInvoiceLine[];
  subtotal: Decimal.Value | null;
  taxTotal: Decimal.Value | null;
  total: Decimal.Value | null;
  /** null: no purchase order linked. */
  po: { lines: MatchPoLine[]; taxRate: Decimal.Value } | null;
  expectedTaxRate?: Decimal.Value;
  tolerance?: MatchTolerance;
  /** Ref of an earlier invoice with the same supplier and number. */
  duplicateOf?: string | null;
  /** Currency of the amounts (for messages). Default SAR. */
  currency?: string | null;
  /** The VAT number on the invoice differs from the supplier's. */
  supplierVatMismatch?: { invoice: string; supplier: string } | null;
}

const D = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
const m2 = (v: Decimal.Value) => new Decimal(v).toFixed(2);
const q = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(3).toString();
/** Keep numbers and codes left-to-right inside Arabic text. */
const ltr = (v: string) => `⁦${v}⁩`;

function tokens(s: string | null | undefined): Set<string> {
  return new Set(normalizeName(s ?? '').split(' ').filter((t) => t.length > 1));
}
/** Same word, allowing plurals and short suffixes ("tomato" / "tomatoes", "breast" / "breasts"). */
const sameWord = (x: string, y: string) => x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)) && Math.abs(x.length - y.length) <= 2);
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const t of a) if ([...b].some((u) => sameWord(t, u))) common++;
  return common / Math.min(a.size, b.size);
}

/** Pair invoice lines with order lines: a person's choice, then the supplier's SKU, then the name. */
export function pairLines(inv: MatchInvoiceLine[], po: MatchPoLine[]): { poLineId: string | null; method: MatchedLine['method'] }[] {
  const out: { poLineId: string | null; method: MatchedLine['method'] }[] = inv.map(() => ({ poLineId: null, method: null }));
  const used = new Set<string>();
  inv.forEach((l, i) => {
    if (l.poLineId && po.some((p) => p.id === l.poLineId)) {
      out[i] = { poLineId: l.poLineId, method: 'manual' };
      used.add(l.poLineId);
    }
  });
  const skuKey = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
  inv.forEach((l, i) => {
    if (out[i]!.poLineId || !skuKey(l.sku)) return;
    const hit = po.find((p) => !used.has(p.id) && skuKey(p.supplierSku) === skuKey(l.sku));
    if (hit) {
      out[i] = { poLineId: hit.id, method: 'sku' };
      used.add(hit.id);
    }
  });
  // Names: best pairs first, so one good match isn't stolen by a weaker one.
  const candidates: { i: number; id: string; score: number }[] = [];
  inv.forEach((l, i) => {
    if (out[i]!.poLineId) return;
    const a = tokens(l.description);
    for (const p of po) {
      if (used.has(p.id)) continue;
      const score = Math.max(similarity(a, tokens(p.itemName)), similarity(a, tokens(p.itemNameAr)), similarity(a, tokens(p.supplierName)));
      if (score >= 0.5) candidates.push({ i, id: p.id, score });
    }
  });
  candidates.sort((x, y) => y.score - x.score);
  for (const c of candidates) {
    if (out[c.i]!.poLineId || used.has(c.id)) continue;
    out[c.i] = { poLineId: c.id, method: 'name' };
    used.add(c.id);
  }
  return out;
}

/**
 * Compare an invoice with its purchase order and the deliveries received.
 *
 * - Price: each line against the price recorded on receipt (or the order price), within tolerance.
 * - Quantity: billed against received, minus what other invoices already billed.
 * - Lines not on the order, line arithmetic, totals, VAT, duplicates and the supplier's VAT number.
 *
 * The claim is the overcharge before VAT plus VAT on it: what a credit note should cover.
 */
export function matchInvoice(input: MatchInput): MatchResult {
  const tol = input.tolerance ?? DEFAULT_TOLERANCE;
  const cur = (input.currency ?? 'SAR').toUpperCase();
  const curAr = currencyAr(cur);
  const vatRate = D(input.expectedTaxRate ?? input.po?.taxRate ?? '0.15');
  const out: Discrepancy[] = [];
  const add = (d: Omit<Discrepancy, 'amount'> & { amount?: Decimal.Value }) => out.push({ ...d, amount: m2(d.amount ?? 0) });

  // Arithmetic that holds whatever the order says.
  input.lines.forEach((l, i) => {
    const expected = D(l.qty).mul(D(l.unitPrice)).toDecimalPlaces(2);
    const diff = D(l.lineTotal).minus(expected);
    if (diff.abs().gt(0.05)) {
      add({
        kind: 'line_total',
        lineIndex: i,
        message: `Line ${i + 1} (${l.description}): ${q(l.qty)} × ${cur} ${m2(l.unitPrice)} is ${cur} ${m2(expected)}, but the line says ${cur} ${m2(l.lineTotal)}`,
        messageAr: `السطر ${i + 1} (${l.description}): ${ltr(q(l.qty))} × ${m2(l.unitPrice)} ${curAr} = ${m2(expected)} ${curAr}، لكن السطر يذكر ${m2(l.lineTotal)} ${curAr}`,
        amount: Decimal.max(diff, 0),
        blocking: true,
      });
    }
    if (l.taxRate !== null && l.taxRate !== undefined && !D(l.taxRate).eq(vatRate) && !D(l.taxRate).isZero()) {
      add({
        kind: 'vat_rate',
        lineIndex: i,
        message: `Line ${i + 1} charges VAT at ${D(l.taxRate).mul(100).toString()}% instead of ${vatRate.mul(100).toString()}%`,
        messageAr: `السطر ${i + 1} يحتسب الضريبة بنسبة ${ltr(`${D(l.taxRate).mul(100).toString()}%`)} بدل ${ltr(`${vatRate.mul(100).toString()}%`)}`,
        blocking: true,
      });
    }
  });
  const sumLines = input.lines.reduce((s, l) => s.plus(D(l.lineTotal)), new Decimal(0));
  if (input.subtotal !== null && sumLines.minus(D(input.subtotal)).abs().gt(tol.totalAbs)) {
    add({
      kind: 'totals',
      message: `The lines add up to ${cur} ${m2(sumLines)}, but the subtotal is ${cur} ${m2(input.subtotal)}`,
      messageAr: `مجموع الأسطر ${m2(sumLines)} ${curAr}، لكن المجموع قبل الضريبة ${m2(input.subtotal)} ${curAr}`,
      amount: Decimal.max(D(input.subtotal).minus(sumLines), 0),
      blocking: true,
    });
  }
  const base = D(input.subtotal ?? sumLines);
  if (input.taxTotal !== null) {
    const expectedTax = base.mul(vatRate).toDecimalPlaces(2);
    const diff = D(input.taxTotal).minus(expectedTax);
    if (diff.abs().gt(tol.totalAbs)) {
      add({
        kind: 'vat',
        message: `VAT is ${cur} ${m2(input.taxTotal)}; ${vatRate.mul(100).toString()}% of ${cur} ${m2(base)} is ${cur} ${m2(expectedTax)}`,
        messageAr: `الضريبة ${m2(input.taxTotal)} ${curAr}؛ و${ltr(`${vatRate.mul(100).toString()}%`)} من ${m2(base)} ${curAr} = ${m2(expectedTax)} ${curAr}`,
        blocking: true,
      });
    }
    if (input.total !== null && base.plus(D(input.taxTotal)).minus(D(input.total)).abs().gt(tol.totalAbs)) {
      add({
        kind: 'totals',
        message: `Subtotal ${cur} ${m2(base)} plus VAT ${cur} ${m2(input.taxTotal)} is not the total of ${cur} ${m2(input.total)}`,
        messageAr: `المجموع ${m2(base)} ${curAr} مع الضريبة ${m2(input.taxTotal)} ${curAr} لا يساوي الإجمالي ${m2(input.total)} ${curAr}`,
        amount: Decimal.max(D(input.total).minus(base.plus(D(input.taxTotal))), 0),
        blocking: true,
      });
    }
  }
  if (input.duplicateOf) {
    add({
      kind: 'duplicate',
      message: `This supplier already sent an invoice with this number (${input.duplicateOf})`,
      messageAr: `أرسل هذا المورد فاتورة بنفس الرقم من قبل (${ltr(input.duplicateOf)})`,
      blocking: true,
    });
  }
  if (input.supplierVatMismatch) {
    add({
      kind: 'supplier_vat',
      message: `The VAT number on the invoice (${input.supplierVatMismatch.invoice}) is not the supplier's (${input.supplierVatMismatch.supplier})`,
      messageAr: `الرقم الضريبي في الفاتورة (${ltr(input.supplierVatMismatch.invoice)}) ليس رقم المورد (${ltr(input.supplierVatMismatch.supplier)})`,
      blocking: true,
    });
  }

  const lines: MatchedLine[] = input.lines.map((_, i) => ({ index: i, poLineId: null, method: null, expectedPrice: null, billableQty: null }));

  // Credit and debit notes correct an earlier invoice; they are not matched against deliveries.
  if (input.type !== 'invoice') return finish('matched');

  if (!input.po) {
    add({ kind: 'no_order', message: 'No purchase order is linked to this invoice', messageAr: 'لا يوجد أمر شراء مرتبط بهذه الفاتورة', blocking: true });
    return finish('no_order');
  }

  const poById = new Map(input.po.lines.map((p) => [p.id, p]));
  const pairs = pairLines(input.lines, input.po.lines);
  const billedByPoLine = new Map<string, Decimal>();
  input.lines.forEach((l, i) => {
    const pair = pairs[i]!;
    const p = pair.poLineId ? poById.get(pair.poLineId) : undefined;
    if (!p) {
      add({
        kind: 'not_on_order',
        lineIndex: i,
        message: `“${l.description}” (${cur} ${m2(l.lineTotal)}) is not on the order`,
        messageAr: `«${l.description}» (${m2(l.lineTotal)} ${curAr}) ليس في الطلب`,
        amount: l.lineTotal,
        blocking: true,
      });
      return;
    }
    const expected = D(p.receivedUnitPrice ?? p.unitPrice);
    const billable = Decimal.max(D(p.receivedQty).minus(D(p.invoicedElsewhere)).minus(billedByPoLine.get(p.id) ?? 0), 0);
    billedByPoLine.set(p.id, (billedByPoLine.get(p.id) ?? new Decimal(0)).plus(D(l.qty)));
    lines[i] = { index: i, poLineId: p.id, method: pair.method, expectedPrice: expected.toFixed(4), billableQty: q(billable) };

    const price = D(l.unitPrice);
    const allowed = Decimal.max(expected.mul(tol.pricePct), tol.priceAbs);
    const qty = D(l.qty);
    if (price.minus(expected).gt(allowed)) {
      // Units not received are claimed in full below, so the price claim covers only received units.
      const units = Decimal.min(qty, billable);
      add({
        kind: 'price_higher',
        lineIndex: i,
        poLineId: p.id,
        message: `${p.itemName}: billed at ${cur} ${m2(price)}, agreed ${cur} ${m2(expected)} (${q(units)} × ${cur} ${m2(price.minus(expected))} over)`,
        messageAr: `${p.itemNameAr ?? p.itemName}: السعر في الفاتورة ${m2(price)} ${curAr}، والمتفق عليه ${m2(expected)} ${curAr} (زيادة ${m2(price.minus(expected))} ${curAr} × ${ltr(q(units))})`,
        amount: price.minus(expected).mul(units),
        blocking: true,
      });
    } else if (expected.minus(price).gt(allowed)) {
      add({
        kind: 'price_lower',
        lineIndex: i,
        poLineId: p.id,
        message: `${p.itemName}: billed at ${cur} ${m2(price)}, below the agreed ${cur} ${m2(expected)}`,
        messageAr: `${p.itemNameAr ?? p.itemName}: السعر في الفاتورة ${m2(price)} ${curAr}، أقل من المتفق عليه ${m2(expected)} ${curAr}`,
        blocking: false,
      });
    }
    if (qty.minus(billable).gt(0.0005)) {
      const extra = qty.minus(billable);
      const received = D(p.receivedQty);
      add({
        kind: 'qty_not_received',
        lineIndex: i,
        poLineId: p.id,
        message: received.isZero()
          ? `${p.itemName}: ${q(qty)} billed, but nothing has been received`
          : `${p.itemName}: ${q(qty)} billed, but only ${q(billable)} received and not yet billed`,
        messageAr: received.isZero()
          ? `${p.itemNameAr ?? p.itemName}: الفاتورة تشمل ${ltr(q(qty))} ولم يُستلم شيء`
          : `${p.itemNameAr ?? p.itemName}: الفاتورة تشمل ${ltr(q(qty))} والمستلم غير المفوتر ${ltr(q(billable))} فقط`,
        amount: extra.mul(price),
        blocking: true,
      });
    }
  });

  // Received but not billed: fine (a later invoice may cover it), but worth showing.
  for (const p of input.po.lines) {
    const open = D(p.receivedQty).minus(D(p.invoicedElsewhere)).minus(billedByPoLine.get(p.id) ?? 0);
    if (open.gt(0.0005)) {
      add({
        kind: 'not_invoiced',
        poLineId: p.id,
        message: `${p.itemName}: ${q(open)} received but not on this invoice`,
        messageAr: `${p.itemNameAr ?? p.itemName}: ${ltr(q(open))} مستلمة وليست في هذه الفاتورة`,
        blocking: false,
      });
    }
  }
  return finish(out.some((d) => d.blocking) ? 'mismatch' : 'matched');

  function finish(status: MatchResult['status']): MatchResult {
    const final = status === 'matched' && out.some((d) => d.blocking) ? 'mismatch' : status;
    const claimKinds: DiscrepancyKind[] = ['price_higher', 'qty_not_received', 'not_on_order', 'line_total', 'totals'];
    const subtotal = out.filter((d) => claimKinds.includes(d.kind)).reduce((s, d) => s.plus(d.amount), new Decimal(0));
    let tax = subtotal.mul(vatRate).toDecimalPlaces(2);
    // VAT overcharged on its own (wrong rate or arithmetic) is claimed as tax.
    const vat = out.find((d) => d.kind === 'vat');
    if (vat && input.taxTotal !== null) {
      const over = D(input.taxTotal).minus(base.mul(vatRate).toDecimalPlaces(2));
      if (over.gt(0)) tax = tax.plus(over);
    }
    return { status: final, lines, discrepancies: out, claim: { subtotal: m2(subtotal), tax: m2(tax), total: m2(subtotal.plus(tax)) } };
  }
}
