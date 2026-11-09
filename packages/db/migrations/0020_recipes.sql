CREATE TABLE IF NOT EXISTS "recipe_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"item_id" uuid,
	"sub_recipe_id" uuid,
	"qty" numeric(14, 4) NOT NULL,
	"unit" text,
	"pack_id" uuid,
	"yield_pct" numeric(5, 2) DEFAULT '100' NOT NULL,
	"note" text,
	CONSTRAINT "recipe_lines_one_ref_chk" CHECK (("recipe_lines"."item_id" is null) <> ("recipe_lines"."sub_recipe_id" is null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"kind" text DEFAULT 'menu' NOT NULL,
	"category" text,
	"yield_qty" numeric(14, 4) DEFAULT '1' NOT NULL,
	"yield_unit" text DEFAULT 'each' NOT NULL,
	"selling_price" numeric(14, 4),
	"price_includes_vat" boolean DEFAULT true NOT NULL,
	"target_cost_pct" numeric(5, 2),
	"pos_product_id" uuid,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'app' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipes_org_id_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_org_id_recipe_id_recipes_org_id_id_fk" FOREIGN KEY ("org_id","recipe_id") REFERENCES "public"."recipes"("org_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_org_id_sub_recipe_id_recipes_org_id_id_fk" FOREIGN KEY ("org_id","sub_recipe_id") REFERENCES "public"."recipes"("org_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_lines_recipe_idx" ON "recipe_lines" USING btree ("recipe_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_lines_sub_idx" ON "recipe_lines" USING btree ("sub_recipe_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recipes_pos_product_uq" ON "recipes" USING btree ("pos_product_id") WHERE pos_product_id is not null and is_active;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipes_org_kind_idx" ON "recipes" USING btree ("org_id","kind");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON recipes, recipe_lines TO boh_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recipes','recipe_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END
$$;
