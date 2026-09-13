import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { disposablePostgres } from './postgres-test-fixture.mjs';

const { initializeEmptyDatabase } = await import('../initialize-db.mjs');
const schema = readFileSync(new URL('../../../terraform/foundation/data/schema.sql', import.meta.url), 'utf8');
let postgres;
before(async () => { postgres = await disposablePostgres(); });
after(async () => { await postgres?.close(); });

async function withDatabase(fn) {
  const db = postgres.client(await postgres.database());
  await db.connect();
  await db.query('SELECT pg_advisory_lock(4729411)');
  try { await fn(db); } finally { await db.end(); }
}

test('empty initialization atomically creates v1-v9 plus a TEXT ledger with a baseline checksum', () => withDatabase(async db => {
  assert.equal(await initializeEmptyDatabase(db, schema, 'integration-version'), true);
  const first = (await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(first.map(row => row.version), ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'baseline']);
  assert.equal(first.at(-1).checksum, createHash('sha256').update(schema).digest('hex'));
  assert.equal(first.at(-1).app_version, 'integration-version');
  assert.equal((await db.query("SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations' AND column_name='version'")).rows[0].data_type, 'text');
  assert.equal(await initializeEmptyDatabase(db, 'SELECT nonexistent_function()', 'changed'), false);
  assert.deepEqual((await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows, first);
}));

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
  ['non-public table', 'CREATE SCHEMA other; CREATE TABLE other.marker (id int)'],
]) {
  test(`a ${kind} without a ledger prevents any initialization`, () => withDatabase(async db => {
    await db.query(sql);
    await assert.rejects(initializeEmptyDatabase(db, schema, 'test'), /non.empty/i);
    assert.equal((await db.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0].ledger, null);
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
