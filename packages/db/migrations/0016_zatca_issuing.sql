CREATE TABLE IF NOT EXISTS "sales_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"name" text NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"vat_category" text DEFAULT 'S' NOT NULL,
	"vat_rate" numeric(5, 2) DEFAULT '15' NOT NULL,
	"exemption_code" text,
	"exemption_reason" text,
	"net" numeric(16, 2) DEFAULT '0' NOT NULL,
	"vat" numeric(16, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"unit_id" uuid,
	"site_id" uuid,
	"number" text NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"type" text DEFAULT 'invoice' NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"issue_date" text,
	"issue_time" text,
	"supply_date" text,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"buyer" jsonb,
	"payment_means_code" text DEFAULT '10' NOT NULL,
	"note" text,
	"reason" text,
	"original_invoice_id" uuid,
	"billing_reference" text,
	"subtotal" numeric(16, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(16, 2) DEFAULT '0' NOT NULL,
	"total" numeric(16, 2) DEFAULT '0' NOT NULL,
	"icv" integer,
	"pih" text,
	"hash" text,
	"qr" text,
	"signed_xml" text,
	"cleared_xml" text,
	"zatca_status" text,
	"validation" jsonb,
	"submit_attempts" integer DEFAULT 0 NOT NULL,
	"next_submit_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"issued_by" uuid,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_invoices_org_id_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "sales_invoices_org_number_uq" UNIQUE("org_id","number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zatca_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"environment" text NOT NULL,
	"invoice_types" text DEFAULT '1100' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"common_name" text NOT NULL,
	"egs_serial" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"csr_pem" text NOT NULL,
	"compliance_token" text,
	"compliance_secret_enc" text,
	"compliance_request_id" text,
	"production_token" text,
	"production_secret_enc" text,
	"cert_serial" text,
	"cert_expires_at" timestamp with time zone,
	"icv" integer DEFAULT 0 NOT NULL,
	"last_hash" text,
	"checks" jsonb,
	"last_error" text,
	"activated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zatca_units_org_id_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_org_id_invoice_id_sales_invoices_org_id_id_fk" FOREIGN KEY ("org_id","invoice_id") REFERENCES "public"."sales_invoices"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_org_id_legal_entity_id_legal_entities_org_id_id_fk" FOREIGN KEY ("org_id","legal_entity_id") REFERENCES "public"."legal_entities"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_org_id_unit_id_zatca_units_org_id_id_fk" FOREIGN KEY ("org_id","unit_id") REFERENCES "public"."zatca_units"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zatca_units" ADD CONSTRAINT "zatca_units_org_id_legal_entity_id_legal_entities_org_id_id_fk" FOREIGN KEY ("org_id","legal_entity_id") REFERENCES "public"."legal_entities"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_invoice_lines_invoice_idx" ON "sales_invoice_lines" USING btree ("invoice_id","line_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_invoices_org_status_idx" ON "sales_invoices" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_invoices_submit_idx" ON "sales_invoices" USING btree ("status","next_submit_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_invoices_unit_icv_uq" ON "sales_invoices" USING btree ("unit_id","icv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zatca_units_entity_idx" ON "zatca_units" USING btree ("legal_entity_id","status");--> statement-breakpoint
-- ZATCA issuing: tenant-isolated. Signed documents are never deleted; drafts can be.
GRANT SELECT, INSERT, UPDATE ON zatca_units TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_invoices, sales_invoice_lines TO boh_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zatca_units','sales_invoices','sales_invoice_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sales_invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'issued sales invoices cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  -- Once signed, the document and its place in the chain never change.
  IF OLD.signed_xml IS NOT NULL AND (NEW.signed_xml IS DISTINCT FROM OLD.signed_xml OR NEW.hash IS DISTINCT FROM OLD.hash OR NEW.icv IS DISTINCT FROM OLD.icv
      OR NEW.pih IS DISTINCT FROM OLD.pih OR NEW.total IS DISTINCT FROM OLD.total OR NEW.number IS DISTINCT FROM OLD.number OR NEW.uuid IS DISTINCT FROM OLD.uuid) THEN
    RAISE EXCEPTION 'a signed sales invoice cannot be changed';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sales_invoices_guard BEFORE UPDATE OR DELETE ON sales_invoices FOR EACH ROW EXECUTE FUNCTION sales_invoices_guard();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sales_invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON zatca_units FOR EACH ROW EXECUTE FUNCTION set_updated_at();
