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
