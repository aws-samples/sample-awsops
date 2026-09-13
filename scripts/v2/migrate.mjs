#!/usr/bin/env node
// Collision-free, checksum-verified, advisory-locked migrations.
// make migrate / BOOTSTRAP=1 make migrate retain the Terraform-output CLI mode.
// --status and DRY_RUN=1 OFFLINE=1 never need credentials or a database.
// Fargate uses explicit AURORA_* settings, Secrets Manager in memory, verified
// RDS TLS, and INITIALIZE_EMPTY_DB=1 for safe first installation.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { hasRuntimeDatabaseConfig, sqlReaderConfiguration } from './sql-reader-config.mjs';
import { initializeEmptyDatabase } from './initialize-db.mjs';
import {
  MigrationError, databaseFailure, diagnosticCodes, secretFailure,
  readSecretForPurpose, terraformFailure,
} from './migration-errors.mjs';
import {
  parseMigrationFile, computePending, sha256, findDuplicateIds, hasNoTxnFlag,
  parseSinceHeader, resolveAppVersion,
} from './migrate-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG_DIR = join(ROOT, 'terraform/foundation/migrations');
const SCHEMA = join(ROOT, 'terraform/foundation/data/schema.sql');
const LOCK_KEY = 4729411; // unchanged: serializes old CLI and new runtime runners

function tf(output) {
  try {
    return execFileSync('terraform', ['-chdir=terraform/foundation', 'output', '-raw', output], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw terraformFailure(output, error);
  }
}

function appVersion(env) {
  let pkg = '';
  try { pkg = readFileSync(join(ROOT, 'web/package.json'), 'utf8'); } catch { /* offline fallback */ }
  return resolveAppVersion(env.APP_VERSION, pkg);
}

function loadMigrations(directory) {
  if (!existsSync(directory)) throw new MigrationError('Migration directory missing; check the runtime image assets');
  const files = readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
  const duplicates = findDuplicateIds(files);
  if (duplicates.length) throw new MigrationError(`duplicate migration id(s): ${duplicates.join(', ')} — ids must be unique (ULID)`);
  const badNames = files.filter(file => !parseMigrationFile(file));
  if (badNames.length) throw new MigrationError(`malformed migration filename(s) (need <ULID>_<name>.sql): ${badNames.join(', ')}`);
  return files.map(file => {
    const sql = readFileSync(join(directory, file), 'utf8');
    return { ...parseMigrationFile(file), file, sql, since: parseSinceHeader(sql) };
  });
}

export async function readJsonSecret(arn, secrets) {
  let result;
  try {
    result = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  } catch (error) {
    // SDK/JSON parser errors can contain the response body. Never log those.
    throw secretFailure('Migration credential read', error);
  }
  try {
    if (typeof result.SecretString !== 'string') throw new Error();
    const secret = JSON.parse(result.SecretString);
    if (!secret || typeof secret !== 'object' || Array.isArray(secret)) throw new Error();
    return secret;
  } catch {
    throw new MigrationError('Secret must contain a JSON object in SecretString');
  }
}

export async function loadCredentials(env, { readSecret, terraformOutput = tf }) {
  const runtime = hasRuntimeDatabaseConfig(env);
  if (runtime) {
    for (const name of ['AWS_REGION', 'AURORA_ENDPOINT', 'AURORA_DATABASE', 'AURORA_SECRET_ARN']) {
      if (!env[name]?.trim()) throw new MigrationError(`Runtime migration requires ${name}`);
    }
  }
  const arn = runtime ? env.AURORA_SECRET_ARN.trim() : terraformOutput('aurora_secret_arn');
  const host = runtime ? env.AURORA_ENDPOINT.trim() : terraformOutput('aurora_endpoint');
  // node-pg treats a slash-prefixed host as a Unix socket and bypasses TLS.
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) {
    throw new MigrationError('Aurora endpoint must be a DNS hostname');
  }
  const secret = await readSecretForPurpose(readSecret, arn, 'Aurora master credentials');
  if (!secret || typeof secret.username !== 'string' || !secret.username.trim()
    || typeof secret.password !== 'string' || !secret.password) {
    throw new MigrationError('Aurora secret requires nonempty username and password strings');
  }
  return {
    host, user: secret.username, password: secret.password,
    database: runtime ? env.AURORA_DATABASE.trim() : 'awsops', port: 5432,
    ssl: {
      rejectUnauthorized: true, servername: host,
      ca: readFileSync(join(ROOT, 'scripts/v2/eks/rds-ca-bundle.pem'), 'utf8'),
    },
  };
}

async function syncSqlReaderPassword(client, configuration, readSecret, logger) {
  const { rows: [role] } = await client.query(
    `SELECT rolsuper, rolreplication, rolbypassrls FROM pg_roles WHERE rolname='awsops_sql_reader'`,
  );
  if (role && (role.rolsuper || role.rolreplication || role.rolbypassrls)) {
    throw new MigrationError('sql-reader: awsops_sql_reader has elevated attributes '
      + `(rolsuper=${role.rolsuper === true}, rolreplication=${role.rolreplication === true}, rolbypassrls=${role.rolbypassrls === true}); `
      + 'the Aurora master cannot revoke them. See docs/runbooks/agent-sql-reader.md.');
  }
  if (configuration.mode === 'disabled') {
    logger.log('sql-reader: password sync disabled');
    return;
  }
  if (!role) throw new MigrationError('sql-reader sync enabled but awsops_sql_reader is missing; apply its migration first');
  const secret = await readSecretForPurpose(readSecret, configuration.arn, 'SQL-reader password synchronization');
  if (secret?.username !== 'awsops_sql_reader' || typeof secret.password !== 'string' || !secret.password) {
    throw new MigrationError('SQL-reader secret requires username awsops_sql_reader and a nonempty password string');
  }
  // ALTER ROLE has no bind parameters. Use pg's literal escaper; never log the
  // statement or a server error that might reproduce its password literal.
  try {
    await client.query(`ALTER ROLE awsops_sql_reader WITH PASSWORD ${client.escapeLiteral(secret.password)}`);
  } catch (error) {
    throw databaseFailure('sql-reader: password synchronization failed', error);
  }
  logger.log('sql-reader: password synced from Secrets Manager');
}

// Owns the supplied (unconnected) client's lifecycle. Production uses the same
// function as disposable-PostgreSQL tests; only credential transport is external.
export async function migrateDatabase(client, {
  env = process.env, migrationDir = MIG_DIR, logger = console,
  readSecret, terraformOutput = tf,
} = {}) {
  const dry = env.DRY_RUN === '1';
  const initialize = env.INITIALIZE_EMPTY_DB === '1';
  const version = appVersion(env);
  let locked = false;
  let operation = 'Prepare migrations';
  const notice = message => logger.log(`  [db] notice (${diagnosticCodes(message)})`);
  try {
    if (initialize && dry) throw new MigrationError('INITIALIZE_EMPTY_DB cannot be combined with DRY_RUN');
    const migrations = loadMigrations(migrationDir);
    let reader = sqlReaderConfiguration(env);
    if (!dry && reader.mode === 'terraform') {
      // Missing output is an error. The defined empty output is the only
      // Terraform indication that AgentCore/reader synchronization is disabled.
      const arn = terraformOutput('agent_sql_reader_secret_arn');
      reader = arn ? { mode: 'secret', arn } : { mode: 'disabled' };
    }
    client.on('notice', notice);
    operation = 'Connect to Aurora';
    await client.connect();
    operation = 'Acquire migration advisory lock';
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;
    if (initialize) {
      operation = 'Initialize empty database';
      const initialized = await initializeEmptyDatabase(client, readFileSync(SCHEMA, 'utf8'), version);
      if (initialized) logger.log('initialized empty database from frozen baseline');
    }

    operation = 'Read migration ledger';
    const { rows: columns } = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='schema_migrations'`,
    );
    const versionType = columns.find(column => column.column_name === 'version')?.data_type;
    if (!versionType) throw new MigrationError('schema_migrations missing; INITIALIZE_EMPTY_DB=1 is required for an empty database');
    const hasChecksum = columns.some(column => column.column_name === 'checksum');
    const { rows: appliedRows } = await client.query(
      hasChecksum ? 'SELECT version, checksum FROM public.schema_migrations'
        : 'SELECT version, NULL AS checksum FROM public.schema_migrations',
    );
    const applied = new Map(appliedRows.map(row => [String(row.version), row.checksum ?? null]));
    const pending = computePending(migrations.map(migration => migration.id), [...applied.keys()]);

    // Check before any ledger alteration or password synchronization.
    const baselineChecksum = applied.get('baseline');
    if (baselineChecksum != null && baselineChecksum !== sha256(readFileSync(SCHEMA, 'utf8'))) {
      throw new MigrationError('checksum drift: applied baseline differs from frozen schema.sql — baseline is immutable');
    }
    for (const migration of migrations) {
      const recorded = applied.get(migration.id);
      if (recorded !== undefined && recorded !== null && recorded !== sha256(migration.sql)) {
        throw new MigrationError(`checksum drift: applied migration ${migration.id} (${migration.file}) was edited after apply — migrations are immutable`);
      }
    }

    if (versionType === 'integer' && pending.length > 0) {
      if (env.BOOTSTRAP !== '1') {
        throw new MigrationError('schema_migrations.version is INTEGER but ULID migrations are pending. '
          + 'Bootstrap required (controller-confirmed, coordinated quiet window): BOOTSTRAP=1 make migrate');
      }
      logger.log('[bootstrap] ALTER version to TEXT + metadata + baseline marker');
      if (!dry) {
        try {
          await client.query('BEGIN');
          await client.query('ALTER TABLE public.schema_migrations ALTER COLUMN version TYPE TEXT USING version::text');
          await client.query('ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
          await client.query('ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS app_version TEXT');
          await client.query(`INSERT INTO public.schema_migrations(version, applied_at, description, app_version)
            VALUES ('baseline', now(), 'schema.sql baseline; future migrations are ULID files', $1)
            ON CONFLICT (version) DO NOTHING`, [version]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw databaseFailure('bootstrap failed (rolled back to INTEGER)', error);
        }
      }
    } else if (!dry && pending.length > 0) {
      operation = 'Upgrade migration ledger metadata';
      await client.query('ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
      await client.query('ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS app_version TEXT');
    }

    operation = 'Validate and synchronize sql-reader';
    if (pending.length === 0) {
      logger.log('up to date — no pending migrations');
      if (!dry) await syncSqlReaderPassword(client, reader, readSecret, logger);
      return;
    }
    logger.log(`pending (${pending.length}): ${pending.join(', ')}`);
    for (const id of pending) {
      const migration = migrations.find(entry => entry.id === id);
      if (dry) { logger.log(`\n--- ${migration.file} ---\n${migration.sql}`); continue; }
      const noTransaction = hasNoTxnFlag(migration.sql);
      try {
        if (!noTransaction) await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(`INSERT INTO public.schema_migrations(version, applied_at, description, checksum, app_version)
          VALUES ($1, now(), $2, $3, $4)`,
        [migration.id, migration.name, sha256(migration.sql), migration.since ?? version]);
        if (!noTransaction) await client.query('COMMIT');
        logger.log(`  applied ${migration.file}`);
      } catch (error) {
        if (!noTransaction) await client.query('ROLLBACK').catch(() => {});
        throw databaseFailure(`migration ${migration.file} failed (${noTransaction ? 'non-transactional; inspect partial changes' : 'rolled back'})`, error);
      }
    }
    if (!dry) await syncSqlReaderPassword(client, reader, readSecret, logger);
    logger.log(dry ? `preview only — ${pending.length} migration(s) pending, nothing applied`
      : `applied ${pending.length} migration(s)`);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw databaseFailure(`${operation} failed`, error);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.removeListener('notice', notice);
    await client.end().catch(() => {});
  }
}

async function cli() {
  const env = process.env;
  const migrations = loadMigrations(MIG_DIR);
  const version = appVersion(env);
  if (process.argv.includes('--status') || env.STATUS === '1') {
    console.log(`app version: ${version}\nmigration files (${migrations.length}):`);
    for (const migration of migrations) {
      console.log(`  ${migration.file}  — release ${migration.since ?? `${version} (apply-time default; no -- since: header)`}`);
    }
    console.log('\n(applied vs pending against the live DB: `DRY_RUN=1 make migrate`)');
    return;
  }
  if (env.DRY_RUN === '1' && env.OFFLINE === '1') {
    console.log(`migrations dir: ${MIG_DIR}\nfiles (${migrations.length}): ${migrations.map(migration => migration.file).join(', ')}`);
    for (const migration of migrations) console.log(`\n--- ${migration.file} ---\n${migration.sql}`);
    return;
  }
  if (!migrations.length && env.INITIALIZE_EMPTY_DB !== '1') {
    console.log('migrate: no migration files — nothing to do');
    return;
  }
  if (env.INITIALIZE_EMPTY_DB === '1' && env.DRY_RUN === '1') {
    throw new MigrationError('INITIALIZE_EMPTY_DB cannot be combined with DRY_RUN');
  }
  sqlReaderConfiguration(env); // reject runtime ambiguity before fetching any secret
  const secrets = new SecretsManagerClient({ region: env.AWS_REGION || 'ap-northeast-2' });
  const readSecret = arn => readJsonSecret(arn, secrets);
  try {
    const client = new pg.Client({
      ...await loadCredentials(env, { readSecret }),
      connectionTimeoutMillis: 30_000, statement_timeout: 300_000, lock_timeout: 30_000,
    });
    await migrateDatabase(client, { env, readSecret });
  } finally { secrets.destroy(); }
}

function isMain() {
  try {
    return Boolean(process.argv[1])
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; } // imports can have no entry path (or a synthetic one)
}

if (isMain()) {
  cli().catch(error => {
    console.error(error instanceof MigrationError ? error.message
      : databaseFailure('Migration runtime failed', error).message);
    process.exitCode = 1;
  });
}
