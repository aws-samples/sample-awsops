-- Per-account flag meaning "scan every region" (Steampipe regions=["*"]). A '*' value is invalid
-- for account_regions.region (CHECK rejects it), so the flag lives on accounts.
-- DEFAULT false (M1): adding this column must NOT flip accounts that already chose explicit regions
-- (PR #108/#109 selector) into unbounded all-region scans, and there is no all_regions toggle UI yet.
-- false → listScanScope() uses the account's explicit enabled account_regions; opt into all-region
-- scanning explicitly (set all_regions=true) once a toggle ships.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS all_regions boolean NOT NULL DEFAULT false;
-- The HOST always scans every region (v1 parity) and has no account_regions rows; backfill any
-- EXISTING host row to all_regions=true (ensureHostRow's ON CONFLICT DO NOTHING never updates it),
-- so listScanScope()/render_spc don't skip the host and empty the inventory.
UPDATE accounts SET all_regions = true WHERE is_host;
