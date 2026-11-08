CREATE TYPE "public"."subscription_status" AS ENUM('free', 'trialing', 'active', 'past_due', 'suspended', 'canceled', 'expired');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"interval" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"lines" jsonb NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"vat" numeric(14, 2) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"seller" jsonb NOT NULL,
	"buyer" jsonb NOT NULL,
	"qr" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"provider_payment_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"kind" text DEFAULT 'cr' NOT NULL,
	"number" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"provider" text NOT NULL,
	"registry" jsonb,
	"name_score" numeric(4, 3),
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"status" "subscription_status" NOT NULL,
	"interval" text,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"payment_method" jsonb,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_entities" ADD COLUMN "verification_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD COLUMN "registry_name" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_verifications" ADD CONSTRAINT "company_verifications_org_id_legal_entity_id_legal_entities_org_id_id_fk" FOREIGN KEY ("org_id","legal_entity_id") REFERENCES "public"."legal_entities"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_events_provider_event_uq" ON "billing_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_invoices_number_uq" ON "billing_invoices" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_invoices_payment_uq" ON "billing_invoices" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_invoices_org_idx" ON "billing_invoices" USING btree ("org_id","issued_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_verifications_status_idx" ON "company_verifications" USING btree ("status","created_at");--> statement-breakpoint
-- Billing and verification records are written by the system; members read their org's.
GRANT SELECT ON subscriptions, billing_invoices, company_verifications TO boh_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions','billing_invoices','company_verifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (org_id = app_current_org())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Issued invoices are never deleted (statuses change as payments come in).
CREATE TRIGGER billing_invoices_no_delete BEFORE DELETE ON billing_invoices FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS billing_invoice_seq;
--> statement-breakpoint
-- Existing organisations: restaurants get a fresh 30-day trial, suppliers and the platform org are free.
INSERT INTO subscriptions (org_id, plan, status, trial_ends_at)
SELECT id,
       CASE type WHEN 'restaurant_group' THEN 'restaurant' WHEN 'supplier' THEN 'supplier_free' ELSE 'platform' END,
       CASE type WHEN 'restaurant_group' THEN 'trialing'::subscription_status ELSE 'free'::subscription_status END,
       CASE type WHEN 'restaurant_group' THEN now() + interval '30 days' ELSE NULL END
FROM organizations
ON CONFLICT (org_id) DO NOTHING;
