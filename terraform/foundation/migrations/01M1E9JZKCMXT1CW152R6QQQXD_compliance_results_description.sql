-- Gap-audit L70 (v1 parity): the control detail slide-over shows the control's description
-- (the recommendation rationale) alongside Status/Reason/Resource. Backfill-free: existing
-- rows default to '' and render as '—' in the panel; new runs populate it from Powerpipe's
-- control description.
ALTER TABLE compliance_results ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

-- Keep the agent's read view in lockstep: sql_reader.compliance_results is a fixed-column
-- view (01KYVY9J...), so the new column must be re-projected explicitly or the agent never
-- sees it. Idempotent; skipped when the reader role/schema was never provisioned.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awsops_sql_reader')
     AND EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'sql_reader') THEN
    DROP VIEW IF EXISTS sql_reader.compliance_results;
    CREATE VIEW sql_reader.compliance_results WITH (security_invoker = false) AS
      SELECT id, run_id, control_id, title, section, status, reason, resource, region, severity, description
      FROM public.compliance_results;
    GRANT SELECT ON sql_reader.compliance_results TO awsops_sql_reader;
  ELSE
    RAISE NOTICE 'awsops_sql_reader/sql_reader absent - view refresh skipped';
  END IF;
END $$;
