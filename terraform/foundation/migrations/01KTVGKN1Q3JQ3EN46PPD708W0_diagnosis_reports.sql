-- since: 2.1.0
-- diagnosis_reports — AI Diagnosis (AI 종합진단) report metadata (Plan 1).
-- The large markdown artifact lives in S3 (artifact_uri); summary is a small inline JSONB
-- for list/cards. Linked 1:1 to the worker job that produced it. parent_report_id =
-- Plan 2 diff lineage. FK → worker_jobs (baseline schema.sql) + touch_updated_at() (baseline).
-- NOTE: the runner stamps schema_migrations itself — do NOT INSERT it here.
CREATE TABLE IF NOT EXISTS diagnosis_reports (
  id              BIGSERIAL    PRIMARY KEY,
  worker_job_id   UUID         REFERENCES worker_jobs(job_id),
  parent_report_id BIGINT      REFERENCES diagnosis_reports(id),
  tier            TEXT         NOT NULL DEFAULT 'mid'
                    CHECK (tier IN ('light','mid','deep')),
  status          TEXT         NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','succeeded','failed','partial')),
  requested_by    TEXT         NOT NULL,
  sources_used    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  summary         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  artifact_uri    TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_diagnosis_reports_created ON diagnosis_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnosis_reports_status ON diagnosis_reports(status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_diagnosis_reports_touch') THEN
    CREATE TRIGGER trg_diagnosis_reports_touch BEFORE UPDATE ON diagnosis_reports
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;
