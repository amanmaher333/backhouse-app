export interface Address {
  buildingNumber?: string;
  street?: string;
  district?: string;
  city?: string;
  postalCode?: string;
  additionalNumber?: string;
}
export interface LegalEntity {
  id: string;
  name: string;
  nameAr: string | null;
  country: string;
  currency: string;
  vatNumber: string | null;
  crNumber: string | null;
  isVatRegistered: boolean;
  address: Address;
}
export type SiteType = 'restaurant' | 'central_kitchen' | 'warehouse';
export interface Site {
  id: string;
  legalEntityId: string;
  brandId: string | null;
  type: SiteType;
  name: string;
  nameAr: string | null;
  code: string | null;
  timezone: string;
  address: Address;
  isActive: boolean;
}
export interface StorageLocation {
  id: string;
  siteId: string;
  name: string;
  nameAr: string | null;
  sortOrder: number;
}
export interface Role {
  id: string;
  orgId: string | null;
  key: string;
  name: string;
  nameAr: string | null;
  scope: 'org' | 'site';
  permissions: string[];
  isSystem: boolean;
}
export interface Member {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  scope: 'org' | 'site';
  siteIds: string[] | null;
}
export interface Invitation {
  id: string;
  email: string;
  roleId: string;
  siteIds: string[] | null;
  expiresAt: string;
  createdAt: string;
}
export interface AuditEvent {
  id: number;
  actorType: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
}
export interface Organization {
  id: string;
  type: string;
  name: string;
  nameAr: string | null;
  country: string;
  defaultCurrency: string;
  defaultLocale: string;
}

/* ---------- Phase 1: catalogue ---------- */
export interface Canonical {
  id: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  category: string;
  baseUnit: 'g' | 'ml' | 'each';
  allergens: string[];
}
export interface Candidate {
  canonicalId: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  category: string;
  baseUnit: 'g' | 'ml' | 'each';
  allergens: string[];
  score: number;
}
export interface MatchResult {
  input: string;
  normalized: string;
  candidates: Candidate[];
  auto: Candidate | null;
}
export interface ItemRow {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  category: string;
  baseUnit: 'g' | 'ml' | 'each';
  isActive: boolean;
  canonicalId: string | null;
  canonicalSource: 'auto' | 'human' | null;
  canonicalNameEn: string | null;
  canonicalNameAr: string | null;
  allergens: string[];
  packCount: number;
  supplierCount: number;
  bestCostPerBase?: string | null;
}
export interface Pack {
  id: string;
  itemId: string;
  name: string;
  nameAr: string | null;
  qty: string;
  unit: string | null;
  parentPackId: string | null;
  baseQty: string;
  barcode: string | null;
  isOrderable: boolean;
  isCountable: boolean;
}
export interface ItemSupplierLine {
  id: string;
  relationshipId: string;
  supplierName: string;
  supplierNameAr: string | null;
  packId: string;
  supplierSku: string | null;
  supplierItemName: string | null;
  currentPrice?: string;
  costPerBase?: string;
  priceUpdatedAt: string;
  isPreferred: boolean;
  isActive: boolean;
}
export interface ItemDetail {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  category: string;
  baseUnit: 'g' | 'ml' | 'each';
  isActive: boolean;
  isStockable: boolean;
  allergens: string[];
  canonicalId: string | null;
  canonicalSource: 'auto' | 'human' | null;
  canonicalScore: string | null;
  canonical: Canonical | null;
  conversions: { from: { qty: string | number; unit: string }; to: { qty: string | number; unit: string } }[];
  packs: Pack[];
  siteSettings: { siteId: string; parLevel: string | null; reorderPoint: string | null; isStocked: boolean }[];
  supplierItems: ItemSupplierLine[];
}
export type OrderChannel = 'email' | 'whatsapp' | 'portal' | 'manual';
export interface SupplierRow {
  id: string;
  displayName: string;
  displayNameAr: string | null;
  orderChannel: OrderChannel;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  paymentTermsDays: number;
  isActive: boolean;
  vatNumber: string | null;
  isClaimed: boolean;
  itemCount: number;
  lastPriceChange: string | null;
}
export interface SupplierLine {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  itemNameAr: string | null;
  baseUnit: 'g' | 'ml' | 'each';
  packId: string;
  packName: string;
  packNameAr: string | null;
  packBaseQty: string;
  supplierSku: string | null;
  supplierName: string | null;
  currentPrice?: string;
  previousPrice?: string | null;
  costPerBase?: string;
  changePct?: number | null;
  priceUpdatedAt: string;
  isPreferred: boolean;
  isActive: boolean;
}
export interface SupplierDetail {
  id: string;
  displayName: string;
  displayNameAr: string | null;
  orderChannel: OrderChannel;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  accountNumber: string | null;
  paymentTermsDays: number;
  minOrderValue: string | null;
  deliveryFee: string | null;
  taxRate: string;
  isActive: boolean;
  notes: string | null;
  profile: { vatNumber: string | null; crNumber: string | null; isClaimed: boolean } | null;
  schedule: { siteId: string; deliveryDays: number[]; cutoffTime: string | null; leadTimeDays: number }[];
  items: SupplierLine[];
}
export interface PriceChange {
  id: number;
  supplierItemId: string;
  price: string;
  previousPrice: string;
  source: string;
  at: string;
  itemId: string;
  itemName: string;
  itemNameAr: string | null;
  packName: string;
  packNameAr: string | null;
  supplierId: string;
  supplierName: string;
  supplierNameAr: string | null;
  changePct: number | null;
}
export interface PriceHistoryRow {
  id: number;
  price: string;
  previousPrice: string | null;
  source: string;
  siteId: string | null;
  effectiveFrom: string;
}
