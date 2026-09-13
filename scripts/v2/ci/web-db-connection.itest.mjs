// Local-only real PostgreSQL/TLS regression test. Requires Docker, openssl and
// npm ci in both web/ and scripts/v2/. Missing prerequisites fail, never skip.
// Run: node --test scripts/v2/ci/web-db-connection.itest.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { disposablePostgres } from './postgres-test-fixture.mjs';

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
let fixture;

before(async () => { fixture = await disposablePostgres(); });
after(async () => { await fixture?.close(); });

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
    const source = new URL('../../../web/lib/inventory.ts', import.meta.url).pathname;
    const inventoryModule = new Module(source);
    inventoryModule.require = id => {
      if (id === '@/lib/db') return { getPool: () => client };
      if (id === '@/lib/admin') return { isAdmin: () => false };
      if (id === '@/lib/inventory-types') return { INVENTORY_TYPES: { cloudfront: {} } };
      if (id === '@/lib/inventory-derived') return { AGG_DERIVED_KEYS: {} };
      if (id === '@aws-sdk/client-lambda') return {
        LambdaClient: class { send() { throw new Error('AWS forbidden in ordering test'); } },
        InvokeCommand: class {},
      };
      return webRequire(id);
    };
    inventoryModule._compile(ts.transpileModule(readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, source);
    const found = [];
    for (let offset = 0; offset < expected.length; offset += 5) {
      const page = await inventoryModule.exports.readResources('cloudfront', { limit: 5, offset, accounts: '__all__' });
      found.push(...page.rows.map(row => [row.account_id, row.region, row.resource_id]));
    }
    assert.deepEqual(found, expected);
    assert.equal(new Set(found.map(row => row.join('/'))).size, expected.length);
  } finally { await client.end(); }
});
