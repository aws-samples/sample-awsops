// Run directly or with node --test. Exercises migrate.mjs itself, not a SQL replay.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as runner from '../migrate.mjs';
import { initializeEmptyDatabase } from '../initialize-db.mjs';
import { disposablePostgres, waitForQuery } from './postgres-test-fixture.mjs';

const root = new URL('../../../', import.meta.url);
const schema = readFileSync(new URL('terraform/foundation/data/schema.sql', root), 'utf8').replace(/\r\n/g, '\n');
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
// Two 2.5s polling windows + 5.2s injected CI delay + startup/assertions fit
// within 15s. Keep statement timeout at 30s and lock tests bounded at 45s.
const lockRunnerOptions = { lock_timeout: 15_000 };

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

test('both first-run initialization and ULIDs wait behind the same advisory lock', { timeout: 45_000 }, async () => {
  const database = await postgres.database();
  await inspect(database, async blocker => {
    await blocker.query('SELECT pg_advisory_lock(4729411)');
    const result = run(database, {}, { ...lockRunnerOptions, application_name: 'waiting-initializer' });
    result.catch(() => {});
    try {
      await waitForQuery(blocker, "SELECT wait_event FROM pg_stat_activity WHERE application_name='waiting-initializer'",
        rows => rows.some(row => row.wait_event === 'advisory'));
      assert.equal((await blocker.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0].ledger, null);
    } finally { await blocker.query('SELECT pg_advisory_unlock(4729411)'); }
    await result;
    assert.equal((await ledger(blocker)).length, migrationFiles.length + 10);
  });
});

test('concurrent initializers apply each migration once', { timeout: 45_000 }, async () => {
  const database = await postgres.database();
  await Promise.all([run(database, {}, lockRunnerOptions), run(database, {}, lockRunnerOptions)]);
  assert.equal((await inspect(database, ledger)).length, migrationFiles.length + 10);
});

test('the migration lock stays held after the baseline commits and until ULIDs finish', { timeout: 45_000 }, async () => {
  const database = await postgres.database();
  const directory = mkdtempSync(join(tmpdir(), 'awsops-lock-test-'));
  writeFileSync(join(directory, `${testId}_lock.sql`),
    'SELECT pg_advisory_lock(4729412); SELECT pg_advisory_unlock(4729412); CREATE TABLE lock_marker(id int);');
  try {
    await inspect(database, async observer => {
      await observer.query('SELECT pg_advisory_lock(4729412)');
      const first = run(database, { migrationDir: directory }, { ...lockRunnerOptions, application_name: 'first-lock-runner' });
      first.catch(() => {}); // observed below, even if the runner rejects during polling
      let second;
      try {
        await waitForQuery(observer, "SELECT wait_event FROM pg_stat_activity WHERE application_name='first-lock-runner'",
          rows => rows.some(row => row.wait_event === 'advisory'));
        // Model a loaded CI observer crossing the fixture's default 5s lock timeout.
        await observer.query('SELECT pg_sleep(5.2)');
        assert.equal((await observer.query("SELECT version FROM schema_migrations WHERE version='baseline'")).rowCount, 1);
        assert.equal((await observer.query(`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON l.pid=a.pid
          WHERE a.application_name='first-lock-runner' AND l.locktype='advisory' AND l.objid=4729411 AND l.granted`)).rowCount, 1);
        second = run(database, { migrationDir: directory }, { ...lockRunnerOptions, application_name: 'second-lock-runner' });
        second.catch(() => {});
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

test('a stored non-null baseline checksum is checked before ULIDs, including dry-run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-baseline-drift-'));
  const database = await postgres.database();
  try {
    await run(database, { migrationDir: directory });
    await inspect(database, db => db.query("UPDATE schema_migrations SET checksum='invalid' WHERE version='baseline'"));
    await assert.rejects(run(database, { migrationDir: directory }), /checksum drift.*baseline/);
    writeFileSync(join(directory, `${testId}_pending.sql`), 'CREATE TABLE must_not_apply(id int);');
    const first = await inspect(database, ledger);
    for (const mode of [env, { DRY_RUN: '1', SQL_READER_SYNC_MODE: 'disabled' }]) {
      await assert.rejects(run(database, { migrationDir: directory, env: mode }), /checksum drift.*baseline/);
    }
    assert.deepEqual(await inspect(database, ledger), first);
    await inspect(database, async db => {
      assert.equal((await db.query("SELECT to_regclass('must_not_apply') AS t")).rows[0].t, null);
      await db.query("UPDATE schema_migrations SET checksum=NULL WHERE version='baseline'");
    });
    await run(database, { migrationDir: directory }); // legacy null checksum remains supported
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('disabled reader sync checks every elevated attribute without fetching secrets', async () => {
  const database = await postgres.database();
  await run(database);
  for (const [attribute, inverse, field] of [
    ['SUPERUSER', 'NOSUPERUSER', 'rolsuper'],
    ['REPLICATION', 'NOREPLICATION', 'rolreplication'],
    ['BYPASSRLS', 'NOBYPASSRLS', 'rolbypassrls'],
  ]) {
    await inspect(database, db => db.query(`ALTER ROLE awsops_sql_reader ${attribute}`));
    try {
      await assert.rejects(run(database), error => {
        assert.match(error.message, /elevated/);
        for (const key of ['rolsuper', 'rolreplication', 'rolbypassrls']) {
          assert.ok(error.message.includes(`${key}=${key === field}`), error.message);
        }
        return true;
      });
    } finally { await inspect(database, db => db.query(`ALTER ROLE awsops_sql_reader ${inverse}`)); }
  }
  await inspect(database, db => db.query('ALTER ROLE awsops_sql_reader RENAME TO temporarily_saved_reader'));
  try { await run(database); } // a missing role in disabled mode is legitimate
  finally { await inspect(database, db => db.query('ALTER ROLE temporarily_saved_reader RENAME TO awsops_sql_reader')); }
});

test('a non-superuser database owner needs explicit role authority to sync the reader password', async () => {
  const database = await postgres.database();
  await run(database);
  await inspect(database, async db => {
    await db.query(`CREATE ROLE limited_migration_owner LOGIN CREATEROLE PASSWORD 'local-only-owner'`);
    await db.query(`ALTER DATABASE ${database} OWNER TO limited_migration_owner`);
    await db.query('GRANT SELECT ON schema_migrations TO limited_migration_owner');
  });
  const options = { env: { SQL_READER_SYNC_MODE: 'secret', SQL_READER_SECRET_ARN: 'reader' },
    readSecret: async () => ({ username: 'awsops_sql_reader', password: 'do-not-echo-secret' }) };
  await assert.rejects(run(database, options, { user: 'limited_migration_owner', password: 'local-only-owner' }), error => {
    assert.match(error.message, /sql-reader.*password synchronization failed.*SQLSTATE=42501/);
    assert.doesNotMatch(error.message, /do-not-echo-secret|permission denied/);
    return true;
  });
  await inspect(database, db => db.query('GRANT awsops_sql_reader TO limited_migration_owner WITH ADMIN OPTION'));
  await run(database, options, { user: 'limited_migration_owner', password: 'local-only-owner' });
  const reader = postgres.client(database, { user: 'awsops_sql_reader', password: 'do-not-echo-secret' });
  try {
    await reader.connect();
    assert.equal((await reader.query('SELECT current_user')).rows[0].current_user, 'awsops_sql_reader');
  } finally { await reader.end(); }
});

test('reader secret failures identify the purpose without exposing remote messages', async () => {
  const database = await postgres.database();
  await run(database);
  await assert.rejects(run(database, {
    env: { SQL_READER_SYNC_MODE: 'secret', SQL_READER_SECRET_ARN: 'reader' },
    readSecret: async () => { throw { name: 'AccessDeniedException', message: 'do-not-echo-secret',
      $metadata: { httpStatusCode: 403 } }; },
  }), error => {
    assert.match(error.message, /SQL-reader.*GetSecretValue.*AccessDeniedException.*HTTP=403/);
    assert.doesNotMatch(error.message, /do-not-echo-secret/);
    return true;
  });
});

test('reviewed SQL notices preserve bounded, encoded audit text; other error text stays hidden', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-sql-errors-'));
  const messages = [];
  try {
    writeFileSync(join(directory, `${testId}_failure.sql`),
      "DO $$ BEGIN RAISE NOTICE 'audit row=%', E'row-42\\nforged\\r\\x1b[31m\\u2028' || repeat('x', 10000); RAISE EXCEPTION 'do-not-echo-secret' USING ERRCODE='42501'; END $$;");
    await assert.rejects(run(await postgres.database(), { migrationDir: directory,
      logger: { log: text => messages.push(text) } }), error => {
      assert.match(error.message, /rolled back.*SQLSTATE=42501/);
      const audit = messages.find(text => text.includes('audit row='));
      assert.ok(audit, 'reviewed SQL notice must reach the operator');
      assert.match(audit, /severity=NOTICE/);
      assert.match(audit, /row-42\\nforged\\r\\u001b.*\\u2028/);
      assert.doesNotMatch(audit, /[\r\n\u001b\u2028]/);
      assert.ok(audit.length < 5000);
      assert.doesNotMatch(error.message + messages.join(''), /do-not-echo-secret/);
      return true;
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the shipped schedule migration logs each disabled row and structured unique failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-schedule-audit-'));
  const file = '01KZ3C7Q5SH0ZY5W7X1D2EFGKM_report_schedules_one_active_per_user.sql';
  const database = await postgres.database();
  const messages = [];
  try {
    await run(database, { migrationDir: directory });
    await inspect(database, db => db.query(`INSERT INTO report_schedules
      (id, user_sub, schedule_type, enabled, next_run_at) VALUES
      (41, 'owner', 'weekly', true, now()), (42, 'owner', 'monthly', true, now());`));
    writeFileSync(join(directory, file), readFileSync(new URL(file, migrationDirectory)));
    await run(database, { migrationDir: directory, logger: { log: text => messages.push(text) } });
    for (const id of [41, 42]) {
      assert.ok(messages.some(text => text.includes(`disabled report_schedules id=${id}`)), messages.join('\n'));
    }
    await inspect(database, async db => {
      assert.equal((await db.query('SELECT * FROM report_schedules WHERE enabled')).rowCount, 0);
    });
    writeFileSync(join(directory, `${testId}_constraint.sql`),
      "INSERT INTO report_schedules (user_sub,schedule_type,enabled,next_run_at) VALUES ('duplicate-secret','weekly',true,now()), ('duplicate-secret','monthly',true,now());");
    await assert.rejects(run(database, { migrationDir: directory }), error => {
      assert.match(error.message, /SQLSTATE=23505/);
      for (const field of ['severity=ERROR', 'schema=public', 'table=report_schedules', 'constraint=uq_schedule_one_active']) {
        assert.ok(error.message.includes(field), error.message);
      }
      assert.doesNotMatch(error.message, /duplicate-secret|Key \(/);
      return true;
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the shipped P0001 reader guard preserves its repair guidance, without changing SQL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-repair-guidance-'));
  const file = '01KZ87KAJFA2Y27KY0QSMVBBDS_agent_sql_reader_elevated_attr_guard.sql';
  const database = await postgres.database();
  try {
    await run(database, { migrationDir: directory });
    writeFileSync(join(directory, file), readFileSync(new URL(file, migrationDirectory)));
    await inspect(database, db => db.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='awsops_sql_reader') THEN
        CREATE ROLE awsops_sql_reader;
      END IF; END $$;`));
    await inspect(database, db => db.query('ALTER ROLE awsops_sql_reader BYPASSRLS'));
    await assert.rejects(run(database, { migrationDir: directory }), error => {
      assert.match(error.message, /SQLSTATE=P0001/);
      assert.match(error.message, /Do NOT drop|Do NOT drop.*recreate/);
      assert.match(error.message, /DROP OWNED BY awsops_sql_reader.*DROP ROLE/);
      assert.match(error.message, /docs\/runbooks\/agent-sql-reader.md/);
      return true;
    });
  } finally {
    await inspect(database, db => db.query('ALTER ROLE awsops_sql_reader NOBYPASSRLS'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the shipped view-refresh notice remains visible when reader views are absent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-view-notice-'));
  const file = '01M1E9JZKCMXT1CW152R6QQQXD_compliance_results_description.sql';
  const database = await postgres.database();
  const messages = [];
  try {
    await run(database, { migrationDir: directory });
    await inspect(database, db => db.query('CREATE TABLE compliance_results(id text)'));
    writeFileSync(join(directory, file), readFileSync(new URL(file, migrationDirectory)));
    await run(database, { migrationDir: directory, logger: { log: text => messages.push(text) } });
    assert.ok(messages.some(text => text.includes('awsops_sql_reader/sql_reader absent - view refresh skipped')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a real idle disconnect aborts a pending secret read and reports no success', { timeout: 5000 }, async () => {
  const database = await postgres.database();
  await run(database);
  const messages = [];
  const client = postgres.client(database);
  await inspect(database, async observer => {
    await assert.rejects(runner.migrateDatabase(client, {
      env: { SQL_READER_SYNC_MODE: 'secret', SQL_READER_SECRET_ARN: 'reader' },
      logger: { log: text => messages.push(text) },
      readSecret: async () => {
        await observer.query('SELECT pg_terminate_backend($1)', [client.processID]);
        return new Promise(() => {});
      },
    }), /Aurora connection error.*SQLSTATE=57P01/);
  });
  assert.doesNotMatch(messages.join('\n'), /up to date|password synced|applied \d+ migration/);
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
  const database = 'awsops'; // The runtime contract matches the deployed foundation.
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

// Initializer regressions belong to this required Docker-backed suite.
async function withDatabase(fn) {
  return inspect(await postgres.database(), async db => {
    await db.query('SELECT pg_advisory_lock(4729411)');
    await fn(db);
  });
}

for (const ending of ['LF', 'CRLF']) {
  test(`empty initialization atomically stamps v1-v9 and an LF-normalized baseline (${ending})`, () => withDatabase(async db => {
    const input = schema.replace(/\n/g, ending === 'CRLF' ? '\r\n' : '\n');
    assert.equal(await initializeEmptyDatabase(db, input, 'integration-version'), true);
    const first = (await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(first.map(row => row.version), ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'baseline']);
    assert.equal(first.at(-1).checksum, hash(schema));
    assert.equal(first.at(-1).app_version, 'integration-version');
    assert.equal((await db.query("SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations' AND column_name='version'")).rows[0].data_type, 'text');
    assert.equal(await initializeEmptyDatabase(db, 'SELECT nonexistent_function()', 'changed'), false);
    assert.deepEqual((await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows, first);
  }));
}

for (const [kind, sql] of [
  ['table', 'CREATE TABLE marker (id int)'],
  ['view', 'CREATE VIEW marker AS SELECT 1 AS id'],
  ['sequence', 'CREATE SEQUENCE marker'],
  ['function', "CREATE FUNCTION marker() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
  ['type', "CREATE TYPE marker AS ENUM ('existing')"],
  ['schema', 'CREATE SCHEMA marker'],
  ['collation', 'CREATE COLLATION marker FROM "C"'],
  ['large object', 'SELECT lo_create(0)'],
  ['foreign data wrapper', 'CREATE FOREIGN DATA WRAPPER marker'],
  ['subscription', "CREATE SUBSCRIPTION marker CONNECTION 'host=127.0.0.1 dbname=unused' PUBLICATION unused WITH (connect=false)"],
  ['global default ACL', 'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC'],
  ['non-public table', 'CREATE SCHEMA other; CREATE TABLE other.marker (id int)'],
]) {
  test(`a ${kind} without a ledger prevents any initialization`, () => withDatabase(async db => {
    await db.query(sql);
    await assert.rejects(initializeEmptyDatabase(db, schema, 'test'), /non.empty/i);
    assert.equal((await db.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0].ledger, null);
  }));
}

for (const changed of [
  schema.replace(/^BEGIN;$/m, ''),
  schema.replace(/^COMMIT;$/m, ''),
  `BEGIN;\n${schema}`,
  `${schema}\nCOMMIT;`,
  schema.replace(/^(BEGIN|COMMIT);$/gm, (_, keyword) => keyword === 'BEGIN' ? 'COMMIT;' : 'BEGIN;'),
  `${schema}\nCREATE FUNCTION wrapper_probe() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN;\nEND; $$;`,
]) {
  test('unexpected legacy transaction wrappers are refused before any DDL', () => withDatabase(async db => {
    await assert.rejects(initializeEmptyDatabase(db, changed, 'test'), /legacy.*BEGIN.*COMMIT/i);
    assert.deepEqual((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows, []);
  }));
}

for (const [phase, brokenSchema] of [
  ['late baseline SQL', `${schema}\nSELECT nonexistent_baseline_function();`],
  ['ledger conversion', `${schema}\nALTER TABLE schema_migrations ADD COLUMN checksum TEXT;`],
]) {
  test(`${phase} failure rolls back every baseline section and permits retry`, () => withDatabase(async db => {
    await assert.rejects(initializeEmptyDatabase(db, brokenSchema, 'test'));
    assert.deepEqual((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows, []);
    assert.equal(await initializeEmptyDatabase(db, schema, 'retry'), true);
  }));
}
