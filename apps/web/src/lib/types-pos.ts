/* POS integrations (Phase 5): Foodics. */

export interface PosConnection {
  id: string;
  provider: string;
  status: 'connected' | 'error' | 'disconnected';
  businessName: string;
  businessReference: string;
  currency: string | null;
  timezone: string | null;
  scopes: string[];
  pushPurchases: boolean;
  importFrom: string | null;
  catalogSyncedAt: string | null;
  ordersSyncedAt: string | null;
  lastError: string | null;
  connectedAt: string;
}

export type FoodicsStatus =
  | { provider: 'foodics'; mode: string; scopes: string[]; connected: false }
  | {
      provider: 'foodics';
      mode: string;
      scopes: string[];
      connected: true;
      connection: PosConnection;
      locations: { total: number; mapped: number };
      items: { total: number; mapped: number };
      products: number;
      orders: { imported: number; lastBusinessDate: string | null };
      pushes: Record<string, number>;
    };

export interface PosLocation {
  id: string;
  externalId: string;
  kind: 'branch' | 'warehouse';
  name: string;
  nameAr: string | null;
  reference: string | null;
  siteId: string | null;
  siteName: string | null;
  siteNameAr: string | null;
  mappedBy: 'auto' | 'human' | null;
}

export interface PosItem {
  id: string;
  externalId: string;
  sku: string | null;
  name: string;
  nameAr: string | null;
  storageUnit: string | null;
  ingredientUnit: string | null;
  storageFactor: string | null;
  itemId: string | null;
  itemName: string | null;
  itemNameAr: string | null;
  baseUnit: string | null;
  mappedBy: 'auto' | 'human' | null;
  manualFactor: string | null;
  storageInBase: string | null;
  suggestion: { itemId: string; name: string; nameAr: string | null; score: number } | null;
}

export interface PosProduct {
  id: string;
  sku: string | null;
  name: string;
  nameAr: string | null;
  category: string | null;
  price: string | null;
  isActive: boolean;
  soldQty: string;
  soldNet?: string;
  hasPosRecipe: boolean;
}

export interface PosSales {
  days: { date: string; location: string; locationName: string | null; locationNameAr: string | null; siteId: string | null; qty: string; net?: string }[];
  products: { productId: string; name: string | null; nameAr: string | null; qty: string; net?: string }[];
  total: { qty: string; net?: string };
}

export interface PosPush {
  id: string;
  status: 'pending' | 'pushed' | 'needs_mapping' | 'failed' | 'skipped';
  externalReference: string | null;
  error: string | null;
  attempts: number;
  grnNumber: string | null;
  siteName: string | null;
  siteNameAr: string | null;
  total?: string | null;
  receivedAt: string | null;
  updatedAt: string;
}
