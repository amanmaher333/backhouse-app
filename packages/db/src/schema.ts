import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Phase 0 schema: tenancy, org hierarchy, identity, roles, audit.
 *
 * Conventions
 * - Every tenant-owned row carries org_id; Postgres RLS (see the rls migration)
 *   restricts rows to the org set in `app.org_id` for the request.
 * - Child rows reference parents through (org_id, id) composite FKs so a row
 *   can never point at another tenant's parent.
 * - Arabic is a first-class name field (KSA-first launch).
 */

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const orgType = pgEnum('org_type', ['restaurant_group', 'supplier', 'platform']);
export const siteType = pgEnum('site_type', ['restaurant', 'central_kitchen', 'warehouse']);
export const roleScope = pgEnum('role_scope', ['org', 'site']);
export const actorType = pgEnum('actor_type', ['user', 'system', 'api', 'agent', 'integration']);

export const organizations = pgTable('organizations', {
  id: id(),
  type: orgType('type').notNull(),
  name: text('name').notNull(),
  nameAr: text('name_ar'),
  country: text('country').notNull().default('SA'),
  defaultCurrency: text('default_currency').notNull().default('SAR'),
  defaultLocale: text('default_locale').notNull().default('ar'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    fullName: text('full_name').notNull(),
    /** E.164, used later for WhatsApp identity. */
    phone: text('phone'),
    locale: text('locale').notNull().default('ar'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`), uniqueIndex('users_phone_uq').on(t.phone)],
);

/** KSA national address fields; generic enough for other GCC countries. */
export interface Address {
  buildingNumber?: string;
  street?: string;
  district?: string;
  city?: string;
  postalCode?: string;
  additionalNumber?: string;
  country?: string;
}

export const legalEntities = pgTable(
  'legal_entities',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    country: text('country').notNull().default('SA'),
    currency: text('currency').notNull().default('SAR'),
    vatNumber: text('vat_number'),
    crNumber: text('cr_number'),
    isVatRegistered: boolean('is_vat_registered').notNull().default(true),
    address: jsonb('address').$type<Address>().notNull().default({}),
    /** ZATCA / Peppol settings, filled in a later phase. */
    einvoicing: jsonb('einvoicing').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('legal_entities_org_id_id_uq').on(t.orgId, t.id), index('legal_entities_org_idx').on(t.orgId)],
);

export const brands = pgTable(
  'brands',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('brands_org_id_id_uq').on(t.orgId, t.id)],
);

export const sites = pgTable(
  'sites',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    legalEntityId: uuid('legal_entity_id').notNull(),
    brandId: uuid('brand_id'),
    type: siteType('type').notNull().default('restaurant'),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    code: text('code'),
    timezone: text('timezone').notNull().default('Asia/Riyadh'),
    address: jsonb('address').$type<Address>().notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('sites_org_id_id_uq').on(t.orgId, t.id),
    unique('sites_org_code_uq').on(t.orgId, t.code),
    foreignKey({ columns: [t.orgId, t.legalEntityId], foreignColumns: [legalEntities.orgId, legalEntities.id] }),
    foreignKey({ columns: [t.orgId, t.brandId], foreignColumns: [brands.orgId, brands.id] }),
  ],
);

export const storageLocations = pgTable(
  'storage_locations',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    siteId: uuid('site_id').notNull(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.siteId], foreignColumns: [sites.orgId, sites.id] }).onDelete('cascade'),
    index('storage_locations_site_idx').on(t.siteId),
  ],
);

export const costCentres = pgTable(
  'cost_centres',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id'),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    code: text('code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [foreignKey({ columns: [t.orgId, t.siteId], foreignColumns: [sites.orgId, sites.id] }).onDelete('cascade')],
);

/**
 * Roles. org_id NULL = built-in system role visible to all tenants.
 * permissions: list of "resource:action" strings, "*" wildcard allowed (e.g. "site:*").
 */
export const roles = pgTable(
  'roles',
  {
    id: id(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    scope: roleScope('scope').notNull(),
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_org_key_uq').on(sql`coalesce(${t.orgId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.key)],
);

/**
 * A user's role in an org. site_ids NULL = all sites (for site-scoped roles).
 * A user may hold several memberships (e.g. Manager at site A, Staff at site B).
 */
export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    siteIds: uuid('site_ids').array(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('memberships_org_user_role_uq').on(t.orgId, t.userId, t.roleId), index('memberships_user_idx').on(t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    siteIds: uuid('site_ids').array(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invitations_token_uq').on(t.tokenHash)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** Rotation family; reuse of a revoked token revokes the whole family. */
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash), index('refresh_tokens_family_idx').on(t.familyId)],
);

/** Append-only. UPDATE/DELETE are rejected by trigger (see rls migration). */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').notNull(),
    actorType: actorType('actor_type').notNull().default('user'),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    requestId: text('request_id'),
    ip: text('ip'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_org_time_idx').on(t.orgId, t.occurredAt),
    index('audit_events_entity_idx').on(t.orgId, t.entityType, t.entityId),
  ],
);
