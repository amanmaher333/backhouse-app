CREATE TYPE "public"."match_source" AS ENUM('auto', 'human');--> statement-breakpoint
CREATE TYPE "public"."order_channel" AS ENUM('email', 'whatsapp', 'portal', 'manual');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('manual', 'import', 'invoice', 'supplier');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alias_confirmations" (
	"alias_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alias_confirmations_alias_id_org_id_pk" PRIMARY KEY("alias_id","org_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canonical_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_id" uuid NOT NULL,
	"alias_norm" text NOT NULL,
	"source" text DEFAULT 'seed' NOT NULL,
	"org_confirmations" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canonical_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"category" text NOT NULL,
	"base_unit" text NOT NULL,
	"density_g_per_ml" numeric(10, 4),
	"each_weight_g" numeric(10, 2),
	"allergens" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_ingredients_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corrections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"input" jsonb,
	"model_output" jsonb,
	"human_output" jsonb,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_site_settings" (
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"par_level" numeric(18, 6),
	"reorder_point" numeric(18, 6),
	"is_stocked" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_site_settings_item_id_site_id_pk" PRIMARY KEY("item_id","site_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"name_norm" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"base_unit" text NOT NULL,
	"canonical_id" uuid,
	"canonical_score" numeric(5, 4),
	"canonical_source" "match_source",
	"allergens" text[] DEFAULT '{}'::text[] NOT NULL,
	"conversions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_stockable" boolean DEFAULT true NOT NULL,
	"track_lots" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_org_id_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "items_org_code_uq" UNIQUE("org_id","code"),
	CONSTRAINT "items_base_unit_chk" CHECK ("items"."base_unit" in ('g','ml','each'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_counters" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "org_counters_org_id_key_pk" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"qty" numeric(14, 4) NOT NULL,
	"unit" text,
	"parent_pack_id" uuid,
	"base_qty" numeric(18, 6) NOT NULL,
	"barcode" text,
	"is_orderable" boolean DEFAULT true NOT NULL,
	"is_countable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packs_org_id_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "packs_one_ref_chk" CHECK (("packs"."unit" is null) <> ("packs"."parent_pack_id" is null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_item_prices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_item_id" uuid NOT NULL,
	"site_id" uuid,
	"price" numeric(14, 4) NOT NULL,
	"previous_price" numeric(14, 4),
	"currency" text DEFAULT 'SAR' NOT NULL,
	"source" "price_source" DEFAULT 'manual' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"relationship_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"supplier_sku" text,
	"supplier_name" text,
	"supplier_name_norm" text,
	"current_price" numeric(14, 4) NOT NULL,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"price_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_items_org_id_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "supplier_items_price_chk" CHECK ("supplier_items"."current_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"country" text DEFAULT 'SA' NOT NULL,
	"vat_number" text,
	"cr_number" text,
	"claimed_org_id" uuid,
	"created_by_org_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_site_settings" (
	"org_id" uuid NOT NULL,
	"relationship_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"delivery_days" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"cutoff_time" text,
	"lead_time_days" integer DEFAULT 1 NOT NULL,
	"account_number" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_site_settings_relationship_id_site_id_pk" PRIMARY KEY("relationship_id","site_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_profile_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"display_name_ar" text,
	"order_channel" "order_channel" DEFAULT 'email' NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"account_number" text,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"tax_rate" numeric(6, 4) DEFAULT '0.15' NOT NULL,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"min_order_value" numeric(14, 2),
	"delivery_fee" numeric(14, 2),
	"hide_prices_on_po" boolean DEFAULT false NOT NULL,
	"invoice_sender_whitelist" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_relationships_org_id_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "trading_relationships_org_profile_uq" UNIQUE("org_id","supplier_profile_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alias_confirmations" ADD CONSTRAINT "alias_confirmations_alias_id_canonical_aliases_id_fk" FOREIGN KEY ("alias_id") REFERENCES "public"."canonical_aliases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alias_confirmations" ADD CONSTRAINT "alias_confirmations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canonical_aliases" ADD CONSTRAINT "canonical_aliases_canonical_id_canonical_ingredients_id_fk" FOREIGN KEY ("canonical_id") REFERENCES "public"."canonical_ingredients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_site_settings" ADD CONSTRAINT "item_site_settings_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_site_settings" ADD CONSTRAINT "item_site_settings_org_id_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_canonical_id_canonical_ingredients_id_fk" FOREIGN KEY ("canonical_id") REFERENCES "public"."canonical_ingredients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_counters" ADD CONSTRAINT "org_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "packs" ADD CONSTRAINT "packs_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_item_prices" ADD CONSTRAINT "supplier_item_prices_org_id_supplier_item_id_supplier_items_org_id_id_fk" FOREIGN KEY ("org_id","supplier_item_id") REFERENCES "public"."supplier_items"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_org_id_relationship_id_trading_relationships_org_id_id_fk" FOREIGN KEY ("org_id","relationship_id") REFERENCES "public"."trading_relationships"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_org_id_pack_id_packs_org_id_id_fk" FOREIGN KEY ("org_id","pack_id") REFERENCES "public"."packs"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_profiles" ADD CONSTRAINT "supplier_profiles_claimed_org_id_organizations_id_fk" FOREIGN KEY ("claimed_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_profiles" ADD CONSTRAINT "supplier_profiles_created_by_org_id_organizations_id_fk" FOREIGN KEY ("created_by_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_site_settings" ADD CONSTRAINT "supplier_site_settings_org_id_relationship_id_trading_relationships_org_id_id_fk" FOREIGN KEY ("org_id","relationship_id") REFERENCES "public"."trading_relationships"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_site_settings" ADD CONSTRAINT "supplier_site_settings_org_id_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trading_relationships" ADD CONSTRAINT "trading_relationships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trading_relationships" ADD CONSTRAINT "trading_relationships_supplier_profile_id_supplier_profiles_id_fk" FOREIGN KEY ("supplier_profile_id") REFERENCES "public"."supplier_profiles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_aliases_uq" ON "canonical_aliases" USING btree ("canonical_id","alias_norm");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corrections_org_kind_idx" ON "corrections" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "items_org_name_uq" ON "items" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_org_category_idx" ON "items" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_canonical_idx" ON "items" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "packs_item_idx" ON "packs" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "packs_org_barcode_uq" ON "packs" USING btree ("org_id","barcode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_item_prices_item_idx" ON "supplier_item_prices" USING btree ("supplier_item_id","effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_item_prices_org_time_idx" ON "supplier_item_prices" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_items_sku_uq" ON "supplier_items" USING btree ("relationship_id","supplier_sku");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_items_pack_uq" ON "supplier_items" USING btree ("relationship_id","pack_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_items_item_idx" ON "supplier_items" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_profiles_vat_uq" ON "supplier_profiles" USING btree ("country","vat_number");