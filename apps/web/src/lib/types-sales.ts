export type SaleStatus = 'draft' | 'issued' | 'cleared' | 'reported' | 'rejected';
export type SaleKind = 'standard' | 'simplified';
export type SaleType = 'invoice' | 'credit_note' | 'debit_note';

export interface ZatcaUnit {
  id: string;
  legalEntityId: string;
  name: string;
  environment: 'sandbox' | 'simulation' | 'production';
  invoiceTypes: '1100' | '1000' | '0100';
  status: 'new' | 'onboarding' | 'active' | 'failed' | 'revoked';
  commonName: string;
  egsSerial: string;
  certSerial: string | null;
  certExpiresAt: string | null;
  icv: number;
  checks: { kind: string; type: string; status: string; errors: { code?: string; message?: string }[]; warnings: { code?: string; message?: string }[] }[] | null;
  lastError: string | null;
  activatedAt: string | null;
}

export interface Buyer {
  name: string;
  vatNumber?: string | null;
  idScheme?: string | null;
  idValue?: string | null;
  address?: { street: string; building: string; district: string; city: string; postalCode: string; additionalNumber?: string | null } | null;
}

export interface SaleRow {
  id: string;
  number: string;
  type: SaleType;
  kind: SaleKind;
  status: SaleStatus;
  issueDate: string | null;
  buyer: Buyer | null;
  total: string;
  zatcaStatus: string | null;
  lastError: string | null;
  legalEntityName: string;
  legalEntityNameAr: string | null;
  createdAt: string;
}

export interface SaleLine {
  id: string;
  lineNo: number;
  name: string;
  qty: string;
  unitPrice: string;
  discount: string;
  vatCategory: 'S' | 'Z' | 'E' | 'O';
  vatRate: string;
  exemptionCode: string | null;
  net: string;
  vat: string;
}

export interface SaleDetail extends SaleRow {
  legalEntityId: string;
  issueTime: string | null;
  supplyDate: string | null;
  currency: string;
  paymentMeansCode: string;
  note: string | null;
  reason: string | null;
  originalInvoiceId: string | null;
  billingReference: string | null;
  subtotal: string;
  taxTotal: string;
  icv: number | null;
  pih: string | null;
  hash: string | null;
  qr: string | null;
  validation: { status?: string; warningMessages?: { code?: string; message?: string }[]; errorMessages?: { code?: string; message?: string }[] } | null;
  submitAttempts: number;
  nextSubmitAt: string | null;
  issuedAt: string | null;
  hasXml: boolean;
  hasClearedXml: boolean;
  reportingOverdue: boolean;
  lines: SaleLine[];
  seller: { name: string; nameEn: string; vatNumber: string | null; id: { scheme: string; value: string } | null; address: { street: string; building: string; district: string; city: string; postalCode: string } | null } | null;
  unit: { id: string; name: string; environment: string } | null;
  notes: { id: string; number: string; type: SaleType; status: SaleStatus; total: string }[];
}
