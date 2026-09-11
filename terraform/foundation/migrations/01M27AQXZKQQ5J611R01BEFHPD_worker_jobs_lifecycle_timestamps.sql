-- since: 0.9.0
-- Worker lifecycle evidence only: no defaults or historical timestamp backfill.
-- First successful claim -> final terminal write includes retries and retry delays,
-- not CPU execution time. A failure before any claim has no started_at.
-- The trigger owns timing so workers deployed BEFORE this migration still operate.
ALTER TABLE worker_jobs
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;

COMMENT ON COLUMN worker_jobs.started_at IS
  'First successful worker claim; NULL when never claimed or historically unknown. Preserved across retries.';
COMMENT ON COLUMN worker_jobs.finished_at IS
  'Authoritative terminal status write; NULL while unfinished or historically unknown. Lifecycle elapsed time includes retries, not CPU execution time.';

CREATE OR REPLACE FUNCTION stamp_worker_job_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  terminal_states constant text[] := ARRAY['succeeded', 'failed', 'canceled', 'manual_intervention'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only a newly observed running/terminal INSERT is evidence of those events.
    -- Ordinary queued INSERTs keep both timestamps unknown.
    NEW.started_at := CASE WHEN NEW.status = 'running' THEN clock_timestamp() ELSE NULL END;
    NEW.finished_at := CASE WHEN NEW.status = ANY(terminal_states) THEN clock_timestamp() ELSE NULL END;
    RETURN NEW;
  END IF;

  -- Never replace an observed first start or infer it from updated_at. A row already
  -- running at migration time has an unknown first start, even if attempt was zero.
  NEW.started_at := OLD.started_at;
  IF OLD.started_at IS NULL
     AND OLD.status = 'queued' AND OLD.attempt = 0
     AND NEW.status = 'running' THEN
    NEW.started_at := clock_timestamp();
  END IF;

  NEW.finished_at := OLD.finished_at;
  IF NEW.status = ANY(terminal_states) THEN
    IF NOT (OLD.status = ANY(terminal_states)) THEN
      NEW.finished_at := clock_timestamp();
    END IF;
    -- Duplicate terminal writes preserve even NULL historical finish times.
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.attempt > OLD.attempt THEN
    -- Reflect an explicit retry/active transition; never initiate or authorize one.
    NEW.finished_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- The migration owner installs the trigger; app writers do not need permission
-- to call this function directly. Keep it out of the SQL reader's callable surface.
REVOKE EXECUTE ON FUNCTION stamp_worker_job_lifecycle() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_worker_jobs_lifecycle ON worker_jobs;
CREATE TRIGGER trg_worker_jobs_lifecycle
BEFORE INSERT OR UPDATE ON worker_jobs
FOR EACH ROW EXECUTE FUNCTION stamp_worker_job_lifecycle();

-- Append only operational timing to the existing explicit-column reader view.
-- CREATE OR REPLACE retains its SELECT grant and owner-privilege access to the
-- base table. No table/column privilege in public is granted to the SQL reader.
CREATE OR REPLACE VIEW sql_reader.worker_jobs
WITH (security_invoker = false) AS
SELECT job_id, type, runtime, status, artifact_uri, dry_run, idempotency_key, attempt,
       sfn_execution_arn, created_at, updated_at, started_at, finished_at
FROM public.worker_jobs;
