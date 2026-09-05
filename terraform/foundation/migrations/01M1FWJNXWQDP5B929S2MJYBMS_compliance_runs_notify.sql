-- since: 2.1.0
-- Gap-audit L192 (review round-1): the compliance completion mail needs (a) a DURABLE
-- delivery record — 'was run N ever emailed?' must outlive 14-day CloudWatch logs (the
-- diagnosis_reports notify_outcome precedent) — and (b) a notified_at timestamp the worker's
-- per-benchmark dedup window reads, so a user re-running a benchmark cannot blast the
-- subscriber list (the retired per-report-mail flood is what the diagnosis digest replaced).
-- '' = legacy/unknown (pre-migration rows).
ALTER TABLE compliance_runs ADD COLUMN IF NOT EXISTS notified_at timestamptz;
ALTER TABLE compliance_runs ADD COLUMN IF NOT EXISTS notify_outcome text NOT NULL DEFAULT '';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_runs_notify_outcome_chk') THEN
    ALTER TABLE compliance_runs ADD CONSTRAINT compliance_runs_notify_outcome_chk
      CHECK (notify_outcome IN ('', 'emailed', 'emailed_failopen', 'publish_failed',
                                'dropped_paused', 'skipped_no_topic', 'skipped_dedup'));
  END IF;
END $$;

-- Keep the agent's fixed-column read view in lockstep (the diagnosis notify_outcome
-- precedent): re-project sql_reader.compliance_runs with the two new columns. Idempotent;
-- skipped when the reader role/schema was never provisioned.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awsops_sql_reader')
     AND EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'sql_reader') THEN
    DROP VIEW IF EXISTS sql_reader.compliance_runs;
    CREATE VIEW sql_reader.compliance_runs WITH (security_invoker = false) AS
      SELECT id, worker_job_id, benchmark, status, requested_by, pass_rate, total_controls,
             ok, alarm, info, skip, error, started_at, finished_at, created_at, updated_at,
             account, notified_at, notify_outcome
      FROM public.compliance_runs;
    GRANT SELECT ON sql_reader.compliance_runs TO awsops_sql_reader;
  ELSE
    RAISE NOTICE 'awsops_sql_reader/sql_reader absent - view refresh skipped';
  END IF;
END $$;
