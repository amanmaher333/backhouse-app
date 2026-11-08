-- Row-level security, append-only audit log, updated_at triggers.
--
-- The API runs each tenant request inside a transaction that does
--   SET LOCAL ROLE boh_app;
--   SELECT set_config('app.org_id', <org>, true), set_config('app.user_id', <user>, true);
-- boh_app is a non-owner role, so RLS policies apply to it. The table owner
-- (migrations / "system" operations such as signup and login) bypasses RLS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'boh_app') THEN
    CREATE ROLE boh_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT boh_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO boh_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  organizations, legal_entities, brands, sites, storage_locations, cost_centres,
  roles, memberships, invitations
TO boh_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON users TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_events TO boh_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- Simple org-scoped tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['legal_entities','brands','sites','storage_locations','cost_centres','invitations','audit_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Memberships: a user can always see their own memberships (to list their orgs).
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY membership_read ON memberships FOR SELECT
  USING (org_id = app_current_org() OR user_id = app_current_user());
--> statement-breakpoint
CREATE POLICY membership_write ON memberships FOR ALL
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- Organizations: current org, plus orgs the user belongs to (read-only).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_read ON organizations FOR SELECT
  USING (id = app_current_org() OR id IN (SELECT org_id FROM memberships WHERE user_id = app_current_user()));
--> statement-breakpoint
CREATE POLICY org_write ON organizations FOR UPDATE
  USING (id = app_current_org()) WITH CHECK (id = app_current_org());
--> statement-breakpoint

-- Roles: system roles (org_id NULL) are visible to everyone; custom roles per org.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY role_read ON roles FOR SELECT USING (org_id IS NULL OR org_id = app_current_org());
--> statement-breakpoint
CREATE POLICY role_insert ON roles FOR INSERT WITH CHECK (org_id = app_current_org() AND NOT is_system);
--> statement-breakpoint
CREATE POLICY role_update ON roles FOR UPDATE
  USING (org_id = app_current_org() AND NOT is_system) WITH CHECK (org_id = app_current_org() AND NOT is_system);
--> statement-breakpoint
CREATE POLICY role_delete ON roles FOR DELETE USING (org_id = app_current_org() AND NOT is_system);
--> statement-breakpoint

-- Users: visible if it's you or a member of the current org; only you can update yourself.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY user_read ON users FOR SELECT
  USING (id = app_current_user() OR id IN (SELECT user_id FROM memberships WHERE org_id = app_current_org()));
--> statement-breakpoint
CREATE POLICY user_update_self ON users FOR UPDATE
  USING (id = app_current_user()) WITH CHECK (id = app_current_user());
--> statement-breakpoint

-- Audit log is append-only, for everyone including the owner.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% not allowed)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint

-- updated_at maintenance
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','users','legal_entities','brands','sites','storage_locations','cost_centres','roles','memberships']
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END
$$;
