ALTER TABLE "billing_invoices" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "payment_reference" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "payment_mode" text DEFAULT 'card' NOT NULL;