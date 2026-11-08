CREATE TABLE IF NOT EXISTS "supplier_order_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"po_id" uuid NOT NULL,
	"relationship_id" uuid NOT NULL,
	"to_address" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"awaiting_note_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "relationship_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "po_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "relationship_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "po_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "supplier_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "supplier_confirmed_via" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "supplier_issue" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "supplier_issue_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_order_links" ADD CONSTRAINT "supplier_order_links_org_id_po_id_purchase_orders_org_id_id_fk" FOREIGN KEY ("org_id","po_id") REFERENCES "public"."purchase_orders"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_order_links_token_uq" ON "supplier_order_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_order_links_to_idx" ON "supplier_order_links" USING btree ("to_address","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_messages_from_idx" ON "inbound_messages" USING btree ("from_address","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_messages_po_idx" ON "inbound_messages" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_messages_po_idx" ON "outbound_messages" USING btree ("po_id");--> statement-breakpoint
-- Tenant code (people and agents) queues messages; workers send them with system access.
GRANT INSERT ON outbound_messages TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON supplier_order_links TO boh_app;
--> statement-breakpoint
ALTER TABLE supplier_order_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON supplier_order_links USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
-- Supplier replies attached to an order are readable by that org (the PO conversation).
GRANT SELECT ON inbound_messages TO boh_app;
--> statement-breakpoint
CREATE POLICY org_replies ON inbound_messages FOR SELECT USING (org_id IS NOT NULL AND org_id = app_current_org());
