CREATE TYPE "public"."channel_kind" AS ENUM('whatsapp');--> statement-breakpoint
CREATE TYPE "public"."outbound_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'simulated');--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_org_id_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"can_approve" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"decision" text,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "channel_kind" NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel" "channel_kind" NOT NULL,
	"provider_message_id" text NOT NULL,
	"from_address" text NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"outcome" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"user_id" uuid NOT NULL,
	"channel" "channel_kind" NOT NULL,
	"to_address" text NOT NULL,
	"kind" text NOT NULL,
	"task_id" uuid,
	"content" jsonb NOT NULL,
	"sent_as" text,
	"status" "outbound_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "channel_kind" NOT NULL,
	"address" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"approvals_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "decided_via" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_prompts" ADD CONSTRAINT "approval_prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_prompts" ADD CONSTRAINT "approval_prompts_org_id_task_id_agent_tasks_org_id_id_fk" FOREIGN KEY ("org_id","task_id") REFERENCES "public"."agent_tasks"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_link_codes" ADD CONSTRAINT "channel_link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_prompts_task_user_uq" ON "approval_prompts" USING btree ("task_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_link_codes_hash_uq" ON "channel_link_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inbound_messages_provider_id_uq" ON "inbound_messages" USING btree ("channel","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outbound_messages_provider_id_uq" ON "outbound_messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_messages_queue_idx" ON "outbound_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_messages_org_idx" ON "outbound_messages" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_channels_address_uq" ON "user_channels" USING btree ("channel","address");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_channels_user_uq" ON "user_channels" USING btree ("user_id","channel");
