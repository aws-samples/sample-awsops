-- since: 2.2.0
-- diagnosis_reports.model — Bedrock model used for the report. Deep tier may select 'opus';
-- light/mid are always 'sonnet'. NULL (pre-existing rows / legacy enqueue) is read as 'sonnet'.
-- Display metadata only — the parent_report_id diff lineage stays keyed on tier, not model.
-- Read-only posture: this column records which model rendered a read-only report; no AWS mutation.
-- Forward-only, idempotent. Runner stamps schema_migrations itself — do NOT INSERT here.
ALTER TABLE diagnosis_reports ADD COLUMN IF NOT EXISTS model text;
