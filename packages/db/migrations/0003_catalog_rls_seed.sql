-- Catalogue: fuzzy matching, row-level security, append-only price history.
-- The shared ingredient map itself is seeded from code (src/canonical-seed.ts) on every migrate.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS canonical_aliases_trgm ON canonical_aliases USING gin (alias_norm gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_name_norm_trgm ON items USING gin (name_norm gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_items_name_norm_trgm ON supplier_items USING gin (supplier_name_norm gin_trgm_ops);
--> statement-breakpoint

-- Shared ingredient map: readable by every tenant, written only by the platform (owner role).
GRANT SELECT ON canonical_ingredients, canonical_aliases TO boh_app;
--> statement-breakpoint

-- Supplier profiles: a tenant sees profiles it trades with, created, or owns (claimed).
-- Writes happen through the API's system connection (find-or-create by VAT number).
GRANT SELECT ON supplier_profiles TO boh_app;
--> statement-breakpoint
ALTER TABLE supplier_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY supplier_profile_read ON supplier_profiles FOR SELECT USING (
  claimed_org_id = app_current_org()
  OR created_by_org_id = app_current_org()
  OR id IN (SELECT supplier_profile_id FROM trading_relationships WHERE org_id = app_current_org())
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON
  org_counters, items, packs, item_site_settings, trading_relationships, supplier_site_settings, supplier_items
TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON supplier_item_prices, corrections TO boh_app;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_counters','items','packs','item_site_settings','trading_relationships',
                           'supplier_site_settings','supplier_items','supplier_item_prices','corrections']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Price history is append-only (same rule as the audit log).
CREATE TRIGGER supplier_item_prices_no_update_delete BEFORE UPDATE OR DELETE ON supplier_item_prices
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
CREATE TRIGGER supplier_item_prices_no_truncate BEFORE TRUNCATE ON supplier_item_prices
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['canonical_ingredients','items','packs','item_site_settings','supplier_profiles',
                           'trading_relationships','supplier_site_settings','supplier_items']
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END
$$;
