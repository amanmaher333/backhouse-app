CREATE TYPE "public"."supplier_invoice_status" AS ENUM('needs_review', 'matched', 'mismatch', 'approved', 'disputed', 'paid', 'rejected');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_emails" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"message_id" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text,
	"attachments" integer DEFAULT 0 NOT NULL,
	"invoices" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_documents_org_id_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_inboxes" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"description" text NOT NULL,
	"supplier_sku" text,
	"qty" numeric(14, 3) NOT NULL,
	"unit" text,
	"unit_price" numeric(14, 4) NOT NULL,
	"line_total" numeric(16, 2) NOT NULL,
	"tax_rate" numeric(6, 4),
	"po_line_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"type" text DEFAULT 'invoice' NOT NULL,
	"status" "supplier_invoice_status" DEFAULT 'needs_review' NOT NULL,
	"relationship_id" uuid,
	"site_id" uuid,
	"po_id" uuid,
	"corrects_invoice_id" uuid,
	"number" text,
	"zatca_uuid" text,
	"issue_date" text,
	"due_date" text,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"subtotal" numeric(16, 2),
	"tax_total" numeric(16, 2),
	"total" numeric(16, 2),
	"supplier_vat" text,
	"supplier_name_on_invoice" text,
	"buyer_vat" text,
	"order_reference" text,
	"billing_reference" text,
	"source" text NOT NULL,
	"extracted_by" text NOT NULL,
	"document_id" uuid,
	"email_from" text,
	"email_subject" text,
	"extraction" jsonb,
	"match" jsonb,
	"claim_total" numeric(16, 2) DEFAULT '0' NOT NULL,
	"review_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"dispute_message" text,
	"disputed_at" timestamp with time zone,
	"disputed_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_override" text,
	"paid_at" timestamp with time zone,
	"payment_reference" text,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"agent_task_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoices_org_id_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "supplier_invoices_org_ref_uq" UNIQUE("org_id","ref")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_inboxes" ADD CONSTRAINT "invoice_inboxes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_org_id_invoice_id_supplier_invoices_org_id_id_fk" FOREIGN KEY ("org_id","invoice_id") REFERENCES "public"."supplier_invoices"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_org_id_relationship_id_trading_relationships_org_id_id_fk" FOREIGN KEY ("org_id","relationship_id") REFERENCES "public"."trading_relationships"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_org_id_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_org_id_po_id_purchase_orders_org_id_id_fk" FOREIGN KEY ("org_id","po_id") REFERENCES "public"."purchase_orders"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_org_id_document_id_invoice_documents_org_id_id_fk" FOREIGN KEY ("org_id","document_id") REFERENCES "public"."invoice_documents"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inbound_emails_message_uq" ON "inbound_emails" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_documents_sha_idx" ON "invoice_documents" USING btree ("org_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_inboxes_token_uq" ON "invoice_inboxes" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_invoice_lines_invoice_idx" ON "supplier_invoice_lines" USING btree ("invoice_id","line_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_invoices_org_status_idx" ON "supplier_invoices" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_invoices_supplier_number_idx" ON "supplier_invoices" USING btree ("relationship_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_invoices_po_idx" ON "supplier_invoices" USING btree ("po_id");--> statement-breakpoint
-- Supplier invoices: tenant-isolated. Original documents are kept unchanged; invoices are rejected, never deleted.
GRANT SELECT, INSERT, UPDATE ON supplier_invoices TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_invoice_lines TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON invoice_documents, invoice_inboxes TO boh_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_invoices','supplier_invoice_lines','invoice_documents','invoice_inboxes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_documents_immutable BEFORE UPDATE OR DELETE ON invoice_documents FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
CREATE TRIGGER supplier_invoices_no_delete BEFORE DELETE ON supplier_invoices FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON supplier_invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Inbound email log: written and read by the system only.
ALTER TABLE inbound_emails ENABLE ROW LEVEL SECURITY;
