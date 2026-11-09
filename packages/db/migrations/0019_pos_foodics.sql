CREATE TABLE IF NOT EXISTS "pos_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"business_id" text NOT NULL,
	"business_reference" text NOT NULL,
	"business_name" text NOT NULL,
	"currency" text,
	"timezone" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"token_sealed" text,
	"pos_supplier_id" text,
	"pos_user_id" text,
	"push_purchases" boolean DEFAULT true NOT NULL,
	"last_order_reference" bigint DEFAULT 0 NOT NULL,
	"import_from" text,
	"catalog_synced_at" timestamp with time zone,
	"orders_synced_at" timestamp with time zone,
	"needs_sync" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"connected_by" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_connections_org_id_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"sku" text,
	"name" text NOT NULL,
	"name_ar" text,
	"storage_unit" text,
	"ingredient_unit" text,
	"storage_factor" numeric(18, 6),
	"item_id" uuid,
	"mapped_by" text,
	"manual_factor" numeric(18, 6),
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"reference" text,
	"site_id" uuid,
	"mapped_by" text,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"reference" bigint,
	"location_external_id" text,
	"business_date" text NOT NULL,
	"status" integer NOT NULL,
	"total_price" numeric(16, 2),
	"lines" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"sku" text,
	"name" text NOT NULL,
	"name_ar" text,
	"category" text,
	"price" numeric(14, 4),
	"is_active" boolean DEFAULT true NOT NULL,
	"pos_ingredients" jsonb,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_id" text,
	"external_reference" text,
	"detail" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_sales_daily" (
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"location_external_id" text NOT NULL,
	"product_external_id" text NOT NULL,
	"business_date" text NOT NULL,
	"qty" numeric(16, 3) DEFAULT '0' NOT NULL,
	"net" numeric(16, 2) DEFAULT '0' NOT NULL,
	"orders" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pos_sales_daily_connection_id_location_external_id_product_external_id_business_date_pk" PRIMARY KEY("connection_id","location_external_id","product_external_id","business_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pos_webhook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event" text NOT NULL,
	"business_reference" text,
	"object_id" text,
	"org_id" uuid,
	"outcome" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_items" ADD CONSTRAINT "pos_items_org_id_connection_id_pos_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."pos_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_items" ADD CONSTRAINT "pos_items_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_locations" ADD CONSTRAINT "pos_locations_org_id_connection_id_pos_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."pos_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_locations" ADD CONSTRAINT "pos_locations_org_id_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_org_id_connection_id_pos_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."pos_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_products" ADD CONSTRAINT "pos_products_org_id_connection_id_pos_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."pos_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_pushes" ADD CONSTRAINT "pos_pushes_org_id_connection_id_pos_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."pos_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_sales_daily" ADD CONSTRAINT "pos_sales_daily_org_id_connection_id_pos_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."pos_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pos_connections_org_idx" ON "pos_connections" USING btree ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pos_connections_business_live_uq" ON "pos_connections" USING btree ("provider","business_reference") WHERE status <> 'disconnected';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pos_items_ext_uq" ON "pos_items" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pos_items_item_idx" ON "pos_items" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pos_locations_ext_uq" ON "pos_locations" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pos_orders_ext_uq" ON "pos_orders" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pos_products_ext_uq" ON "pos_products" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pos_pushes_source_uq" ON "pos_pushes" USING btree ("connection_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pos_pushes_status_idx" ON "pos_pushes" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pos_sales_daily_date_idx" ON "pos_sales_daily" USING btree ("connection_id","business_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pos_webhook_events_pending_idx" ON "pos_webhook_events" USING btree ("processed_at");--> statement-breakpoint
-- POS integrations: tenant-isolated. Webhook events arrive before we know the organisation,
-- so the API reads and writes them with owner privileges only (no app-role grant).
GRANT SELECT, INSERT, UPDATE, DELETE ON pos_connections, pos_oauth_states, pos_locations, pos_items, pos_products, pos_orders, pos_sales_daily, pos_pushes TO boh_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE pos_orders_id_seq TO boh_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_connections','pos_oauth_states','pos_locations','pos_items','pos_products','pos_orders','pos_sales_daily','pos_pushes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE pos_webhook_events ENABLE ROW LEVEL SECURITY;
