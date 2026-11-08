-- Procurement and stock: row-level security, grants, append-only stock ledger.

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_orders, purchase_order_lines, stock_balances, spend_limits TO boh_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON stock_movements, goods_receipts, goods_receipt_lines TO boh_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO boh_app;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_movements','stock_balances','purchase_orders','purchase_order_lines',
                           'goods_receipts','goods_receipt_lines','spend_limits']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- The stock ledger and posted receipts never change; corrections are new movements.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_movements','goods_receipts','goods_receipt_lines']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_events_immutable()', t || '_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable()', t || '_no_truncate', t);
  END LOOP;
END
$$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders','spend_limits']
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END
$$;
