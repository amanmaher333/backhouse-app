/* Stock counts (Phase 4). */

export type CountStatus = 'open' | 'submitted' | 'posted' | 'cancelled';

export interface CountRow {
  id: string;
  ref: string;
  siteId: string;
  siteName: string;
  siteNameAr: string | null;
  status: CountStatus;
  scope: 'full' | 'partial';
  blind: boolean;
  note: string | null;
  varianceValue?: string | null;
  absVarianceValue?: string | null;
  needsApproval: boolean;
  createdAt: string;
  submittedAt: string | null;
  postedAt: string | null;
  lines: number;
  counted: number;
}

export interface CountLine {
  id: string;
  itemId: string;
  code: string | null;
  name: string;
  nameAr: string | null;
  category: string | null;
  baseUnit: string;
  packs: { id: string; name: string; nameAr: string | null; baseQty: string }[];
  countedQty: string | null;
  entryQty: string | null;
  entryUnit: string | null;
  entryPackId: string | null;
  entryText: string | null;
  countedAt: string | null;
  countedByName: string | null;
  snapshotQty?: string;
  expectedQty?: string | null;
  adjustmentQty?: string | null;
  unitCost?: string | null;
  varianceValue?: string | null;
}

export interface CountDetail extends Omit<CountRow, 'lines' | 'counted'> {
  expectedVisible: boolean;
  canApprove: boolean;
  submittedBy: string | null;
  lines: CountLine[];
}

export interface ParsedEntry {
  raw: string;
  itemId: string | null;
  itemName: string | null;
  itemNameAr: string | null;
  packName: string | null;
  packNameAr: string | null;
  candidates: string[];
  candidateNames: { id: string; name?: string; nameAr?: string | null }[];
  qty: string | null;
  unit: string | null;
  packId: string | null;
  problem: 'no_qty' | 'no_item' | 'ambiguous_item' | 'no_unit' | null;
  recorded: boolean;
}
