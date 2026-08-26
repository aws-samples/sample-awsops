-- Dedicated Postgres role for the web BFF, using RDS IAM database authentication (rds_iam) instead
-- of the Aurora master secret. The master secret is RDS-managed and auto-rotates every 7 days
-- (manage_master_user_password=true); the long-running web ECS task only reads AURORA_PASSWORD
-- once at container start (secrets/valueFrom), so a later rotation leaves it holding a stale
-- password until the task is replaced — every Postgres-backed route then fails with
-- "password authentication failed for user awsops_admin" until a redeploy happens to land. This
-- role removes the password dependency entirely (mirrors steampipe_reader — see that migration).
--
-- Unlike steampipe_reader (SELECT-only on 2 tables), the web app needs broad CRUD across the
-- schema — it currently runs as the master user. Grant matching effective access without DDL
-- (schema changes stay on the master user via `make migrate`).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'awsops_web') THEN
    CREATE ROLE awsops_web WITH LOGIN;
  END IF;
END $$;

GRANT rds_iam TO awsops_web;
GRANT USAGE ON SCHEMA public TO awsops_web;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO awsops_web;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO awsops_web;
-- Future migrations run as awsops_admin (the master user) — extend the same grants to any table/
-- sequence they create, so awsops_web doesn't need a follow-up migration per schema change.
ALTER DEFAULT PRIVILEGES FOR ROLE awsops_admin IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO awsops_web;
ALTER DEFAULT PRIVILEGES FOR ROLE awsops_admin IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO awsops_web;
