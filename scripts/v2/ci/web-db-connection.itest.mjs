// Local-only real PostgreSQL/TLS regression test. Requires Docker, openssl and
// npm ci in both web/ and scripts/v2/. Missing prerequisites fail, never skip.
// Run: node --test scripts/v2/ci/web-db-connection.itest.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { disposablePostgres, waitForQuery } from './postgres-test-fixture.mjs';

const webRequire = createRequire(new URL('../../../web/package.json', import.meta.url));
const pg = webRequire('pg');
const ts = webRequire('typescript');
const file = new URL('../../../web/lib/db-connection.ts', import.meta.url).pathname;
const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = new Module(file);
mod.paths = Module._nodeModulePaths(new URL('../../../web/lib/', import.meta.url).pathname);
mod._compile(compiled, file);
const { ObservedDbClient } = mod.exports;
function loadInventory(pool) {
  const source = new URL('../../../web/lib/inventory.ts', import.meta.url).pathname;
  const specsFile = new URL('../../../web/lib/inventory-types.ts', import.meta.url).pathname;
  const specs = new Module(specsFile);
  specs._compile(ts.transpileModule(readFileSync(specsFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, specsFile);
  const inventoryModule = new Module(source);
  inventoryModule.require = id => {
    if (id === '@/lib/db') return { getPool: () => pool };
    if (id === '@/lib/admin') return { isAdmin: () => false };
    if (id === '@/lib/inventory-types') return specs.exports;
    if (id === '@/lib/inventory-derived') return { AGG_DERIVED_KEYS: {} };
    if (id === '@aws-sdk/client-lambda') return {
      LambdaClient: class { send() { throw new Error('AWS forbidden in inventory tests'); } }, InvokeCommand: class {},
    };
    return webRequire(id);
  };
  inventoryModule._compile(ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, source);
  return inventoryModule.exports.readResources;
}
function loadMemberProof(pool, accountId) {
  const source = new URL('../../../web/app/api/deployment/member-inventory/route.ts', import.meta.url).pathname;
  const route = new Module(source);
  route.require = id => {
    if (id === '@/lib/db') return { getPool: () => pool };
    if (id === '@/lib/auth') return { verifyUser: async () => ({ sub: 'fixture-verifier' }) };
    if (id === '@/lib/account-registration-scope') return { registrationTargetAccountIds: () => [accountId] };
    return webRequire(id);
  };
  route._compile(ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, source);
  return route.exports.GET;
}
let fixture;

before(async () => { fixture = await disposablePostgres(); });
after(async () => { await fixture?.close(); });

test('member identity proof finds a wide resource beyond 500 rows and rejects unusable or ambiguous scan scopes', async () => {
  const client = new pg.Client({ ...fixture.config, database: 'awsops', password: fixture.password });
  await client.connect();
  const accountId = '222222222222', resourceId = 'i-fffffffffffffffff';
  const get = loadMemberProof(client, accountId);
  const request = () => new Request(`https://app.test/api/deployment/member-inventory?${new URLSearchParams({
    accountId, type: 'ec2', resourceId,
  })}`);
  try {
    await client.query(`
      CREATE TEMP TABLE accounts (
        account_id text PRIMARY KEY, enabled boolean, is_host boolean,
        role_name text, all_regions boolean);
      CREATE TEMP TABLE account_regions (
        account_id text, region text, enabled boolean, PRIMARY KEY(account_id, region));
      CREATE TEMP TABLE inventory_resources (
        resource_type text, account_id text, region text, resource_id text,
        captured_at timestamptz, data jsonb,
        PRIMARY KEY(resource_type, account_id, region, resource_id));`);
    await client.query(`INSERT INTO accounts VALUES ($1,true,false,'AWSopsReadOnlyRole',false)`, [accountId]);
    await client.query(`INSERT INTO account_regions VALUES ($1,'ap-northeast-2',true)`, [accountId]);
    await client.query(`INSERT INTO inventory_resources
      SELECT 'ec2',$1,'ap-northeast-2','i-' || lpad(to_hex(n),17,'0'),now(),
        jsonb_build_object('instance_id','i-' || lpad(to_hex(n),17,'0'))
      FROM generate_series(1,600) n`, [accountId]);
    await client.query(`INSERT INTO inventory_resources VALUES
      ('ec2',$1,'ap-northeast-2',$2,'2026-09-15T08:00:00Z',
       jsonb_build_object('instance_id',$2::text,'payload',repeat('x',100000)))`, [accountId, resourceId]);
    let response = await get(request());
    assert.equal(response.status, 200);
    let text = await response.text();
    assert.ok(Buffer.byteLength(text) < 1000);
    assert.deepEqual(JSON.parse(text), {
      schemaVersion: 1, status: 'verified', accountId, type: 'ec2', resourceId,
      region: 'ap-northeast-2', capturedAt: '2026-09-15T08:00:00.000Z',
    });

    await client.query('UPDATE account_regions SET enabled=false');
    assert.equal((await (await get(request())).json()).reason, 'scan_scope_unavailable');
    await client.query(`INSERT INTO account_regions VALUES ($1,'us-east-1',true)`, [accountId]);
    assert.equal((await (await get(request())).json()).reason, 'resource_missing');

    await client.query('UPDATE accounts SET all_regions=true');
    assert.equal((await (await get(request())).json()).status, 'verified');
    await client.query(`INSERT INTO inventory_resources
      SELECT resource_type,account_id,'us-east-1',resource_id,captured_at,data
      FROM inventory_resources WHERE resource_id=$1`, [resourceId]);
    assert.equal((await (await get(request())).json()).reason, 'resource_ambiguous');

    await client.query('UPDATE accounts SET enabled=false');
    assert.equal((await (await get(request())).json()).reason, 'account_not_ready');
  } finally {
    await client.end();
  }
});

async function exercise(password, run) {
  const logs = [];
  const originalWarn = console.warn;
  console.warn = line => logs.push(JSON.parse(line));
  const pool = new pg.Pool({
    ...fixture.config, database: 'awsops', Client: ObservedDbClient,
    password, max: 1, connectionTimeoutMillis: 500,
  });
  try {
    await run(pool, logs);
  } finally {
    await pool.end();
    console.warn = originalWarn;
  }
}

test('async password succeeds over verified TLS; later SQL errors and close are not connection failures', async () => {
  await exercise(async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
    return fixture.password;
  }, async (pool, logs) => {
    const result = await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    assert.equal(result.rows[0].ssl, true);
    await assert.rejects(pool.query('SELECT missing_column_for_connection_test'), { code: '42703' });
    const client = await pool.connect();
    const ended = new Promise(resolve => client.once('end', resolve));
    client.release(true);
    await ended;
    assert.deepEqual(logs, []);
  });
});

test('a stalled async password is distinguished from TCP/TLS failure at the unchanged pool deadline', async () => {
  await exercise(() => new Promise(() => {}), async (pool, logs) => {
    await assert.rejects(pool.query('SELECT 1'), /Connection terminated due to connection timeout/);
    assert.equal(logs.length, 1);
    const event = logs[0];
    assert.equal(event.evt, 'db_connection_failed');
    assert.equal(event.phase, 'iam_token');
    for (const milestone of ['tcp_connected', 'tls_connected', 'password_requested', 'token_started']) {
      assert.equal(typeof event.milestones_ms[milestone], 'number');
    }
    assert.equal(event.milestones_ms.token_ready, undefined);
    assert.ok(event.elapsed_ms >= 450 && event.elapsed_ms < 3000);
  });
});

test('a PostgreSQL password rejection is distinguished from a token-provider stall and remains code 28P01', async () => {
  await exercise(async () => 'wrong-local-test-password', async (pool, logs) => {
    await assert.rejects(pool.query('SELECT 1'), { code: '28P01' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].phase, 'postgres_authentication');
    assert.equal(typeof logs[0].milestones_ms.token_ready, 'number');
    assert.equal(JSON.stringify(logs).includes('wrong-local-test-password'), false);
    assert.deepEqual(Object.keys(logs[0]).sort(), ['elapsed_ms', 'evt', 'milestones_ms', 'phase']);
  });
});

test('credential-provider rejection preserves the original error without logging its secret-bearing message', async () => {
  const error = new Error('test-only-secret-in-provider-error');
  await exercise(async () => { throw error; }, async (pool, logs) => {
    await assert.rejects(pool.query('SELECT 1'), candidate => candidate === error);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].phase, 'iam_token');
    assert.equal(JSON.stringify(logs).includes(error.message), false);
  });
});

test('inventory five-row pages totally order tied timestamps using every scoped primary-key column', async () => {
  const client = new pg.Client({ ...fixture.config, database: 'awsops', password: fixture.password });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE inventory_resources (
      resource_type text, account_id text, region text, resource_id text, data jsonb,
      captured_at timestamptz, PRIMARY KEY(resource_type, account_id, region, resource_id));
      CREATE TEMP TABLE inventory_sync_runs (
        resource_type text, account_id text, status text, finished_at timestamptz,
        row_count integer, error text, last_success_at timestamptz);`);
    const expected = [];
    for (const account of ['111122223333', 'self']) {
      for (const region of ['a-region', 'b-region']) {
        for (const id of ['r0', 'r1', 'r2']) expected.push([account, region, id]);
      }
    }
    for (const [account, region, id] of [...expected].reverse()) {
      await client.query(`INSERT INTO inventory_resources VALUES
        ('cloudfront',$1,$2,$3,'{}','2026-01-01T00:00:00Z')`, [account, region, id]);
    }
    const readResources = loadInventory(client);
    const found = [];
    for (let offset = 0; offset < expected.length; offset += 5) {
      const page = await readResources('cloudfront', { limit: 5, offset, accounts: '__all__' });
      found.push(...page.rows.map(row => [row.account_id, row.region, row.resource_id]));
    }
    assert.deepEqual(found, expected);
    assert.equal(new Set(found.map(row => row.join('/'))).size, expected.length);
    await client.query(`INSERT INTO inventory_sync_runs VALUES
      ('cloudfront','self','partial','2026-01-02',12,NULL,'2026-01-01')`);
    const empty = await readResources('cloudfront', { limit: 5, offset: 500, accounts: '__all__' });
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.run.row_count, 12);
    assert.equal(empty.run.status, 'partial');
    assert.equal(empty.consistency, 'statement-snapshot');
    const absent = await readResources('ec2', { limit: 5, offset: 0 });
    assert.deepEqual(absent.rows, []);
    assert.equal(absent.run, null);
    for (const [id, state, updated] of [
      ['ok-new','OK','2026-01-03'], ['alarm-old','alarm','2026-01-01'],
      ['unknown','NEW_STATE','2026-01-04'], ['alarm-new','ALARM','2026-01-02'],
      ['insufficient','INSUFFICIENT_DATA','2026-01-01'],
    ]) await client.query(`INSERT INTO inventory_resources VALUES
      ('cloudwatch_alarm','self','a-region',$1,$2,'2026-01-01')`,
      [id, { state_value: state, state_updated_timestamp: updated }]);
    const first = await readResources('cloudwatch_alarm', { limit: 2, offset: 0 });
    const rest = await readResources('cloudwatch_alarm', { limit: 5, offset: 2 });
    assert.deepEqual([...first.rows, ...rest.rows].map(row => row.resource_id),
      ['alarm-new','alarm-old','insufficient','ok-new','unknown']);

  } finally { await client.end(); }
});


test('one statement keeps rows/ledger coherent across a concurrent writer and returns the pool slot on errors', async () => {
  const database = await fixture.database();
  const writer = fixture.client(database), observer = fixture.client(database);
  await writer.connect(); await observer.connect();
  const pool = new pg.Pool({ ...fixture.config, database, max: 1, application_name: 'inventory-snapshot-race' });
  const nativeQuery = pool.query.bind(pool);
  let calls = 0;
  pool.query = (...args) => { calls++; return nativeQuery(...args); };
  const readResources = loadInventory(pool);
  let pending;
  try {
    await writer.query(`CREATE TABLE inventory_resources (
      resource_type text, account_id text, region text, resource_id text, data jsonb, captured_at timestamptz);
      CREATE TABLE inventory_ledger (resource_type text, account_id text, status text, finished_at timestamptz,
        row_count integer, error text, last_success_at timestamptz);
      CREATE FUNCTION snapshot_gate() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(694416); RETURN true; END $$;
      CREATE VIEW inventory_sync_runs AS SELECT * FROM inventory_ledger WHERE snapshot_gate();
      INSERT INTO inventory_resources VALUES ('ec2','self','us-east-1','old','{}','2026-01-01');
      INSERT INTO inventory_ledger VALUES ('ec2','self','succeeded','2026-01-01',1,NULL,'2026-01-01');`);
    await writer.query('SELECT pg_advisory_lock(694416)');
    pending = readResources('ec2', { limit: 5, offset: 0 });
    await waitForQuery(observer, `SELECT wait_event FROM pg_stat_activity
      WHERE application_name='inventory-snapshot-race'`, rows => rows.some(row => row.wait_event === 'advisory'));
    await writer.query(`BEGIN;
      UPDATE inventory_resources SET resource_id='new';
      INSERT INTO inventory_resources VALUES ('ec2','self','us-east-1','second','{}','2026-01-02');
      UPDATE inventory_ledger SET row_count=2, finished_at='2026-01-02', last_success_at='2026-01-02'; COMMIT;`);
    await writer.query('SELECT pg_advisory_unlock(694416)');
    const snapshot = await pending;
    assert.deepEqual(snapshot.rows.map(row => row.resource_id), ['old']);
    assert.equal(snapshot.run.row_count, 1);
    assert.equal(snapshot.consistency, 'statement-snapshot');
    assert.equal(calls, 1);
    assert.equal(pool.idleCount, 1);
    const current = await readResources('ec2', { limit: 5, offset: 0 });
    assert.deepEqual(current.rows.map(row => row.resource_id), ['second', 'new']);
    assert.equal(current.run.row_count, 2);
    await assert.rejects(readResources('ec2', { limit: -1, offset: 0 }), /LIMIT must not be negative/);
    assert.equal(pool.totalCount, 0); // pg-pool discards the errored client instead of pinning it.
    assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1);
    assert.equal(pool.idleCount, 1);
    assert.equal(pool.waitingCount, 0);
  } finally {
    await writer.query('SELECT pg_advisory_unlock_all()').catch(() => {});
    await pending?.catch(() => {});
    await pool.end(); await writer.end(); await observer.end();
  }
});
