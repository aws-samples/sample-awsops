-- since: 2.1.0
-- diagnosis_reports.progress — live per-section progress for AI Diagnosis (기둥 A / V1 parity).
-- Shape: {"current":int,"total":int,"section":"<title>","phase":"collect|render|assemble"}.
-- The worker writes this per section (db.update_progress); the baseline touch_updated_at() BEFORE
-- UPDATE trigger advances updated_at on every write = a heartbeat the reaper uses to detect a dead
-- worker (기둥 B). Forward-only, idempotent. Runner stamps schema_migrations itself — do NOT INSERT here.
ALTER TABLE diagnosis_reports ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;
