-- Agent platform: row-level security, grants, append-only events.

GRANT SELECT, INSERT, UPDATE, DELETE ON agents, agent_tasks, access_tokens TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON agent_runs TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON events TO boh_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO boh_app;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agents','agent_tasks','agent_runs','events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Access tokens: visible in the current org, and only the owner's own tokens unless revoked by an admin (app rule).
ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON access_tokens USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- Events are append-only.
CREATE TRIGGER events_no_update_delete BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agents','agent_tasks']
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END
$$;
