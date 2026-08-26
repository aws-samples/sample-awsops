-- since: 2.4.0
-- report_schedules — scheduled auto-diagnosis (v1 report-scheduler parity).
-- The table is defined in the frozen schema.sql baseline but had NO migration, so live DBs bootstrapped
-- before it was appended lack the table. Result: the diagnosis schedule UI's GET /api/diagnosis/schedule
-- 500s ("relation report_schedules does not exist") and SchedulePanel renders nothing ("스케줄 안보임").
-- This forward-creates it. Idempotent (IF NOT EXISTS) — a no-op where the table already exists.
-- Read-only-posture metadata table; no AWS mutation. Runner stamps schema_migrations itself — do NOT INSERT.
CREATE TABLE IF NOT EXISTS report_schedules (
  id            BIGSERIAL    PRIMARY KEY,
  user_sub      TEXT         NOT NULL,
  schedule_type TEXT         NOT NULL CHECK (schedule_type IN ('weekly','biweekly','monthly')),
  enabled       BOOLEAN      NOT NULL DEFAULT true,
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ  NOT NULL,
  config        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_schedule UNIQUE (user_sub, schedule_type)
);

CREATE INDEX IF NOT EXISTS idx_schedule_next_run
  ON report_schedules (next_run_at) WHERE enabled = true;

-- updated_at auto-touch. touch_updated_at() is defined in the baseline; guard the trigger create so this
-- migration is idempotent and does not error if the trigger (or table) was already present.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_schedule_touch') THEN
    CREATE TRIGGER trg_schedule_touch BEFORE UPDATE ON report_schedules
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END; $$;
