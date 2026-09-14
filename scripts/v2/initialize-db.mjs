import { sha256 } from './migrate-core.mjs';
import { MigrationError } from './migration-errors.mjs';

// The caller holds migrate.mjs's session advisory lock across this operation
// AND the subsequent ULIDs. A missing ledger alone is never proof of emptiness.
export async function initializeEmptyDatabase(client, schema, appVersion, executeSql = sql => client.query(sql)) {
  const { rows: [state] } = await client.query("SELECT to_regclass('public.schema_migrations') AS ledger");
  if (state.ledger) return false;

  // Namespace dependencies include tables, sequences, views, types, routines,
  // collations and other user objects, including ones invisible to pg_tables.
  const { rows: [stateWithoutLedger] } = await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_namespace n ON n.oid = d.refobjid
    WHERE d.refclassid = 'pg_namespace'::regclass
      AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
    UNION ALL
    SELECT 1 FROM pg_namespace
    WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
    UNION ALL
    SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql'
    UNION ALL
    SELECT 1 FROM pg_foreign_server
    UNION ALL
    SELECT 1 FROM pg_foreign_data_wrapper
    UNION ALL
    SELECT 1 FROM pg_largeobject_metadata
    UNION ALL
    SELECT 1 FROM pg_event_trigger
    UNION ALL
    SELECT 1 FROM pg_publication
    UNION ALL
    SELECT 1 FROM pg_subscription
    WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    UNION ALL
    SELECT 1 FROM pg_default_acl
  ) AS occupied`);
  if (stateWithoutLedger.occupied) {
    throw new MigrationError('Refusing initialization of a non-empty database without schema_migrations');
  }

  // schema.sql is frozen: strip its legacy top-level transaction wrapper only
  // in memory, so every baseline section and the ledger upgrade commit together.
  const wrapper = /^[ \t]*(BEGIN|COMMIT);[ \t]*\r?$/gm;
  const matches = [...schema.matchAll(wrapper)];
  if (matches.length !== 2 || matches[0][1] !== 'BEGIN' || matches[1][1] !== 'COMMIT') {
    throw new MigrationError('Frozen schema must contain exactly one legacy BEGIN then COMMIT wrapper');
  }
  const baseline = schema.replace(wrapper, '');
  await client.query('BEGIN');
  try {
    await executeSql(baseline);
    await client.query('ALTER TABLE public.schema_migrations ALTER COLUMN version TYPE TEXT USING version::text');
    await client.query('ALTER TABLE public.schema_migrations ADD COLUMN checksum TEXT, ADD COLUMN app_version TEXT');
    await client.query(`INSERT INTO public.schema_migrations(version, description, checksum, app_version)
      VALUES ('baseline', 'schema.sql baseline; future migrations are ULID files', $1, $2)`,
    [sha256(schema), appVersion]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
