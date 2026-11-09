CREATE TYPE "public"."stock_count_status" AS ENUM('open', 'submitted', 'posted', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"snapshot_qty" numeric(18, 6) DEFAULT '0' NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"counted_qty" numeric(18, 6),
	"expected_qty" numeric(18, 6),
	"entry_qty" numeric(18, 6),
	"entry_unit" text,
	"entry_pack_id" uuid,
	"entry_text" text,
	"counted_at" timestamp with time zone,
	"counted_by" uuid,
	"unit_cost" numeric(18, 8),
	"adjustment_qty" numeric(18, 6),
	"variance_value" numeric(16, 2)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"status" "stock_count_status" DEFAULT 'open' NOT NULL,
	"scope" text DEFAULT 'full' NOT NULL,
	"blind" boolean DEFAULT true NOT NULL,
	"note" text,
	"source" text DEFAULT 'app' NOT NULL,
	"variance_value" numeric(16, 2),
	"abs_variance_value" numeric(16, 2),
	"needs_approval" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_org_id_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "stock_counts_org_ref_uq" UNIQUE("org_id","ref")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_org_id_count_id_stock_counts_org_id_id_fk" FOREIGN KEY ("org_id","count_id") REFERENCES "public"."stock_counts"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_org_id_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_count_lines_item_uq" ON "stock_count_lines" USING btree ("count_id","item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_counts_site_status_idx" ON "stock_counts" USING btree ("site_id","status","created_at");--> statement-breakpoint
-- Stock counts: tenant-isolated. A posted count is final: neither it nor its lines can change or be deleted.
GRANT SELECT, INSERT, UPDATE ON stock_counts TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_count_lines TO boh_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_counts','stock_count_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stock_counts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'stock count % is posted and cannot be changed', OLD.ref;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_counts_guard BEFORE UPDATE ON stock_counts FOR EACH ROW EXECUTE FUNCTION stock_counts_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stock_count_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s stock_count_status;
BEGIN
  SELECT status INTO s FROM stock_counts WHERE id = COALESCE(OLD.count_id, NEW.count_id);
  IF s = 'posted' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'lines of a posted stock count cannot be changed';
  END IF;
  IF s = 'posted' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'lines cannot be added to a posted stock count';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_count_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_count_lines FOR EACH ROW EXECUTE FUNCTION stock_count_lines_guard();
