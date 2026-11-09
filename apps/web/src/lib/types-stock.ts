/* Waste and transfers (Phase 4). */

export type WasteReason = 'expired' | 'spoiled' | 'damaged' | 'overproduction' | 'prep_trim' | 'dropped' | 'returned' | 'staff_meal' | 'other';
export const WASTE_REASONS: WasteReason[] = ['expired', 'spoiled', 'damaged', 'overproduction', 'prep_trim', 'dropped', 'returned', 'staff_meal', 'other'];

export interface StockItem {
  id: string;
  name: string;
  nameAr: string | null;
  code: string | null;
  baseUnit: string;
  packs: { id: string; name: string; nameAr: string | null; isCountable: boolean }[];
}

export interface WasteEntry {
  id: string;
  siteId: string;
  siteName: string;
  siteNameAr: string | null;
  itemId: string;
  itemName: string;
  itemNameAr: string | null;
  baseUnit: string;
  qtyBase: string;
  entryQty: string;
  entryUnit: string | null;
  entryPackId: string | null;
  entryText: string | null;
  reason: WasteReason;
  note: string | null;
  value?: string;
  recordedBy: string | null;
  recordedByName: string | null;
  recordedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface WasteSummary {
  total?: string;
  entries: number;
  byReason: { reason: WasteReason; entries: number; value?: string }[];
  topItems: { itemId: string; name: string; nameAr: string | null; baseUnit: string; qtyBase: string; entries: number; value?: string }[];
}

export interface ParsedWaste {
  raw: string;
  itemId: string | null;
  itemName: string | null;
  itemNameAr: string | null;
  packName: string | null;
  packNameAr: string | null;
  candidateNames: { id: string; name?: string; nameAr?: string | null }[];
  qty: string | null;
  unit: string | null;
  reason: WasteReason | null;
  problem: 'no_qty' | 'no_item' | 'ambiguous_item' | 'no_unit' | null;
  recorded: boolean;
}

export type TransferStatus = 'draft' | 'sent' | 'received' | 'cancelled';

export interface TransferRow {
  id: string;
  ref: string;
  fromSiteId: string;
  toSiteId: string;
  fromName: string;
  fromNameAr: string | null;
  toName: string;
  toNameAr: string | null;
  status: TransferStatus;
  note: string | null;
  value?: string | null;
  shortValue?: string | null;
  createdAt: string;
  sentAt: string | null;
  receivedAt: string | null;
  lines?: number;
}

export interface TransferLine {
  id: string;
  itemId: string;
  name: string;
  nameAr: string | null;
  code: string | null;
  baseUnit: string;
  qtyBase: string;
  entryQty: string;
  entryUnit: string | null;
  entryPackId: string | null;
  receivedQty: string | null;
  unitCost?: string | null;
  packs: { id: string; name: string; nameAr: string | null; baseQty: string }[];
}

export interface TransferDetail extends Omit<TransferRow, 'lines'> {
  canSend: boolean;
  canReceive: boolean;
  lines: TransferLine[];
}
