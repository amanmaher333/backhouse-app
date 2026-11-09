import { describe, expect, it } from 'vitest';
import { InvoiceParseError, looksLikeUbl, matchInvoice, pairLines, parseUblInvoice, type MatchPoLine } from './invoices.js';

/** A ZATCA phase 2 standard tax invoice, trimmed to the elements Backhouse reads (plus some it ignores). */
const ZATCA = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI></ext:UBLExtension></ext:UBLExtensions>
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>INV-2026-0042</cbc:ID>
  <cbc:UUID>3cf5ee18-ee25-44ea-a444-2c37ba7f28be</cbc:UUID>
  <cbc:IssueDate>2026-11-08</cbc:IssueDate>
  <cbc:IssueTime>10:15:00</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:OrderReference><cbc:ID>PO-00012</cbc:ID></cac:OrderReference>
  <cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>62</cbc:UUID></cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="CRN">1010010000</cbc:ID></cac:PartyIdentification>
    <cac:PartyTaxScheme><cbc:CompanyID>310175397400003</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>شركة الوفرة للأغذية</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyTaxScheme><cbc:CompanyID>310122393500003</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Najd Kitchens Co.</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="SAR">69.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="SAR">460.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="SAR">69.00</cbc:TaxAmount></cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:TaxTotal><cbc:TaxAmount currencyID="SAR">69.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">460.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">460.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">529.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="SAR">529.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">250.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>طماطم كرتون 6 كجم</cbc:Name><cac:SellersItemIdentification><cbc:ID>TOM-6</cbc:ID></cac:SellersItemIdentification>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15.00</cbc:Percent></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="SAR">25.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">3</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">210.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Olive oil 5L tin</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15</cbc:Percent></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="SAR">140.00</cbc:PriceAmount><cbc:BaseQuantity unitCode="PCE">2</cbc:BaseQuantity></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

describe('ZATCA / UBL e-invoices', () => {
  it('reads a standard tax invoice', () => {
    expect(looksLikeUbl(ZATCA)).toBe(true);
    const inv = parseUblInvoice(ZATCA);
    expect(inv).toMatchObject({
      type: 'invoice',
      number: 'INV-2026-0042',
      uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be',
      issueDate: '2026-11-08',
      currency: 'SAR',
      supplier: { name: 'شركة الوفرة للأغذية', vatNumber: '310175397400003', crNumber: '1010010000' },
      buyer: { vatNumber: '310122393500003' },
      orderReference: 'PO-00012',
      subtotal: '460',
      taxTotal: '69',
      total: '529',
    });
    expect(inv.lines).toEqual([
      { description: 'طماطم كرتون 6 كجم', sku: 'TOM-6', qty: '10', unit: 'PCE', unitPrice: '25', lineTotal: '250', taxRate: '0.15' },
      // Price 140 per base quantity of 2 → 70 each.
      { description: 'Olive oil 5L tin', sku: null, qty: '3', unit: 'PCE', unitPrice: '70', lineTotal: '210', taxRate: '0.15' },
    ]);
  });

  it('reads credit notes, in ZATCA form (381) and as a UBL CreditNote', () => {
    const zatcaCredit = ZATCA.replace('>388<', '>381<').replace(
      '<cac:OrderReference>',
      '<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-2026-0041</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference><cac:OrderReference>',
    );
    expect(parseUblInvoice(zatcaCredit)).toMatchObject({ type: 'credit_note', billingReference: 'INV-2026-0041' });

    const ubl = `<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
      <cbc:ID>CN-7</cbc:ID><cbc:IssueDate>2026-11-09</cbc:IssueDate>
      <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="SAR">20</cbc:TaxExclusiveAmount><cbc:PayableAmount currencyID="SAR">23</cbc:PayableAmount></cac:LegalMonetaryTotal>
      <cac:CreditNoteLine><cbc:ID>1</cbc:ID><cbc:CreditedQuantity unitCode="PCE">2</cbc:CreditedQuantity><cbc:LineExtensionAmount currencyID="SAR">20</cbc:LineExtensionAmount><cac:Item><cbc:Name>Tomato</cbc:Name></cac:Item><cac:Price><cbc:PriceAmount currencyID="SAR">10</cbc:PriceAmount></cac:Price></cac:CreditNoteLine>
    </CreditNote>`;
    const cn = parseUblInvoice(ubl);
    expect(cn).toMatchObject({ type: 'credit_note', number: 'CN-7', subtotal: '20', total: '23', currency: 'SAR' });
    expect(cn.lines[0]).toMatchObject({ description: 'Tomato', qty: '2', unitPrice: '10' });
  });

  it('rejects things that are not invoices', () => {
    expect(() => parseUblInvoice('<Order><ID>1</ID></Order>')).toThrow(InvoiceParseError);
    expect(() => parseUblInvoice('<Invoice><cbc:IssueDate>2026-01-01</cbc:IssueDate></Invoice>')).toThrow(/no number/);
    expect(looksLikeUbl('%PDF-1.7 ...')).toBe(false);
  });
});

const PO: MatchPoLine[] = [
  { id: 'l1', itemName: 'Tomatoes', itemNameAr: 'طماطم', supplierName: 'Tomato carton 6kg', supplierSku: 'TOM-6', packName: 'Carton 6kg', qty: 10, unitPrice: '25.0000', receivedQty: 10, receivedUnitPrice: '25.0000' },
  { id: 'l2', itemName: 'Olive oil', itemNameAr: 'زيت زيتون', supplierName: 'Olive oil tin 5L', supplierSku: null, packName: 'Tin 5L', qty: 4, unitPrice: '70.0000', receivedQty: 3, receivedUnitPrice: '70.0000' },
];
const line = (description: string, qty: number, unitPrice: number, sku: string | null = null) => ({ description, sku, qty, unitPrice, lineTotal: (qty * unitPrice).toFixed(2), taxRate: '0.15' });
const totals = (lines: { lineTotal: string }[]) => {
  const sub = lines.reduce((s, l) => s + Number(l.lineTotal), 0);
  return { subtotal: sub.toFixed(2), taxTotal: (sub * 0.15).toFixed(2), total: (sub * 1.15).toFixed(2) };
};

describe('three-way match', () => {
  it('pairs lines by SKU, then by name in either language', () => {
    const pairs = pairLines([line('طماطم كرتون 6 كجم', 1, 1, 'tom-6'), line('OLIVE OIL 5 LTR', 1, 1), line('Paper towels', 1, 1)], PO);
    expect(pairs).toEqual([
      { poLineId: 'l1', method: 'sku' },
      { poLineId: 'l2', method: 'name' },
      { poLineId: null, method: null },
    ]);
    // A person's pairing wins.
    expect(pairLines([{ ...line('Something else', 1, 1), poLineId: 'l2' }], PO)[0]).toEqual({ poLineId: 'l2', method: 'manual' });
  });

  it('matches an invoice that bills what was received at the agreed prices', () => {
    const lines = [line('Tomato carton', 10, 25, 'TOM-6'), line('Olive oil', 3, 70)];
    const r = matchInvoice({ type: 'invoice', lines, ...totals(lines), po: { lines: PO, taxRate: '0.15' } });
    expect(r.status).toBe('matched');
    expect(r.discrepancies.filter((d) => d.blocking)).toEqual([]);
    expect(r.claim).toEqual({ subtotal: '0.00', tax: '0.00', total: '0.00' });
    // One olive oil tin was ordered but is still to come: informational only.
    expect(r.lines.map((l) => l.poLineId)).toEqual(['l1', 'l2']);
  });

  it('allows small rounding within tolerance', () => {
    const lines = [line('Tomato carton', 10, 25.2, 'TOM-6')];
    const r = matchInvoice({ type: 'invoice', lines, ...totals(lines), po: { lines: PO, taxRate: '0.15' } });
    expect(r.discrepancies.find((d) => d.kind === 'price_higher')).toBeUndefined();
  });

  it('flags a higher price and claims the difference on received units, plus VAT', () => {
    const lines = [line('Tomato carton', 10, 27.5, 'TOM-6'), line('Olive oil', 3, 70)];
    const r = matchInvoice({ type: 'invoice', lines, ...totals(lines), po: { lines: PO, taxRate: '0.15' } });
    expect(r.status).toBe('mismatch');
    const d = r.discrepancies.find((x) => x.kind === 'price_higher')!;
    expect(d).toMatchObject({ lineIndex: 0, poLineId: 'l1', amount: '25.00', blocking: true });
    expect(d.messageAr).toContain('27.50');
    expect(r.claim).toEqual({ subtotal: '25.00', tax: '3.75', total: '28.75' });
  });

  it('flags billing for more than was received, net of earlier invoices', () => {
    const lines = [line('Olive oil', 4, 70)];
    const r = matchInvoice({ type: 'invoice', lines, ...totals(lines), po: { lines: PO, taxRate: '0.15' } });
    expect(r.discrepancies.find((x) => x.kind === 'qty_not_received')).toMatchObject({ amount: '70.00' });

    // Two tins were already billed on another invoice: only one is left to bill.
    const again = matchInvoice({ type: 'invoice', lines: [line('Olive oil', 3, 70)], ...totals([line('Olive oil', 3, 70)]), po: { lines: [PO[0]!, { ...PO[1]!, invoicedElsewhere: 2 }], taxRate: '0.15' } });
    expect(again.discrepancies.find((x) => x.kind === 'qty_not_received')).toMatchObject({ amount: '140.00' });
  });

  it('does not double-claim a higher price on units that never arrived', () => {
    const notReceived = [{ ...PO[0]!, receivedQty: 0, receivedUnitPrice: null }];
    const lines = [line('Tomato carton', 10, 30, 'TOM-6')];
    const r = matchInvoice({ type: 'invoice', lines, ...totals(lines), po: { lines: notReceived, taxRate: '0.15' } });
    expect(r.discrepancies.find((x) => x.kind === 'price_higher')!.amount).toBe('0.00');
    expect(r.discrepancies.find((x) => x.kind === 'qty_not_received')!.amount).toBe('300.00');
    expect(r.claim.subtotal).toBe('300.00');
  });

  it('flags lines not on the order, bad arithmetic and wrong VAT', () => {
    const lines = [line('Tomato carton', 10, 25, 'TOM-6'), line('Delivery surcharge', 1, 40), { ...line('Olive oil', 3, 70), lineTotal: '230.00' }];
    const sub = '520.00';
    const r = matchInvoice({ type: 'invoice', lines, subtotal: sub, taxTotal: '90.00', total: '610.00', po: { lines: PO, taxRate: '0.15' } });
    const kinds = r.discrepancies.filter((d) => d.blocking).map((d) => d.kind).sort();
    expect(kinds).toEqual(['line_total', 'not_on_order', 'vat']);
    // 40 not ordered + 20 arithmetic, VAT on those, plus 12 VAT overcharged (90 vs 78).
    expect(r.claim).toEqual({ subtotal: '60.00', tax: '21.00', total: '81.00' });
  });

  it('flags a VAT rate other than 15%', () => {
    const lines = [{ ...line('Tomato carton', 10, 25, 'TOM-6'), taxRate: '0.05' }];
    const r = matchInvoice({ type: 'invoice', lines, subtotal: '250', taxTotal: '37.50', total: '287.50', po: { lines: PO, taxRate: '0.15' } });
    expect(r.discrepancies.map((d) => d.kind)).toContain('vat_rate');
  });

  it('needs an order, and blocks duplicates and a wrong supplier VAT number', () => {
    const lines = [line('Tomato carton', 10, 25, 'TOM-6')];
    expect(matchInvoice({ type: 'invoice', lines, ...totals(lines), po: null }).status).toBe('no_order');
    const dup = matchInvoice({ type: 'invoice', lines, ...totals(lines), po: { lines: PO, taxRate: '0.15' }, duplicateOf: 'SI-00003' });
    expect(dup.status).toBe('mismatch');
    expect(dup.claim.total).toBe('0.00');
    const vat = matchInvoice({ type: 'invoice', lines, ...totals(lines), po: { lines: PO, taxRate: '0.15' }, supplierVatMismatch: { invoice: '300000000000003', supplier: '310175397400003' } });
    expect(vat.discrepancies.map((d) => d.kind)).toContain('supplier_vat');
  });

  it('checks only the arithmetic of credit notes', () => {
    const lines = [line('Tomato', 2, 10)];
    expect(matchInvoice({ type: 'credit_note', lines, ...totals(lines), po: null }).status).toBe('matched');
  });
});
