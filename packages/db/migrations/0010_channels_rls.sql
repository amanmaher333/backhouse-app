-- Channels: grants and row-level security.
-- user_channels belong to a person (not an org): visible to that person, and to members of
-- the person's current org only through the app (approval routing runs with system access).

GRANT SELECT, INSERT, UPDATE, DELETE ON user_channels TO boh_app;
--> statement-breakpoint
GRANT SELECT ON outbound_messages, approval_prompts TO boh_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO boh_app;
--> statement-breakpoint

ALTER TABLE user_channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_channels ON user_channels USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());
--> statement-breakpoint

-- The message log: an org sees its own messages; a person sees their account messages (org_id NULL).
ALTER TABLE outbound_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_or_own ON outbound_messages
  USING (org_id = app_current_org() OR (org_id IS NULL AND user_id = app_current_user()));
--> statement-breakpoint

ALTER TABLE approval_prompts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON approval_prompts USING (org_id = app_current_org());
--> statement-breakpoint

-- Link codes and inbound messages are only touched by the system (webhook, linking): no grants,
-- and RLS on with no policy so the app role sees nothing even if granted by mistake.
ALTER TABLE channel_link_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_channels','outbound_messages']
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END
$$;
