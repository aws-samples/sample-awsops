-- Gap-audit L178 (round-3 review): 'was report N ever emailed?' must stay answerable from a
-- DURABLE record, not 14-day CloudWatch logs — notified_at alone stamps delivered and
-- paused-dropped identically. '' = legacy/unknown (pre-migration rows); new digest runs write
-- 'emailed' (MessageId confirmed) | 'emailed_failopen' | 'publish_failed' | 'dropped_paused' | 'skipped_no_topic'.
ALTER TABLE diagnosis_reports ADD COLUMN IF NOT EXISTS notify_outcome text NOT NULL DEFAULT '';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diagnosis_reports_notify_outcome_chk') THEN
    ALTER TABLE diagnosis_reports ADD CONSTRAINT diagnosis_reports_notify_outcome_chk
      CHECK (notify_outcome IN ('', 'emailed', 'emailed_failopen', 'publish_failed', 'dropped_paused', 'skipped_no_topic'));
  END IF;
END $$;

-- Keep the agent's fixed-column read view in lockstep (the compliance_results description
-- precedent): re-project sql_reader.diagnosis_reports with notify_outcome. Idempotent;
-- skipped when the reader role/schema was never provisioned.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awsops_sql_reader')
     AND EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'sql_reader') THEN
    DROP VIEW IF EXISTS sql_reader.diagnosis_reports;
    CREATE VIEW sql_reader.diagnosis_reports WITH (security_invoker = false) AS
      SELECT id, worker_job_id, parent_report_id, tier, status, requested_by, model, title,
             created_at, updated_at, notified_at, notify_outcome, deleted_at
      FROM public.diagnosis_reports;
    GRANT SELECT ON sql_reader.diagnosis_reports TO awsops_sql_reader;
  ELSE
    RAISE NOTICE 'awsops_sql_reader/sql_reader absent - view refresh skipped';
  END IF;
END $$;
