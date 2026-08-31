-- since: 2.x.0
-- compliance_runs / compliance_results — CIS benchmark (Powerpipe via Fargate worker) run history.
-- A run is 1:1 with the worker job that produced it (worker_job_id → worker_jobs, baseline schema.sql).
-- Run-level totals/pass_rate are computed from Powerpipe's per-group control summaries; per-control
-- leaf results live in compliance_results for the UI detail list. touch_updated_at() is baseline.
-- NOTE: the migrate runner stamps schema_migrations itself — do NOT INSERT here.
CREATE TABLE IF NOT EXISTS compliance_runs (
  id             BIGSERIAL PRIMARY KEY,
  worker_job_id  UUID REFERENCES worker_jobs(job_id),
  benchmark      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  requested_by   TEXT NOT NULL,
  pass_rate      NUMERIC,
  total_controls INT, ok INT, alarm INT, info INT, skip INT, error INT,  -- error = controls in 'error' status
  error_message  TEXT,                                                   -- run failure message (distinct from the count)
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS compliance_results (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES compliance_runs(id) ON DELETE CASCADE,
  control_id TEXT NOT NULL,
  title      TEXT,
  section    TEXT,
  status     TEXT NOT NULL,
  reason     TEXT,
  resource   TEXT,
  region     TEXT,
  severity   TEXT
);

CREATE INDEX IF NOT EXISTS idx_compliance_results_run ON compliance_results(run_id);
CREATE INDEX IF NOT EXISTS idx_compliance_runs_created ON compliance_runs(created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_compliance_runs_touch') THEN
    CREATE TRIGGER trg_compliance_runs_touch BEFORE UPDATE ON compliance_runs
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;
