-- since: 2.1.0
-- Follow-up to agent_sql_reader_role (01KYVY9J2E8AMF35WR4J7036A3): that migration's ALTER ROLE
-- deliberately does NOT restate SUPERUSER/REPLICATION/BYPASSRLS on awsops_sql_reader, because
-- PostgreSQL requires the CALLER to itself hold one of those three attributes to set or clear it
-- on another role (only a true superuser is exempt), and the Aurora master user (awsops_admin, a
-- member of rds_superuser but not a real superuser) holds none of them — restating any of the
-- three there failed with "permission denied to alter role" on this project's live cluster.
--
-- That omission is safe for the ordinary path: a role CREATEd fresh gets NOSUPERUSER/
-- NOREPLICATION/NOBYPASSRLS from CREATE ROLE's own defaults, which the omission never touches.
-- This DO block is a one-shot migration-time check: it catches only elevated-attribute drift that
-- existed BEFORE this migration's first apply. The standing check on every `make migrate` lives in
-- syncSqlReaderPassword (scripts/v2/migrate.mjs) and defends against later manual grants, drift, or
-- a future bug. Keep this first-apply check as defense-in-depth: silently proceeding would run the
-- read-only MCP tools against a role that is not actually confined to the sql_reader views.
DO $$
DECLARE
  r record;
BEGIN
  SELECT rolsuper, rolreplication, rolbypassrls INTO r
    FROM pg_roles WHERE rolname = 'awsops_sql_reader';
  IF NOT FOUND THEN
    -- The role absent here almost always means it was manually dropped after 01KYVY9J... applied:
    -- that CREATE ROLE runs unconditionally and precedes this migration by ULID order. See the
    -- runbook's "Role absent" repair procedure; this is not a flag-off case.
    RAISE NOTICE 'awsops_sql_reader is absent; see docs/runbooks/agent-sql-reader.md ("Role absent") '
      'for the new-repair-migration procedure';
    RETURN;
  END IF;
  IF r.rolsuper OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'awsops_sql_reader has an elevated attribute this project''s migrations cannot '
      'revoke (rolsuper=%, rolreplication=%, rolbypassrls=%) — the Aurora master user is not a '
      'real superuser and cannot ALTER ROLE ... NOSUPERUSER/NOREPLICATION/NOBYPASSRLS on a role '
      'that already has one of these set. Fix manually as an actual PostgreSQL superuser (not '
      'available on RDS/Aurora — this may require an AWS-support-assisted role reset). Do NOT drop '
      'and recreate the role expecting `make migrate` to restore it: '
      '01KYVY9J2E8AMF35WR4J7036A3 is already applied and will not re-run, so a naive drop/recreate '
      'loses every grant on the sql_reader views. See docs/runbooks/agent-sql-reader.md ("Role '
      'absent" section) for the new-repair-migration procedure, which starts with '
      '`DROP OWNED BY awsops_sql_reader` before any `DROP ROLE`.',
      r.rolsuper, r.rolreplication, r.rolbypassrls;
  END IF;
END $$;
