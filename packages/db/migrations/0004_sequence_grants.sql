-- New tables with bigserial ids (price history, corrections) need sequence access for the app role.
-- Default privileges cover sequences and tables created by future migrations.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO boh_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO boh_app;
