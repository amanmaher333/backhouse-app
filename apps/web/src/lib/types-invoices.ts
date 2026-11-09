export type InvoiceStatus = 'needs_review' | 'matched' | 'mismatch' | 'approved' | 'disputed' | 'paid' | 'rejected';
export type InvoiceType = 'invoice' | 'credit_note' | 'debit_note';

export interface InvoiceRow {
  id: string;
  ref: string;
  type: InvoiceType;
  number: string | null;
  status: InvoiceStatus;
  issueDate: string | null;
  dueDate: string | null;
  total: string | null;
  claimTotal: string;
  source: 'upload' | 'email' | 'manual';
  extractedBy: 'xml' | 'claude' | 'manual' | 'none';
  reviewReasons: string[];
  relationshipId: string | null;
  supplierName: string | null;
  supplierNameAr: string | null;
  supplierNameOnInvoice: string | null;
  siteId: string | null;
  siteName: string | null;
  siteNameAr: string | null;
  poId: string | null;
  poNumber: string | null;
  createdAt: string;
}

export interface Discrepancy {
  kind: string;
  lineIndex?: number;
  poLineId?: string;
  message: string;
  messageAr: string;
  amount: string;
  blocking: boolean;
}

export interface MatchedLine {
  index: number;
  poLineId: string | null;
  method: 'manual' | 'sku' | 'name' | null;
  expectedPrice: string | null;
  billableQty: string | null;
}

export interface InvoiceLine {
  id: string;
  lineNo: number;
  description: string;
  supplierSku: string | null;
  qty: string;
  unit: string | null;
  unitPrice: string;
  lineTotal: string;
  taxRate: string | null;
  poLineId: string | null;
}

export interface PoMatchLine {
  id: string;
  itemName: string;
  itemNameAr: string | null;
  packName: string | null;
  supplierSku: string | null;
  qty: string;
  unitPrice: string;
  receivedQty: string;
  receivedUnitPrice: string | null;
  invoicedElsewhere: string;
}

export interface InvoiceDetail {
  id: string;
  ref: string;
  type: InvoiceType;
  status: InvoiceStatus;
  number: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currency: string;
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
  claimTotal: string;
  source: 'upload' | 'email' | 'manual';
  extractedBy: 'xml' | 'claude' | 'manual' | 'none';
  emailFrom: string | null;
  supplierNameOnInvoice: string | null;
  supplierVat: string | null;
  orderReference: string | null;
  reviewReasons: string[];
  relationshipId: string | null;
  siteId: string | null;
  poId: string | null;
  disputeMessage: string | null;
  disputedAt: string | null;
  approvedAt: string | null;
  approvedOverride: string | null;
  paidAt: string | null;
  paymentReference: string | null;
  rejectReason: string | null;
  createdAt: string;
  extraction: { note: string | null; confidence: string | null } | null;
  match: { status: string; lines: MatchedLine[]; discrepancies: Discrepancy[]; claim: { subtotal: string; tax: string; total: string } } | null;
  lines: InvoiceLine[];
  supplier: { id: string; name: string; nameAr: string | null; vatNumber: string | null; orderChannel: string; contactEmail: string | null; contactPhone: string | null; paymentTermsDays: number } | null;
  site: { id: string; name: string; nameAr: string | null } | null;
  po: { id: string; number: string; status: string; deliveryDate: string | null; total: string; lines: PoMatchLine[] } | null;
  candidates: { id: string; number: string; status: string; deliveryDate: string | null; total: string; siteName: string; siteNameAr: string | null; unbilled: string }[];
  document: { id: string; filename: string; contentType: string; size: number } | null;
  creditNotes: { id: string; ref: string; number: string | null; total: string | null; status: InvoiceStatus }[];
  corrects: { id: string; ref: string; number: string | null; total: string | null; status: InvoiceStatus } | null;
  can: { manage: boolean; approve: boolean; dispute: boolean; pay: boolean };
  duplicateUpload?: boolean;
}
