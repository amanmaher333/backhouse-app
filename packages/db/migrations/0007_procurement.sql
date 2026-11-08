CREATE TYPE "public"."movement_type" AS ENUM('opening', 'receipt', 'adjustment', 'transfer_in', 'transfer_out', 'waste', 'sale', 'production_in', 'production_out', 'return');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"po_line_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"qty_base" numeric(18, 6) NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"ordered_unit_price" numeric(14, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"po_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"received_by" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_no" text,
	"note" text,
	"total" numeric(16, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_org_id_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "goods_receipts_org_number_uq" UNIQUE("org_id","number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"po_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"supplier_item_id" uuid,
	"qty" numeric(14, 3) NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"line_total" numeric(16, 2) NOT NULL,
	"received_qty" numeric(14, 3) DEFAULT '0' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "po_lines_qty_chk" CHECK ("purchase_order_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"site_id" uuid NOT NULL,
	"relationship_id" uuid NOT NULL,
	"status" "po_status" DEFAULT 'draft' NOT NULL,
	"delivery_date" text,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"tax_rate" numeric(6, 4) DEFAULT '0.15' NOT NULL,
	"subtotal" numeric(16, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(16, 2) DEFAULT '0' NOT NULL,
	"total" numeric(16, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"agent_task_id" uuid,
	"approval_reason" text,
	"created_by" uuid,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"sent_via" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_org_id_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "purchase_orders_org_number_uq" UNIQUE("org_id","number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spend_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid,
	"relationship_id" uuid,
	"period" text NOT NULL,
	"amount" numeric(16, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_balances" (
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty_on_hand" numeric(18, 6) DEFAULT '0' NOT NULL,
	"avg_cost" numeric(18, 8) DEFAULT '0' NOT NULL,
	"last_movement_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_site_id_item_id_pk" PRIMARY KEY("site_id","item_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"type" "movement_type" NOT NULL,
	"qty_base" numeric(18, 6) NOT NULL,
	"unit_cost" numeric(18, 8),
	"total_cost" numeric(16, 4),
	"source_type" text,
	"source_id" text,
	"note" text,
	"actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"created_by" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_org_id_receipt_id_goods_receipts_org_id_id_fk" FOREIGN KEY ("org_id","receipt_id") REFERENCES "public"."goods_receipts"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_org_id_po_id_purchase_orders_org_id_id_fk" FOREIGN KEY ("org_id","po_id") REFERENCES "public"."purchase_orders"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_org_id_po_id_purchase_orders_org_id_id_fk" FOREIGN KEY ("org_id","po_id") REFERENCES "public"."purchase_orders"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_org_id_pack_id_packs_org_id_id_fk" FOREIGN KEY ("org_id","pack_id") REFERENCES "public"."packs"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_org_id_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_org_id_relationship_id_trading_relationships_org_id_id_fk" FOREIGN KEY ("org_id","relationship_id") REFERENCES "public"."trading_relationships"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spend_limits" ADD CONSTRAINT "spend_limits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_org_id_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_org_id_site_id_sites_org_id_id_fk" FOREIGN KEY ("org_id","site_id") REFERENCES "public"."sites"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goods_receipt_lines_receipt_idx" ON "goods_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_order_lines_po_idx" ON "purchase_order_lines" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_org_status_idx" ON "purchase_orders" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_site_idx" ON "purchase_orders" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movements_site_item_idx" ON "stock_movements" USING btree ("site_id","item_id","id");