-- Dedicated Postgres role for the worker/incident Lambdas + the Fargate worker, using RDS IAM
-- database authentication (rds_iam) instead of the Aurora master secret. scripts/v2/workers/db.py
-- (shared by dispatcher/handlers/reaper/status_updater/worker_lambda/fargate_worker, and reused via
-- `import db` by scripts/v2/incident/*.py and scripts/v2/remediation/*.py) cached the master
-- secret's password in a module-level dict with no TTL/expiry (`_secret_cache`). RDS auto-rotates
-- that secret every 7 days; a Lambda execution environment kept warm across a rotation event kept
-- using the stale cached password and failed every subsequent invocation with "password
-- authentication failed" until AWS happened to recycle that specific warm container. Mirrors
-- awsops_web (see that migration) and steampipe_reader — same fix, same shape.
--
-- These Lambdas/the Fargate worker currently run AS THE MASTER USER (full DDL+DML) via the cached
-- secret, so this role is a privilege REDUCTION (CRUD only, no DDL), not a widening. Broad grant
-- rather than per-table, for the same pragmatic reason as awsops_web: ~20 tables span worker_jobs,
-- ai_insights, datasource_diag_signals, compliance_runs/results, ai_usage_daily, diagnosis_reports,
-- incidents and its incident_* satellites, action_catalog, prevention_*, feature_flags,
-- report_schedules, integrations, datasource_schemas, inventory_resources, agents. Narrowing to
-- per-table grants is a follow-up, not blocking.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'awsops_worker') THEN
    CREATE ROLE awsops_worker WITH LOGIN;
  END IF;
END $$;

GRANT rds_iam TO awsops_worker;
GRANT USAGE ON SCHEMA public TO awsops_worker;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO awsops_worker;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO awsops_worker;
-- Future migrations run as awsops_admin (the master user) — extend the same grants to any table/
-- sequence they create, so awsops_worker doesn't need a follow-up migration per schema change.
ALTER DEFAULT PRIVILEGES FOR ROLE awsops_admin IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO awsops_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE awsops_admin IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO awsops_worker;
