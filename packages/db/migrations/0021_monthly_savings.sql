CREATE TABLE IF NOT EXISTS "savings_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"period" text NOT NULL,
	"saved" numeric(16, 2) DEFAULT '0' NOT NULL,
	"in_progress" numeric(16, 2) DEFAULT '0' NOT NULL,
	"outbound_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_channels" ADD COLUMN "monthly_savings_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_reports" ADD CONSTRAINT "savings_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_reports" ADD CONSTRAINT "savings_reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "savings_reports_user_org_period_uq" ON "savings_reports" USING btree ("user_id","org_id","period");--> statement-breakpoint
GRANT SELECT ON savings_reports TO boh_app;
--> statement-breakpoint
ALTER TABLE savings_reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON savings_reports USING (org_id = app_current_org());
