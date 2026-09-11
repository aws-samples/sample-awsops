-- since: 2.0.0
-- Durable inventory freshness: keep the latest full-success timestamp/count even though
-- inventory_sync_runs is a singleton current-run ledger row. The opaque per-run token lets a
-- fresh-connection finalizer update only the run that installed the current running state.

ALTER TABLE inventory_sync_runs
  ADD COLUMN IF NOT EXISTS run_token text;

ALTER TABLE inventory_sync_runs
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz;

ALTER TABLE inventory_sync_runs
  ADD COLUMN IF NOT EXISTS last_success_row_count integer;

ALTER TABLE inventory_sync_runs
  DROP CONSTRAINT IF EXISTS inventory_sync_runs_status_check;

ALTER TABLE inventory_sync_runs
  ADD CONSTRAINT inventory_sync_runs_status_check
  CHECK (status IN ('running', 'succeeded', 'failed', 'partial'));

UPDATE inventory_sync_runs
SET last_success_at = COALESCE(last_success_at, finished_at),
    last_success_row_count = COALESCE(last_success_row_count, row_count)
WHERE status = 'succeeded';

-- The model-invocable reader gets explicit operational metadata only. In particular, the
-- arbitrary provider/SDK error text remains excluded.
DROP VIEW IF EXISTS sql_reader.inventory_sync_runs;

CREATE VIEW sql_reader.inventory_sync_runs
WITH (security_invoker = false) AS
SELECT resource_type,
       account_id,
       started_at,
       finished_at,
       status,
       row_count,
       last_success_at,
       last_success_row_count
FROM public.inventory_sync_runs;

GRANT SELECT ON sql_reader.inventory_sync_runs TO awsops_sql_reader;
