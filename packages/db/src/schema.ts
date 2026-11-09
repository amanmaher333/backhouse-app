import { sql } from 'drizzle-orm';
import type { ItemConversion } from '@boh/domain';
import {
  bigint,
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
export const userKind = pgEnum('user_kind', ['human', 'agent']);

export const organizations = pgTable('organizations', {
  id: id(),
  type: orgType('type').notNull(),
  name: text('name').notNull(),
  nameAr: text('name_ar'),
  country: text('country').notNull().default('SA'),
  defaultCurrency: text('default_currency').notNull().default('SAR'),
  defaultLocale: text('default_locale').notNull().default('ar'),
  /** Org-wide preferences (e.g. whatsappApprovalMax). */
  settings: jsonb('settings').$type<OrgSettings>().notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface OrgSettings {
  /** Largest task value (SAR, incl. VAT) that can be approved from WhatsApp. Above it, the card links to Backhouse instead. */
  whatsappApprovalMax?: number;
}

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
    /** 'agent' users are agent identities: no password, cannot log in. */
    kind: userKind('kind').notNull().default('human'),
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
    /** Commercial register check: unverified, pending, verified, needs_review, rejected. */
    verificationStatus: text('verification_status').notNull().default('unverified'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** The name as registered (what the check found), for display and invoices. */
    registryName: text('registry_name'),
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
 * Shared ingredient map (global, curated by Backhouse). Every tenant item and supplier
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
 * Names that point at a canonical ingredient. Seed aliases come from Backhouse;
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
 * A supplier as a business, shared across Backhouse. Created "unclaimed" by the first
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


/* =====================================================================
 * Phase A: agent platform
 * ===================================================================== */

export type AutonomyLevel = 'suggest' | 'approve' | 'auto';

export const agentStatus = pgEnum('agent_status', ['active', 'paused']);

/** An agent hired by an org. Acts through its own user identity (users.kind = 'agent'). */
export const agents = pgTable(
  'agents',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    status: agentStatus('status').notNull().default('active'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Per action type: suggest | approve | auto. */
    autonomy: jsonb('autonomy').$type<Record<string, AutonomyLevel>>().notNull().default({}),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** Last event id this agent has processed. */
    eventCursor: bigint('event_cursor', { mode: 'number' }).notNull().default(0),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('agents_org_kind_uq').on(t.orgId, t.kind), unique('agents_org_id_id_uq').on(t.orgId, t.id)],
);

/** Append-only domain events (outbox). Emitted in the same transaction as the change. */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').notNull(),
    type: text('type').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    actorType: actorType('actor_type').notNull().default('user'),
    actorUserId: uuid('actor_user_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_org_id_idx').on(t.orgId, t.id), index('events_type_idx').on(t.type)],
);

export interface AgentAction {
  id: string;
  type: string;
  label: string;
  labelAr: string;
  params: Record<string, unknown>;
  /** Filled by the runtime: what the autonomy setting allows for this action. */
  autonomy?: AutonomyLevel;
}

export const agentTaskStatus = pgEnum('agent_task_status', ['proposed', 'approved', 'executed', 'failed', 'rejected', 'dismissed', 'expired']);

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    kind: text('kind').notNull(),
    /** Deduplication key: one open task per subject per agent. */
    subjectKey: text('subject_key').notNull(),
    status: agentTaskStatus('status').notNull().default('proposed'),
    priority: smallint('priority').notNull().default(2),
    title: text('title').notNull(),
    titleAr: text('title_ar').notNull(),
    summary: text('summary').notNull(),
    summaryAr: text('summary_ar').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    actions: jsonb('actions').$type<AgentAction[]>().notNull().default([]),
    chosenActionId: text('chosen_action_id'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    sourceEventId: bigint('source_event_id', { mode: 'number' }),
    /** How the text was written: 'claude' or 'template'. */
    writtenBy: text('written_by').notNull().default('template'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    /** Where the decision was made: 'web', 'whatsapp', 'api' (tokens/MCP) or 'auto'. */
    decidedVia: text('decided_via'),
    /** When people were notified on their channels (WhatsApp approval cards). NULL = not yet. */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete('cascade'),
    unique('agent_tasks_org_id_id_uq').on(t.orgId, t.id),
    index('agent_tasks_org_status_idx').on(t.orgId, t.status, t.createdAt),
    uniqueIndex('agent_tasks_open_subject_uq').on(t.orgId, t.agentId, t.subjectKey).where(sql`status in ('proposed','approved')`),
  ],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('running'),
    eventsProcessed: integer('events_processed').notNull().default(0),
    tasksCreated: integer('tasks_created').notNull().default(0),
    tasksUpdated: integer('tasks_updated').notNull().default(0),
    actionsExecuted: integer('actions_executed').notNull().default(0),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete('cascade'),
    index('agent_runs_agent_idx').on(t.agentId, t.startedAt),
  ],
);

/** Personal access tokens for API/MCP clients. Bound to one user in one org. */
export const accessTokens = pgTable(
  'access_tokens',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('access_tokens_hash_uq').on(t.tokenHash), index('access_tokens_user_idx').on(t.userId)],
);

/* =====================================================================
 * Phase 2: stock ledger, purchase orders, receiving, spend limits
 * ===================================================================== */

export const movementType = pgEnum('movement_type', [
  'opening',
  'receipt',
  'adjustment',
  'transfer_in',
  'transfer_out',
  'waste',
  'sale',
  'production_in',
  'production_out',
  'return',
]);

/** Append-only stock ledger. Quantities in the item's base unit; cost per base unit. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').notNull(),
    siteId: uuid('site_id').notNull(),
    itemId: uuid('item_id').notNull(),
    type: movementType('type').notNull(),
    qtyBase: numeric('qty_base', { precision: 18, scale: 6 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 18, scale: 8 }),
    totalCost: numeric('total_cost', { precision: 16, scale: 4 }),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    note: text('note'),
    actorType: actorType('actor_type').notNull().default('user'),
    createdBy: uuid('created_by'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.siteId], foreignColumns: [sites.orgId, sites.id] }),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }),
    index('stock_movements_site_item_idx').on(t.siteId, t.itemId, t.id),
  ],
);

/** Current stock and weighted average cost per site and item, maintained with every movement. */
export const stockBalances = pgTable(
  'stock_balances',
  {
    orgId: uuid('org_id').notNull(),
    siteId: uuid('site_id').notNull(),
    itemId: uuid('item_id').notNull(),
    qtyOnHand: numeric('qty_on_hand', { precision: 18, scale: 6 }).notNull().default('0'),
    avgCost: numeric('avg_cost', { precision: 18, scale: 8 }).notNull().default('0'),
    lastMovementAt: timestamp('last_movement_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.itemId] }),
    foreignKey({ columns: [t.orgId, t.siteId], foreignColumns: [sites.orgId, sites.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }).onDelete('cascade'),
  ],
);

export const poStatus = pgEnum('po_status', ['draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled']);

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    number: text('number').notNull(),
    siteId: uuid('site_id').notNull(),
    relationshipId: uuid('relationship_id').notNull(),
    status: poStatus('status').notNull().default('draft'),
    deliveryDate: text('delivery_date'),
    /** The supplier's answer: confirmed (WhatsApp button or order link), or a problem they reported. */
    supplierConfirmedAt: timestamp('supplier_confirmed_at', { withTimezone: true }),
    supplierConfirmedVia: text('supplier_confirmed_via'),
    supplierIssue: text('supplier_issue'),
    supplierIssueAt: timestamp('supplier_issue_at', { withTimezone: true }),
    currency: text('currency').notNull().default('SAR'),
    taxRate: numeric('tax_rate', { precision: 6, scale: 4 }).notNull().default('0.15'),
    subtotal: numeric('subtotal', { precision: 16, scale: 2 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 16, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 16, scale: 2 }).notNull().default('0'),
    notes: text('notes'),
    source: text('source').notNull().default('manual'),
    agentTaskId: uuid('agent_task_id'),
    approvalReason: text('approval_reason'),
    createdBy: uuid('created_by'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentVia: text('sent_via'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('purchase_orders_org_id_id_uq').on(t.orgId, t.id),
    unique('purchase_orders_org_number_uq').on(t.orgId, t.number),
    foreignKey({ columns: [t.orgId, t.siteId], foreignColumns: [sites.orgId, sites.id] }),
    foreignKey({ columns: [t.orgId, t.relationshipId], foreignColumns: [tradingRelationships.orgId, tradingRelationships.id] }),
    index('purchase_orders_org_status_idx').on(t.orgId, t.status),
    index('purchase_orders_site_idx').on(t.siteId, t.status),
  ],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    poId: uuid('po_id').notNull(),
    itemId: uuid('item_id').notNull(),
    packId: uuid('pack_id').notNull(),
    supplierItemId: uuid('supplier_item_id'),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }).notNull(),
    lineTotal: numeric('line_total', { precision: 16, scale: 2 }).notNull(),
    receivedQty: numeric('received_qty', { precision: 14, scale: 3 }).notNull().default('0'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.poId], foreignColumns: [purchaseOrders.orgId, purchaseOrders.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }),
    foreignKey({ columns: [t.orgId, t.packId], foreignColumns: [packs.orgId, packs.id] }),
    index('purchase_order_lines_po_idx').on(t.poId),
    check('po_lines_qty_chk', sql`${t.qty} > 0`),
  ],
);

/** Goods received note: one delivery against a PO. Posted receipts are immutable. */
export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    number: text('number').notNull(),
    poId: uuid('po_id').notNull(),
    siteId: uuid('site_id').notNull(),
    receivedBy: uuid('received_by'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    documentNo: text('document_no'),
    note: text('note'),
    total: numeric('total', { precision: 16, scale: 2 }).notNull().default('0'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('goods_receipts_org_id_id_uq').on(t.orgId, t.id),
    unique('goods_receipts_org_number_uq').on(t.orgId, t.number),
    foreignKey({ columns: [t.orgId, t.poId], foreignColumns: [purchaseOrders.orgId, purchaseOrders.id] }),
  ],
);

export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    receiptId: uuid('receipt_id').notNull(),
    poLineId: uuid('po_line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
    qtyBase: numeric('qty_base', { precision: 18, scale: 6 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }).notNull(),
    orderedUnitPrice: numeric('ordered_unit_price', { precision: 14, scale: 4 }).notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.receiptId], foreignColumns: [goodsReceipts.orgId, goodsReceipts.id] }).onDelete('cascade'),
    index('goods_receipt_lines_receipt_idx').on(t.receiptId),
  ],
);

/**
 * Spend limits. A PO needs approval (po:approve) if it exceeds any limit that applies:
 * per order, or the site's month-to-date spend. site_id / relationship_id NULL = any.
 */
export const spendLimits = pgTable('spend_limits', {
  id: id(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id'),
  relationshipId: uuid('relationship_id'),
  period: text('period').notNull(),
  amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------- Channels (Phase B): WhatsApp identities, approval cards, message log ----------

export const channelKind = pgEnum('channel_kind', ['whatsapp']);
export const outboundStatus = pgEnum('outbound_status', ['queued', 'sent', 'delivered', 'read', 'failed', 'simulated']);

/**
 * A person's verified address on a messaging channel. Belongs to the user, not an org:
 * one WhatsApp number serves every org the person belongs to. Verified by the person
 * sending a one-time code from that number (which proves they hold it).
 */
export const userChannels = pgTable(
  'user_channels',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: channelKind('channel').notNull(),
    /** E.164, e.g. +966501234567. */
    address: text('address').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    /** Last message from this person: WhatsApp lets businesses send free-form messages for 24 hours after it. */
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    approvalsEnabled: boolean('approvals_enabled').notNull().default(true),
    /** Daily digest: on/off, local hour (0-23) and time zone. */
    digestEnabled: boolean('digest_enabled').notNull().default(true),
    digestHour: smallint('digest_hour').notNull().default(8),
    timeZone: text('time_zone').notNull().default('Asia/Riyadh'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('user_channels_address_uq').on(t.channel, t.address), uniqueIndex('user_channels_user_uq').on(t.userId, t.channel)],
);

/** One-time codes a person sends from WhatsApp to link that number to their account. Only the hash is stored. */
export const channelLinkCodes = pgTable(
  'channel_link_codes',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: channelKind('channel').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('channel_link_codes_hash_uq').on(t.codeHash)],
);

/** Outbox and log of messages Backhouse sends. org_id is NULL for account messages (e.g. link confirmations). */
export const outboundMessages = pgTable(
  'outbound_messages',
  {
    id: id(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    /** NULL for replies to numbers not linked to anyone. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    channel: channelKind('channel').notNull(),
    toAddress: text('to_address').notNull(),
    /** 'approval_card', 'decision_reply', 'link_confirm', 'help', 'notice'. */
    kind: text('kind').notNull(),
    taskId: uuid('task_id'),
    /** Messages to suppliers: which supplier and order. */
    relationshipId: uuid('relationship_id'),
    poId: uuid('po_id'),
    /** Rendered content in both forms; the sender picks free-form or template by the 24-hour window. */
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    /** What was actually sent: 'interactive', 'text' or 'template'. */
    sentAs: text('sent_as'),
    status: outboundStatus('status').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('outbound_messages_provider_id_uq').on(t.providerMessageId),
    index('outbound_messages_queue_idx').on(t.status, t.nextAttemptAt),
    index('outbound_messages_org_idx').on(t.orgId, t.createdAt),
    index('outbound_messages_po_idx').on(t.poId),
  ],
);

/** Every webhook message received, deduplicated by the provider's message id (providers retry). */
export const inboundMessages = pgTable(
  'inbound_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channel: channelKind('channel').notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    fromAddress: text('from_address').notNull(),
    userId: uuid('user_id'),
    /** Set when the sender is a supplier replying about an order. */
    orgId: uuid('org_id'),
    relationshipId: uuid('relationship_id'),
    poId: uuid('po_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    outcome: text('outcome'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inbound_messages_provider_id_uq').on(t.channel, t.providerMessageId),
    index('inbound_messages_from_idx').on(t.fromAddress, t.receivedAt),
    index('inbound_messages_po_idx').on(t.poId),
  ],
);

/**
 * An approval card sent to one person for one task. Buttons carry the prompt id; a tap
 * is honoured only from that person's verified number, once, before it expires, and with
 * the person's permissions at the moment of the tap.
 */
export const approvalPrompts = pgTable(
  'approval_prompts',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull(),
    actionId: text('action_id').notNull(),
    /** False when the task is above the org's WhatsApp approval cap: the card can reject, or link to Backhouse. */
    canApprove: boolean('can_approve').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    decision: text('decision'),
    outcome: text('outcome'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.taskId], foreignColumns: [agentTasks.orgId, agentTasks.id] }).onDelete('cascade'),
    uniqueIndex('approval_prompts_task_user_uq').on(t.taskId, t.userId),
  ],
);

/** One row per person, org and local day a digest went out: makes the schedule idempotent across workers. */
export const digestRuns = pgTable(
  'digest_runs',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    localDate: text('local_date').notNull(),
    /** What the digest counted; empty days are recorded too (and nothing is sent). */
    counts: jsonb('counts').$type<Record<string, number>>().notNull(),
    outboundMessageId: uuid('outbound_message_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('digest_runs_user_org_date_uq').on(t.userId, t.orgId, t.localDate)],
);

/**
 * An order shared with a supplier: a private link (token, stored hashed) to view, confirm or
 * report a problem, and the WhatsApp number it was sent to (button taps must come from it).
 */
export const supplierOrderLinks = pgTable(
  'supplier_order_links',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    poId: uuid('po_id').notNull(),
    relationshipId: uuid('relationship_id').notNull(),
    toAddress: text('to_address'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** After "Problem", the supplier's next message is taken as the description, until this time. */
    awaitingNoteUntil: timestamp('awaiting_note_until', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('supplier_order_links_token_uq').on(t.tokenHash),
    index('supplier_order_links_to_idx').on(t.toAddress, t.createdAt),
    foreignKey({ columns: [t.orgId, t.poId], foreignColumns: [purchaseOrders.orgId, purchaseOrders.id] }).onDelete('cascade'),
  ],
);

// ---------- Billing ----------

export const subscriptionStatus = pgEnum('subscription_status', ['free', 'trialing', 'active', 'past_due', 'suspended', 'canceled', 'expired']);

/**
 * One subscription per organisation. Restaurants start on a trial; suppliers and the
 * platform org are free. "interval" set during a trial means "start paying when it ends".
 */
export const subscriptions = pgTable('subscriptions', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  plan: text('plan').notNull(),
  status: subscriptionStatus('status').notNull(),
  interval: text('interval'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  /** Saved card: provider token plus display details. The token only works with Backhouse's secret key. */
  paymentMethod: jsonb('payment_method').$type<{ provider: string; token: string; brand: string; last4: string; expMonth?: number; expYear?: number } | null>(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Backhouse's own tax invoices to its customers (simplified ZATCA phase-1 fields until the ZATCA integration). */
export const billingInvoices = pgTable(
  'billing_invoices',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    /** open (awaiting payment), paid, failed (payment declined; may be retried), void. */
    status: text('status').notNull().default('open'),
    interval: text('interval').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    lines: jsonb('lines').$type<Record<string, unknown>[]>().notNull(),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull(),
    vat: numeric('vat', { precision: 14, scale: 2 }).notNull(),
    total: numeric('total', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('SAR'),
    seller: jsonb('seller').$type<Record<string, unknown>>().notNull(),
    buyer: jsonb('buyer').$type<Record<string, unknown>>().notNull(),
    qr: text('qr').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    providerPaymentId: text('provider_payment_id'),
    attempts: integer('attempts').notNull().default(0),
    failureMessage: text('failure_message'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('billing_invoices_number_uq').on(t.number), uniqueIndex('billing_invoices_payment_uq').on(t.providerPaymentId), index('billing_invoices_org_idx').on(t.orgId, t.issuedAt)],
);

/** Payment provider webhooks, deduplicated by event id. */
export const billingEvents = pgTable(
  'billing_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('billing_events_provider_event_uq').on(t.provider, t.eventId)],
);

// ---------- Company verification ----------

/** Each check of a legal entity against the commercial register, and any manual decision on it. */
export const companyVerifications = pgTable(
  'company_verifications',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    kind: text('kind').notNull().default('cr'),
    number: text('number').notNull(),
    /** verified, needs_review, rejected, pending (registry unreachable), approved / denied (after review). */
    status: text('status').notNull(),
    reason: text('reason'),
    provider: text('provider').notNull(),
    registry: jsonb('registry').$type<Record<string, unknown> | null>(),
    nameScore: numeric('name_score', { precision: 4, scale: 3 }),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    attempts: integer('attempts').notNull().default(1),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.legalEntityId], foreignColumns: [legalEntities.orgId, legalEntities.id] }).onDelete('cascade'),
    index('company_verifications_status_idx').on(t.status, t.createdAt),
  ],
);
