-- since: 2.0.0
-- diagnosis_reports.notified_at — tracks whether a completed report has been folded into a
-- diagnosis-notify digest email yet. NULL = not yet notified. Replaces the prior "publish on every
-- completion" SNS trigger (handlers.py) with a periodic digest Lambda that batches everything with
-- notified_at IS NULL into one email, then stamps notified_at. Existing rows stay NULL — harmless;
-- the digest Lambda's first run just picks up whatever backlog exists and clears it.
ALTER TABLE diagnosis_reports ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
