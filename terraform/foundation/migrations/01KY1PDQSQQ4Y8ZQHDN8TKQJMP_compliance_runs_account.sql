-- Multi-account benchmark scoping (v1 parity: powerpipe --search-path per account).
-- 'all' = aggregator scope (every connection merged — the previous implicit behavior);
-- a 12-digit id = that account's Steampipe connection (aws_<id>) only.
ALTER TABLE compliance_runs
  ADD COLUMN IF NOT EXISTS account TEXT NOT NULL DEFAULT 'all';
