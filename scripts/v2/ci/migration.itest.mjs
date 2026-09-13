// Run directly or with node --test. Exercises migrate.mjs itself, not a SQL replay.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as runner from '../migrate.mjs';
import { disposablePostgres, waitForQuery } from './postgres-test-fixture.mjs';

const root = new URL('../../../', import.meta.url);
const schema = readFileSync(new URL('terraform/foundation/data/schema.sql', root), 'utf8');
const migrationDirectory = new URL('terraform/foundation/migrations/', root);
const migrationFiles = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort();
const hash = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const env = { INITIALIZE_EMPTY_DB: '1', SQL_READER_SYNC_MODE: 'disabled' };
const forbiddenExternal = () => assert.fail('this run must not access Terraform or AWS');
const silent = { log() {} };
let postgres;
before(async () => { postgres = await disposablePostgres(); });
after(async () => { await postgres?.close(); });

const run = (database, options = {}, clientOptions = {}) => runner.migrateDatabase(postgres.client(database, clientOptions), {
  env, logger: silent, readSecret: forbiddenExternal, terraformOutput: forbiddenExternal, ...options,
});
async function inspect(database, fn) {
  const db = postgres.client(database);
  await db.connect();
  try { return await fn(db); } finally { await db.end(); }
}
const ledger = db => db.query('SELECT * FROM schema_migrations ORDER BY version').then(result => result.rows);
const testId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

test('the real runner initializes the frozen baseline, stamps all ULIDs, and reruns unchanged', async () => {
  const database = await postgres.database();
  await run(database);
  const first = await inspect(database, ledger);
  assert.equal(first.length, migrationFiles.length + 10);
  assert.equal(first.find(row => row.version === 'baseline').checksum, hash(schema));
  for (const file of migrationFiles) {
    const row = first.find(entry => entry.version === file.split('_')[0]);
    const sql = readFileSync(new URL(file, migrationDirectory), 'utf8');
    assert.equal(row?.checksum, hash(sql), file);
    const declaredVersion = /^\s*--\s*since:\s*(\S+)/im.exec(sql)?.[1];
    if (declaredVersion) assert.equal(row.app_version, declaredVersion, file);
  }
  await run(database);
  assert.deepEqual(await inspect(database, ledger), first);
});

test('an existing integer ledger still requires BOOTSTRAP; conversion remains rerunnable', async () => {
  const database = await postgres.database();
  await inspect(database, db => db.query(schema));
  await assert.rejects(run(database), /BOOTSTRAP/);
  await inspect(database, async db => {
    assert.equal((await db.query("SELECT data_type FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='version'")).rows[0].data_type, 'integer');
  });
  await run(database, { env: { ...env, BOOTSTRAP: '1' } });
  const first = await inspect(database, ledger);
  await run(database);
  assert.deepEqual(await inspect(database, ledger), first);
});

test('initialization cannot be combined with online dry-run, and does not write a ledger', async () => {
  const database = await postgres.database();
  await assert.rejects(run(database, { env: { ...env, DRY_RUN: '1' } }), /DRY_RUN/);
  await inspect(database, async db => {
    assert.equal((await db.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0].ledger, null);
  });
});

test('both first-run initialization and ULIDs wait behind the same advisory lock', async () => {
  const database = await postgres.database();
  await inspect(database, async blocker => {
    await blocker.query('SELECT pg_advisory_lock(4729411)');
    const result = run(database, {}, { application_name: 'waiting-initializer' });
    try {
      await waitForQuery(blocker, "SELECT wait_event FROM pg_stat_activity WHERE application_name='waiting-initializer'",
        rows => rows.some(row => row.wait_event === 'advisory'));
      assert.equal((await blocker.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0].ledger, null);
    } finally { await blocker.query('SELECT pg_advisory_unlock(4729411)'); }
    await result;
    assert.equal((await ledger(blocker)).length, migrationFiles.length + 10);
  });
});

test('concurrent initializers apply each migration once', async () => {
  const database = await postgres.database();
  await Promise.all([run(database), run(database)]);
  assert.equal((await inspect(database, ledger)).length, migrationFiles.length + 10);
});

test('the migration lock stays held after the baseline commits and until ULIDs finish', async () => {
  const database = await postgres.database();
  const directory = mkdtempSync(join(tmpdir(), 'awsops-lock-test-'));
  writeFileSync(join(directory, `${testId}_lock.sql`),
    'SELECT pg_advisory_lock(4729412); SELECT pg_advisory_unlock(4729412); CREATE TABLE lock_marker(id int);');
  try {
    await inspect(database, async observer => {
      await observer.query('SELECT pg_advisory_lock(4729412)');
      const first = run(database, { migrationDir: directory }, { application_name: 'first-lock-runner' });
      let second;
      try {
        await waitForQuery(observer, "SELECT wait_event FROM pg_stat_activity WHERE application_name='first-lock-runner'",
          rows => rows.some(row => row.wait_event === 'advisory'));
        assert.equal((await observer.query("SELECT version FROM schema_migrations WHERE version='baseline'")).rowCount, 1);
        assert.equal((await observer.query(`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON l.pid=a.pid
          WHERE a.application_name='first-lock-runner' AND l.locktype='advisory' AND l.objid=4729411 AND l.granted`)).rowCount, 1);
        second = run(database, { migrationDir: directory }, { application_name: 'second-lock-runner' });
        await waitForQuery(observer, `SELECT l.objid FROM pg_locks l JOIN pg_stat_activity a ON l.pid=a.pid
          WHERE a.application_name='second-lock-runner' AND l.locktype='advisory' AND NOT l.granted`,
        rows => rows.some(row => row.objid === 4729411));
      } finally {
        await observer.query('SELECT pg_advisory_unlock(4729412)');
        await Promise.all([first, second]);
      }
      assert.equal((await observer.query('SELECT 1 FROM schema_migrations WHERE version=$1', [testId])).rowCount, 1);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('legacy ledger conversion rolls back atomically when baseline stamping fails', async () => {
  const database = await postgres.database();
  await inspect(database, async db => {
    await db.query(schema);
    await db.query('ALTER TABLE schema_migrations ADD COLUMN app_version INTEGER');
  });
  const options = { env: { ...env, BOOTSTRAP: '1', APP_VERSION: 'not-an-integer' } };
  await assert.rejects(run(database, options), /rolled back to INTEGER/);
  await inspect(database, async db => {
    const columns = (await db.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations'")).rows;
    assert.equal(columns.find(row => row.column_name === 'version').data_type, 'integer');
    assert.equal(columns.some(row => row.column_name === 'checksum'), false);
    await db.query('ALTER TABLE schema_migrations ALTER COLUMN app_version TYPE TEXT');
  });
  await run(database, options);
});

test('online preview leaves the existing integer ledger and reader password untouched', async () => {
  const database = await postgres.database();
  await inspect(database, db => db.query(schema));
  const first = await inspect(database, ledger);
  await run(database, { env: { DRY_RUN: '1', BOOTSTRAP: '1' } });
  assert.deepEqual(await inspect(database, ledger), first);
});

test('missing initialization permission and occupied databases fail without database changes', async () => {
  const database = await postgres.database();
  await assert.rejects(run(database, { env: { SQL_READER_SYNC_MODE: 'disabled' } }), /INITIALIZE_EMPTY_DB/);
  await inspect(database, db => db.query('CREATE TABLE retained(id int); INSERT INTO retained VALUES (42)'));
  await assert.rejects(run(database), /non.empty/i);
  await inspect(database, async db => {
    assert.deepEqual((await db.query('SELECT * FROM retained')).rows, [{ id: 42 }]);
    assert.equal((await db.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0].ledger, null);
    assert.equal((await db.query('SELECT pg_try_advisory_lock(4729411) AS available')).rows[0].available, true);
  });
});

test('explicit initialization also works when no ULID files exist', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-no-migrations-'));
  const database = await postgres.database();
  try {
    await run(database, { migrationDir: directory });
    assert.equal((await inspect(database, ledger)).length, 10);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a failing ULID rolls back its DDL and ledger row, releases the lock, and allows retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-test-migrations-'));
  const file = join(directory, `${testId}_atomic.sql`);
  const database = await postgres.database();
  try {
    writeFileSync(file, 'CREATE TABLE rollback_marker (id int);\nSELECT nonexistent_migration_function();');
    await assert.rejects(run(database, { migrationDir: directory }), /rolled back/);
    await inspect(database, async db => {
      assert.equal((await db.query("SELECT to_regclass('rollback_marker') AS marker")).rows[0].marker, null);
      assert.equal((await db.query('SELECT 1 FROM schema_migrations WHERE version=$1', [testId])).rowCount, 0);
      assert.equal((await db.query('SELECT pg_try_advisory_lock(4729411) AS available')).rows[0].available, true);
      await db.query('SELECT pg_advisory_unlock(4729411)');
    });
    writeFileSync(file, '-- since: 9.8.7\nCREATE TABLE rollback_marker (id int);');
    await run(database, { migrationDir: directory });
    const first = await inspect(database, ledger);
    assert.equal(first.find(row => row.version === testId).app_version, '9.8.7');
    await run(database, { migrationDir: directory });
    assert.deepEqual(await inspect(database, ledger), first);
    writeFileSync(file, '-- since: 9.8.7\nCREATE TABLE changed_after_apply (id int);');
    await assert.rejects(run(database, { migrationDir: directory }), /checksum drift/);
    assert.deepEqual(await inspect(database, ledger), first);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('runtime reader sync uses its selected secret on initial run and rerun', async () => {
  const database = await postgres.database();
  let password = "local-only'quote\\password";
  const readerEnv = { ...env, AURORA_SECRET_ARN: 'master', SQL_READER_SYNC_MODE: 'secret', SQL_READER_SECRET_ARN: 'selected-reader' };
  const messages = [];
  const readerOptions = { env: readerEnv, logger: { log: message => messages.push(message) }, readSecret: async arn => {
    assert.equal(arn, 'selected-reader');
    return { username: 'awsops_sql_reader', password };
  } };
  await run(database, readerOptions);
  const first = await inspect(database, ledger);
  const authenticate = async suppliedPassword => {
    const reader = postgres.client(database, { user: 'awsops_sql_reader', password: suppliedPassword });
    try { await reader.connect(); return (await reader.query('SELECT current_user')).rows[0].current_user; }
    finally { await reader.end(); }
  };
  assert.equal(await authenticate(password), 'awsops_sql_reader');
  assert.ok(messages.every(message => !message.includes(password)));
  const previous = password;
  password = 'rotated-local-password';
  await run(database, readerOptions);
  await assert.rejects(authenticate(previous), /password authentication failed/);
  assert.equal(await authenticate(password), 'awsops_sql_reader');
  assert.ok(messages.every(message => !message.includes(password) && !message.includes(previous)));
  assert.deepEqual(await inspect(database, ledger), first);
});

test('missing or elevated reader role and malformed secrets fail closed on rerun', async () => {
  const database = await postgres.database();
  const options = { env: { ...env, SQL_READER_SYNC_MODE: 'secret', SQL_READER_SECRET_ARN: 'reader' } };
  await run(database);
  // Other databases in this fixture can own reader objects; rename temporarily.
  await inspect(database, db => db.query('ALTER ROLE awsops_sql_reader RENAME TO temporarily_saved_reader'));
  try {
    await assert.rejects(run(database, options), /reader.*missing/);
  } finally {
    await inspect(database, db => db.query('ALTER ROLE temporarily_saved_reader RENAME TO awsops_sql_reader'));
  }
  await inspect(database, db => db.query('ALTER ROLE awsops_sql_reader BYPASSRLS'));
  try { await assert.rejects(run(database, options), /elevated/); }
  finally { await inspect(database, db => db.query('ALTER ROLE awsops_sql_reader NOBYPASSRLS')); }
  for (const secret of [{ username: 'wrong-role', password: 'secret-marker' }, { username: 'awsops_sql_reader', password: 1 }]) {
    await assert.rejects(run(database, { ...options, readSecret: async () => secret }), error => {
      assert.match(error.message, /SQL.reader secret/);
      assert.doesNotMatch(error.message, /secret-marker/);
      return true;
    });
  }
});

test('runtime TLS accepts a trusted hostname and rejects untrusted CA and hostname mismatch', async () => {
  const database = await postgres.database();
  const config = await runner.loadCredentials({
    AWS_REGION: 'ap-northeast-2', AURORA_ENDPOINT: 'localhost', AURORA_DATABASE: database, AURORA_SECRET_ARN: 'local-master',
  }, { terraformOutput: forbiddenExternal, readSecret: async () => ({ username: 'awsops_admin', password: postgres.password }) });
  const connect = async options => {
    const db = postgres.client(database, { ...options, port: postgres.config.port });
    try { await db.connect(); return (await db.query('SELECT 1 AS value')).rows[0].value; }
    finally { await db.end(); }
  };
  await assert.rejects(connect(config), /certificate|self.signed|verify/i);
  const trusted = { ...config, ssl: { ...config.ssl, ca: postgres.ca } };
  assert.equal(await connect(trusted), 1);
  await assert.rejects(connect({ ...trusted, host: '127.0.0.1', ssl: { ...trusted.ssl, servername: 'wrong-host.invalid' } }), /hostname|altnames/i);
});
