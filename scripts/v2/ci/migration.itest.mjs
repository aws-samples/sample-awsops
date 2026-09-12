// Explicit integration test: uses only a disposable local PostgreSQL 17 container.
// Run from repo root: node scripts/v2/ci/migration.itest.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { initializeEmptyDatabase } from '../initialize-db.mjs';
import { migrateDatabase } from '../migrate.mjs';
import { sha256 } from '../migrate-core.mjs';

const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
// Loopback-only ephemeral port, tmpfs data and no AWS credentials or volumes.
let id;
try {
  id = docker(['run', '--rm', '-d', '--pull=never', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=awsops_admin',
    '-p', '127.0.0.1::5432', 'postgres:17-alpine']);
  const port = Number(docker(['port', id, '5432/tcp']).split(':').at(-1));
  const connection = database => new pg.Client({ host: '127.0.0.1', port, user: 'awsops_admin', database });
  let admin;
  for (let attempt = 0; attempt < 50; attempt++) {
    admin = connection('postgres');
    try { await admin.connect(); break; } catch { await admin.end(); await new Promise(r => setTimeout(r, 100)); }
  }
  await admin.query('CREATE ROLE rds_iam');
  for (const database of ['awsops', 'occupied', 'broken']) await admin.query(`CREATE DATABASE ${database}`);
  const schema = readFileSync('terraform/foundation/data/schema.sql', 'utf8');
  const occupied = connection('occupied'); await occupied.connect();
  await occupied.query("CREATE FUNCTION marker() RETURNS int LANGUAGE sql AS 'SELECT 1'");
  await assert.rejects(initializeEmptyDatabase(occupied, schema, 'test'), /non-empty/);
  assert.equal((await occupied.query("SELECT to_regclass('schema_migrations') AS ledger")).rows[0].ledger, null);
  await occupied.end();
  const broken = connection('broken'); await broken.connect();
  await assert.rejects(initializeEmptyDatabase(broken, `${schema}\nSELECT nonexistent_function();`, 'test'));
  assert.equal((await broken.query("SELECT to_regclass('schema_migrations') AS ledger")).rows[0].ledger, null);
  await broken.end();

  process.env.INITIALIZE_EMPTY_DB = '1';
  process.env.AURORA_SECRET_ARN = 'integration-test-no-network';
  process.env.SQL_READER_SECRET_ARN = '';
  process.env.SQL_READER_SYNC_MODE = 'disabled';
  await migrateDatabase(connection('awsops'));
  const db = connection('awsops'); await db.connect();
  const first = (await db.query('SELECT version, checksum, app_version, applied_at FROM schema_migrations ORDER BY version')).rows;
  const migrationCount = readdirSync('terraform/foundation/migrations').filter(name => name.endsWith('.sql')).length;
  assert.equal(first.filter(row => row.version.length === 26).length, migrationCount);
  assert.equal(first.find(row => row.version === 'baseline').checksum, sha256(schema));
  assert.ok(first.filter(row => row.version.length === 26).every(row => /^[a-f0-9]{64}$/.test(row.checksum)));
  await migrateDatabase(connection('awsops'));
  assert.deepEqual((await db.query('SELECT version, checksum, app_version, applied_at FROM schema_migrations ORDER BY version')).rows, first);

  // Real advisory lock serializes runners; releasing it lets a queued run finish.
  await db.query('SELECT pg_advisory_lock(4729411)');
  let finished = false;
  const pending = migrateDatabase(connection('awsops')).then(() => { finished = true; });
  await new Promise(r => setTimeout(r, 200)); assert.equal(finished, false);
  await db.query('SELECT pg_advisory_unlock(4729411)'); await pending;
  const ulid = first.find(row => row.version.length === 26).version;
  await db.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', ['corrupt', ulid]);
  await assert.rejects(migrateDatabase(connection('awsops')), /checksum drift/);
  assert.equal((await db.query('SELECT pg_try_advisory_lock(4729411) AS unlocked')).rows[0].unlocked, true);
  await db.query('SELECT pg_advisory_unlock(4729411)');
  await db.end(); await admin.end();
  console.log(`PASS: empty baseline + ${migrationCount} ULIDs, rerun, rollback, occupied DB, lock serialization and checksum drift`);
} finally {
  if (id) docker(['rm', '-f', id]);
}
