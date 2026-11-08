import { sql } from 'drizzle-orm';
import type { ItemConversion } from '@boh/domain';
import {
  bigserial,
  boolean,
  check,
  numeric,
  primaryKey,
  smallint,
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

/* =====================================================================
 * Phase 1: catalogue, shared ingredient map, suppliers, prices
 * ===================================================================== */


/** Per-org counters for human-friendly codes (ITM-00001). */
export const orgCounters = pgTable(
  'org_counters',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: integer('value').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })],
);

/**
 * Shared ingredient map (global, curated by BOH). Every tenant item and supplier
 * item points here; it powers matching, onboarding and benchmarks.
 */
export const canonicalIngredients = pgTable('canonical_ingredients', {
  id: id(),
  slug: text('slug').notNull().unique(),
  nameEn: text('name_en').notNull(),
  nameAr: text('name_ar').notNull(),
  category: text('category').notNull(),
  baseUnit: text('base_unit').notNull(),
  densityGPerMl: numeric('density_g_per_ml', { precision: 10, scale: 4 }),
  eachWeightG: numeric('each_weight_g', { precision: 10, scale: 2 }),
  allergens: text('allergens').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Names that point at a canonical ingredient. Seed aliases come from BOH;
 * learned aliases come from people confirming matches and only count once
 * confirmed by at least 2 different organisations (so one tenant can't poison the map).
 */
export const canonicalAliases = pgTable(
  'canonical_aliases',
  {
    id: id(),
    canonicalId: uuid('canonical_id')
      .notNull()
      .references(() => canonicalIngredients.id, { onDelete: 'cascade' }),
    aliasNorm: text('alias_norm').notNull(),
    source: text('source').notNull().default('seed'),
    orgConfirmations: integer('org_confirmations').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('canonical_aliases_uq').on(t.canonicalId, t.aliasNorm)],
);

export const aliasConfirmations = pgTable(
  'alias_confirmations',
  {
    aliasId: uuid('alias_id')
      .notNull()
      .references(() => canonicalAliases.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.aliasId, t.orgId] })],
);

export const matchSource = pgEnum('match_source', ['auto', 'human']);

export const items = pgTable(
  'items',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    nameNorm: text('name_norm').notNull(),
    category: text('category').notNull().default('other'),
    baseUnit: text('base_unit').notNull(),
    canonicalId: uuid('canonical_id').references(() => canonicalIngredients.id),
    canonicalScore: numeric('canonical_score', { precision: 5, scale: 4 }),
    canonicalSource: matchSource('canonical_source'),
    allergens: text('allergens').array().notNull().default(sql`'{}'::text[]`),
    conversions: jsonb('conversions').$type<ItemConversion[]>().notNull().default([]),
    isStockable: boolean('is_stockable').notNull().default(true),
    trackLots: boolean('track_lots').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('items_org_id_id_uq').on(t.orgId, t.id),
    unique('items_org_code_uq').on(t.orgId, t.code),
    uniqueIndex('items_org_name_uq').on(t.orgId, sql`lower(${t.name})`),
    index('items_org_category_idx').on(t.orgId, t.category),
    index('items_canonical_idx').on(t.canonicalId),
    check('items_base_unit_chk', sql`${t.baseUnit} in ('g','ml','each')`),
  ],
);

/** Packs nest: a pack holds qty of a unit, or qty of another pack. base_qty is resolved on write. */
export const packs = pgTable(
  'packs',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    itemId: uuid('item_id').notNull(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    qty: numeric('qty', { precision: 14, scale: 4 }).notNull(),
    unit: text('unit'),
    parentPackId: uuid('parent_pack_id'),
    baseQty: numeric('base_qty', { precision: 18, scale: 6 }).notNull(),
    barcode: text('barcode'),
    isOrderable: boolean('is_orderable').notNull().default(true),
    isCountable: boolean('is_countable').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('packs_org_id_id_uq').on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }).onDelete('cascade'),
    index('packs_item_idx').on(t.itemId),
    uniqueIndex('packs_org_barcode_uq').on(t.orgId, t.barcode),
    check('packs_one_ref_chk', sql`(${t.unit} is null) <> (${t.parentPackId} is null)`),
  ],
);

/** Per-site settings for an item: par level and reorder point, in base units. */
export const itemSiteSettings = pgTable(
  'item_site_settings',
  {
    orgId: uuid('org_id').notNull(),
    itemId: uuid('item_id').notNull(),
    siteId: uuid('site_id').notNull(),
    parLevel: numeric('par_level', { precision: 18, scale: 6 }),
    reorderPoint: numeric('reorder_point', { precision: 18, scale: 6 }),
    isStocked: boolean('is_stocked').notNull().default(true),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.siteId] }),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.siteId], foreignColumns: [sites.orgId, sites.id] }).onDelete('cascade'),
  ],
);

/**
 * A supplier as a business, shared across BOH. Created "unclaimed" by the first
 * restaurant that adds it; the supplier can later claim it as their own org.
 * Deduplicated by VAT number.
 */
export const supplierProfiles = pgTable(
  'supplier_profiles',
  {
    id: id(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    country: text('country').notNull().default('SA'),
    vatNumber: text('vat_number'),
    crNumber: text('cr_number'),
    claimedOrgId: uuid('claimed_org_id').references(() => organizations.id),
    createdByOrgId: uuid('created_by_org_id').references(() => organizations.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('supplier_profiles_vat_uq').on(t.country, t.vatNumber)],
);

export const orderChannel = pgEnum('order_channel', ['email', 'whatsapp', 'portal', 'manual']);

/** A restaurant org's trading relationship with a supplier (the tenant-owned "supplier" record). */
export const tradingRelationships = pgTable(
  'trading_relationships',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    supplierProfileId: uuid('supplier_profile_id')
      .notNull()
      .references(() => supplierProfiles.id),
    displayName: text('display_name').notNull(),
    displayNameAr: text('display_name_ar'),
    orderChannel: orderChannel('order_channel').notNull().default('email'),
    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    accountNumber: text('account_number'),
    currency: text('currency').notNull().default('SAR'),
    taxRate: numeric('tax_rate', { precision: 6, scale: 4 }).notNull().default('0.15'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    minOrderValue: numeric('min_order_value', { precision: 14, scale: 2 }),
    deliveryFee: numeric('delivery_fee', { precision: 14, scale: 2 }),
    hidePricesOnPo: boolean('hide_prices_on_po').notNull().default(false),
    invoiceSenderWhitelist: text('invoice_sender_whitelist').array().notNull().default(sql`'{}'::text[]`),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('trading_relationships_org_id_id_uq').on(t.orgId, t.id),
    unique('trading_relationships_org_profile_uq').on(t.orgId, t.supplierProfileId),
  ],
);

export const supplierSiteSettings = pgTable(
  'supplier_site_settings',
  {
    orgId: uuid('org_id').notNull(),
    relationshipId: uuid('relationship_id').notNull(),
    siteId: uuid('site_id').notNull(),
    /** 0 = Sunday … 6 = Saturday */
    deliveryDays: smallint('delivery_days').array().notNull().default(sql`'{}'::smallint[]`),
    cutoffTime: text('cutoff_time'),
    leadTimeDays: integer('lead_time_days').notNull().default(1),
    accountNumber: text('account_number'),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.relationshipId, t.siteId] }),
    foreignKey({ columns: [t.orgId, t.relationshipId], foreignColumns: [tradingRelationships.orgId, tradingRelationships.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.siteId], foreignColumns: [sites.orgId, sites.id] }).onDelete('cascade'),
  ],
);

/** One orderable line from a supplier: their SKU for one of our item's packs. */
export const supplierItems = pgTable(
  'supplier_items',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    relationshipId: uuid('relationship_id').notNull(),
    itemId: uuid('item_id').notNull(),
    packId: uuid('pack_id').notNull(),
    supplierSku: text('supplier_sku'),
    supplierName: text('supplier_name'),
    supplierNameNorm: text('supplier_name_norm'),
    currentPrice: numeric('current_price', { precision: 14, scale: 4 }).notNull(),
    currency: text('currency').notNull().default('SAR'),
    priceUpdatedAt: timestamp('price_updated_at', { withTimezone: true }).notNull().defaultNow(),
    isPreferred: boolean('is_preferred').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('supplier_items_org_id_id_uq').on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.relationshipId], foreignColumns: [tradingRelationships.orgId, tradingRelationships.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.packId], foreignColumns: [packs.orgId, packs.id] }),
    uniqueIndex('supplier_items_sku_uq').on(t.relationshipId, t.supplierSku),
    uniqueIndex('supplier_items_pack_uq').on(t.relationshipId, t.packId),
    index('supplier_items_item_idx').on(t.itemId),
    check('supplier_items_price_chk', sql`${t.currentPrice} >= 0`),
  ],
);

export const priceSource = pgEnum('price_source', ['manual', 'import', 'invoice', 'supplier']);

/** Append-only price history. site_id set = site-specific override. */
export const supplierItemPrices = pgTable(
  'supplier_item_prices',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').notNull(),
    supplierItemId: uuid('supplier_item_id').notNull(),
    siteId: uuid('site_id'),
    price: numeric('price', { precision: 14, scale: 4 }).notNull(),
    previousPrice: numeric('previous_price', { precision: 14, scale: 4 }),
    currency: text('currency').notNull().default('SAR'),
    source: priceSource('source').notNull().default('manual'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.supplierItemId], foreignColumns: [supplierItems.orgId, supplierItems.id] }).onDelete('cascade'),
    index('supplier_item_prices_item_idx').on(t.supplierItemId, t.effectiveFrom),
    index('supplier_item_prices_org_time_idx').on(t.orgId, t.createdAt),
  ],
);

/** Human corrections of AI/automatic output: training data for the matching and extraction models. */
export const corrections = pgTable(
  'corrections',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').notNull(),
    kind: text('kind').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id'),
    input: jsonb('input'),
    modelOutput: jsonb('model_output'),
    humanOutput: jsonb('human_output'),
    userId: uuid('user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('corrections_org_kind_idx').on(t.orgId, t.kind)],
);
