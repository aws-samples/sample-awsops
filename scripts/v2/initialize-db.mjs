// Caller MUST hold migrate.mjs's advisory lock for baseline + subsequent ULIDs.
// No existing database is ever inferred safe from a missing ledger alone.
import { sha256 } from './migrate-core.mjs';

export async function initializeEmptyDatabase(client, schema, appVersion) {
  const { rows: [state] } = await client.query("SELECT to_regclass('public.schema_migrations') AS ledger");
  if (state.ledger) return false;
  const { rows: [objects] } = await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','p','v','m','S','f')
    UNION ALL
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%'
    UNION ALL
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%'
    UNION ALL
    SELECT 1 FROM pg_namespace
    WHERE nspname NOT IN ('public', 'information_schema') AND nspname NOT LIKE 'pg_%'
  ) AS occupied`);
  if (objects.occupied) throw new Error('Refusing baseline on a non-empty database without schema_migrations');
  // The frozen baseline contains a legacy transaction around v1 only. Enclose
  // ALL baseline sections and the TEXT ledger upgrade in this one transaction.
  const sql = schema.replace(/^\s*(?:BEGIN|COMMIT);\s*$/gm, '');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('ALTER TABLE schema_migrations ALTER COLUMN version TYPE TEXT USING version::text');
    await client.query('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT, ADD COLUMN app_version TEXT');
    await client.query(`INSERT INTO schema_migrations(version, description, app_version, checksum) VALUES ('baseline', 'schema.sql baseline; future migrations are ULID files', $1, $2)`, [appVersion, sha256(schema)]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
