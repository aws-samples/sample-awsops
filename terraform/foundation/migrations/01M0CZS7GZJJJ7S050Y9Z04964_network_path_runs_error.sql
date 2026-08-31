-- since: 2.2.0
-- MINOR fix (pr-review round 2): network_path._finish_run() never persisted error text on a
-- failed run — network_path_runs had no column to hold it, so the UI/API had no way to show WHY a
-- run failed (e.g. the honest "fetch_live_topology is not implemented" message). Nullable, never
-- backfilled (existing failed rows simply keep error=NULL).

ALTER TABLE network_path_runs ADD COLUMN IF NOT EXISTS error text;
