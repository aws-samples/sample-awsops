-- since: 2.3.0
-- diagnosis_reports metadata: title (LLM auto key-insight, user-editable), tags (auto-suggested +
-- manual), deleted_at (soft delete — orthogonal to status; a report in any terminal state can be
-- hidden, S3 artifacts retained, recoverable). Read-only posture: metadata on a read-only report;
-- no AWS mutation. Forward-only, idempotent. Runner stamps schema_migrations itself — do NOT INSERT.
ALTER TABLE diagnosis_reports
  ADD COLUMN IF NOT EXISTS title      text,
  ADD COLUMN IF NOT EXISTS tags       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
