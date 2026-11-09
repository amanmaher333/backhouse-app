export type PoStatus = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'partially_received' | 'received' | 'closed' | 'cancelled';

export interface PoRow {
  id: string;
  number: string;
  status: PoStatus;
  siteId: string;
  siteName: string;
  siteNameAr: string | null;
  relationshipId: string;
  supplierName: string;
  supplierNameAr: string | null;
  deliveryDate: string | null;
  total: string;
  source: string;
  approvalReason: string | null;
  createdAt: string;
  lineCount: number;
}

export interface PoLine {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  itemNameAr: string | null;
  baseUnit: string;
  packId: string;
  packName: string;
  packNameAr: string | null;
  packBaseQty: string;
  supplierItemId: string | null;
  supplierSku: string | null;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  receivedQty: string;
}

export interface PoDetail {
  id: string;
  currency: string;
  number: string;
  status: PoStatus;
  siteId: string;
  relationshipId: string;
  deliveryDate: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  taxRate: string;
  notes: string | null;
  source: string;
  agentTaskId: string | null;
  approvalReason: string | null;
  createdBy: string | null;
  sentAt: string | null;
  sentVia: string | null;
  supplierConfirmedAt: string | null;
  supplierConfirmedVia: 'whatsapp' | 'link' | null;
  supplierIssue: string | null;
  supplierIssueAt: string | null;
  conversation: { id: string; dir: 'to_supplier' | 'from_supplier'; kind: string; status: string | null; text: string; at: string }[];
  createdAt: string;
  site: { id: string; name: string; nameAr: string | null };
  supplier: { id: string; name: string; nameAr: string | null; orderChannel: string; contactEmail: string | null; contactPhone: string | null; minOrderValue: string | null };
  lines: PoLine[];
  receipts: { id: string; number: string; receivedAt: string; documentNo: string | null; total: string }[];
}

export interface StockRow {
  itemId: string;
  code: string;
  name: string;
  nameAr: string | null;
  category: string;
  baseUnit: 'g' | 'ml' | 'each';
  qtyOnHand: string;
  avgCost?: string | null;
  value?: string;
  lastMovementAt: string | null;
  parLevel: string | null;
  reorderPoint: string | null;
  status: 'low' | 'ok' | 'no_par';
}
