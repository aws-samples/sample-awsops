-- Dedicated least-privilege Postgres role for the Steampipe boot-time aws.spc generator (M1 fix
-- — replaces injecting the Aurora master secret into the network-listening Steampipe task). Uses
-- RDS IAM database authentication (rds_iam): no password is ever created or stored anywhere — the
-- Steampipe task's IAM task role generates a short-lived signed auth token at connect time via
-- rds-db:connect, scoped to exactly this dbuser (terraform/foundation/steampipe.tf).
--
-- SELECT-only on the two tables the boot generator actually reads (accounts ⋈ account_regions);
-- no access to any other table, no INSERT/UPDATE/DELETE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'steampipe_reader') THEN
    CREATE ROLE steampipe_reader WITH LOGIN;
  END IF;
END $$;

GRANT rds_iam TO steampipe_reader;
GRANT USAGE ON SCHEMA public TO steampipe_reader;
GRANT SELECT ON accounts, account_regions TO steampipe_reader;
