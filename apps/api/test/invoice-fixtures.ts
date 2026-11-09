/** Shared fixtures for supplier invoice tests. */

/** A valid-looking KSA VAT number (15 digits, starts and ends with 3), unique per test. */
export const vat = () => `3${String(Math.floor(Math.random() * 1e13)).padStart(13, '0')}3`;

export interface UblLine { name: string; sku?: string; qty: number; price: number; vatPct?: number }
/** A ZATCA-style UBL invoice with totals computed from the lines (unless overridden). */
export function ubl(p: { number: string; supplierVat: string; po?: string; lines: UblLine[]; type?: '388' | '381'; billingRef?: string; taxOverride?: number }) {
  const sub = p.lines.reduce((s, l) => s + l.qty * l.price, 0);
  const tax = p.taxOverride ?? Math.round(sub * 15) / 100;
  const lines = p.lines
    .map(
      (l, i) => `<cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">${l.qty}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="SAR">${(l.qty * l.price).toFixed(2)}</cbc:LineExtensionAmount>
      <cac:Item><cbc:Name>${l.name}</cbc:Name>${l.sku ? `<cac:SellersItemIdentification><cbc:ID>${l.sku}</cbc:ID></cac:SellersItemIdentification>` : ''}
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${l.vatPct ?? 15}</cbc:Percent></cac:ClassifiedTaxCategory></cac:Item>
      <cac:Price><cbc:PriceAmount currencyID="SAR">${l.price.toFixed(2)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>${p.number}</cbc:ID><cbc:UUID>${crypto.randomUUID()}</cbc:UUID><cbc:IssueDate>2026-11-08</cbc:IssueDate>
  <cbc:InvoiceTypeCode name="0100000">${p.type ?? '388'}</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  ${p.billingRef ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${p.billingRef}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}
  ${p.po ? `<cac:OrderReference><cbc:ID>${p.po}</cbc:ID></cac:OrderReference>` : ''}
  <cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme><cbc:CompanyID>${p.supplierVat}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>شركة الوفرة</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="SAR">${tax.toFixed(2)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="SAR">${sub.toFixed(2)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="SAR">${(sub + tax).toFixed(2)}</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal>
  ${lines}
</Invoice>`;
}
