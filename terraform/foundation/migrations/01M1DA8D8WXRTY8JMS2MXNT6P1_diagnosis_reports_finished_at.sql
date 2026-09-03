-- diagnosis_reports.finished_at: terminal-write timestamp stamped by the worker's
-- finish_report() (succeeded/partial/failed alike). Drives the completed-report elapsed stat
-- (gap-audit L176) — updated_at can't serve that role because the touch trigger also advances
-- it on later title/tag edits and on every progress heartbeat. NULL on legacy rows → the UI
-- omits the duration segment (honest-degrade, never fabricated).
-- (No `-- since:` header on purpose: the runner stamps the deploying app's version — the
-- FinOps migrations' stale-header lesson.)
ALTER TABLE diagnosis_reports ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
