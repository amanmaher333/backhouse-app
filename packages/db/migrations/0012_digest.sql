CREATE TABLE IF NOT EXISTS "digest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"local_date" text NOT NULL,
	"counts" jsonb NOT NULL,
	"outbound_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_channels" ADD COLUMN "digest_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_channels" ADD COLUMN "digest_hour" smallint DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_channels" ADD COLUMN "time_zone" text DEFAULT 'Asia/Riyadh' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "digest_runs" ADD CONSTRAINT "digest_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "digest_runs" ADD CONSTRAINT "digest_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digest_runs_user_org_date_uq" ON "digest_runs" USING btree ("user_id","org_id","local_date");--> statement-breakpoint
-- Digest runs are written by the worker (system); members can read their org's runs.
GRANT SELECT ON digest_runs TO boh_app;
--> statement-breakpoint
ALTER TABLE digest_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON digest_runs USING (org_id = app_current_org());
