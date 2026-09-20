-- since: 2.0.0
-- Attribute-level steady-state denials (an SCP-denied bucket's PAB/policy-status/versioning/
-- encryption/logging read) leave those security fields NULL without failing the run, so the run
-- can finalize succeeded while part of it went blind. This column discloses how many attribute
-- reads were blind, letting readers degrade the reported freshness without blocking stale-row
-- pruning or the durable last_success_at.

ALTER TABLE inventory_sync_runs
  ADD COLUMN IF NOT EXISTS unknown_attribute_count integer;

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
       last_success_row_count,
       unknown_attribute_count
FROM public.inventory_sync_runs;

GRANT SELECT ON sql_reader.inventory_sync_runs TO awsops_sql_reader;
