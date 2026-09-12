import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeEmptyDatabase } from '../initialize-db.mjs';

function client({ ledger = false, objects = false, fail = false } = {}) {
  const statements = [];
  return { statements, query: async sql => {
    statements.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ ledger }] };
    if (sql.includes('pg_class')) return { rows: [{ occupied: objects }] };
    if (sql.includes('CREATE TABLE') && fail) throw new Error('bad schema');
    return { rows: [] };
  } };
}
test('existing ledger never replays baseline', async () => {
  const db = client({ ledger: true });
  assert.equal(await initializeEmptyDatabase(db, 'CREATE TABLE x();', '1.0.0'), false);
  assert.equal(db.statements.length, 1);
});
test('non-empty database without a ledger fails closed', async () => {
  const db = client({ objects: true });
  await assert.rejects(initializeEmptyDatabase(db, 'CREATE TABLE x();', '1.0.0'), /non-empty/);
  assert.ok(!db.statements.some(s => s.includes('CREATE TABLE')));
});
test('empty baseline and TEXT ledger conversion commit atomically, then are skipped on rerun', async () => {
  const db = client();
  assert.equal(await initializeEmptyDatabase(db, 'BEGIN;\nCREATE TABLE x();\nCOMMIT;\n', '1.0.0'), true);
  assert.equal(db.statements.filter(s => s === 'BEGIN').length, 1);
  assert.equal(db.statements.filter(s => s === 'COMMIT').length, 1);
  assert.ok(db.statements.some(s => s.includes('TYPE TEXT')));
  assert.ok(!db.statements.some(s => /BEGIN;|COMMIT;/.test(s)));
});
test('a failed baseline rolls back and does not commit', async () => {
  const db = client({ fail: true });
  await assert.rejects(initializeEmptyDatabase(db, 'CREATE TABLE broken();', '1.0.0'), /bad schema/);
  assert.equal(db.statements.at(-1), 'ROLLBACK');
  assert.ok(!db.statements.includes('COMMIT'));
});
