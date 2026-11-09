CREATE TYPE "public"."transfer_status" AS ENUM('draft', 'sent', 'received', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty_base" numeric(18, 6) NOT NULL,
	"entry_qty" numeric(18, 6) NOT NULL,
	"entry_unit" text,
	"entry_pack_id" uuid,
	"unit_cost" numeric(18, 8),
	"received_qty" numeric(18, 6)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"from_site_id" uuid NOT NULL,
	"to_site_id" uuid NOT NULL,
	"status" "transfer_status" DEFAULT 'draft' NOT NULL,
	"note" text,
	"value" numeric(16, 2),
	"short_value" numeric(16, 2),
	"source" text DEFAULT 'app' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfers_org_id_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "stock_transfers_org_ref_uq" UNIQUE("org_id","ref"),
	CONSTRAINT "stock_transfers_sites_chk" CHECK ("stock_transfers"."from_site_id" <> "stock_transfers"."to_site_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "waste_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty_base" numeric(18, 6) NOT NULL,
	"entry_qty" numeric(18, 6) NOT NULL,
	"entry_unit" text,
	"entry_pack_id" uuid,
	"entry_text" text,
	"reason" text NOT NULL,
	"note" text,
	"unit_cost" numeric(18, 8) DEFAULT '0' NOT NULL,
	"value" numeric(16, 2) DEFAULT '0' NOT NULL,
	"source" text DEFAULT 'app' NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_org_id_transfer_id_stock_transfers_org_id_id_fk" FOREIGN KEY ("org_id","transfer_id") REFERENCES "public"."stock_transfers"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_org_id_from_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","from_site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_org_id_to_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","to_site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_org_id_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_transfer_lines_item_uq" ON "stock_transfer_lines" USING btree ("transfer_id","item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_from_idx" ON "stock_transfers" USING btree ("from_site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_to_idx" ON "stock_transfers" USING btree ("to_site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waste_entries_site_idx" ON "waste_entries" USING btree ("site_id","recorded_at");--> statement-breakpoint
-- Waste and transfers: tenant-isolated. Waste entries are never deleted (a mistake is voided);
-- received and cancelled transfers are final.
GRANT SELECT, INSERT, UPDATE ON waste_entries, stock_transfers TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_transfer_lines TO boh_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['waste_entries','stock_transfers','stock_transfer_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION waste_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'waste entry is voided and cannot be changed';
  END IF;
  IF NEW.site_id <> OLD.site_id OR NEW.item_id <> OLD.item_id OR NEW.qty_base <> OLD.qty_base OR NEW.value <> OLD.value OR NEW.unit_cost <> OLD.unit_cost THEN
    RAISE EXCEPTION 'waste entries can only be voided, not edited';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER waste_entries_guard BEFORE UPDATE ON waste_entries FOR EACH ROW EXECUTE FUNCTION waste_entries_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stock_transfers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('received', 'cancelled') THEN
    RAISE EXCEPTION 'transfer % is % and cannot be changed', OLD.ref, OLD.status;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_transfers_guard BEFORE UPDATE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION stock_transfers_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stock_transfer_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s transfer_status;
BEGIN
  SELECT status INTO s FROM stock_transfers WHERE id = COALESCE(OLD.transfer_id, NEW.transfer_id);
  IF s IN ('received', 'cancelled') THEN
    RAISE EXCEPTION 'lines of a % transfer cannot be changed', s;
  END IF;
  -- Once sent, only the received quantity can be filled in.
  IF s = 'sent' AND (TG_OP <> 'UPDATE' OR NEW.qty_base <> OLD.qty_base OR NEW.item_id <> OLD.item_id OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost) THEN
    RAISE EXCEPTION 'lines of a sent transfer cannot be changed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_transfer_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_transfer_lines FOR EACH ROW EXECUTE FUNCTION stock_transfer_lines_guard();
