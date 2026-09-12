import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlReaderConfiguration } from '../sql-reader-config.mjs';

test('manual env-backed migration cannot silently disable SQL-reader synchronization', () => {
  assert.throws(() => sqlReaderConfiguration({ AURORA_SECRET_ARN: 'master-secret' }), /SQL_READER_SYNC_MODE/);
  assert.throws(() => sqlReaderConfiguration({ SQL_READER_SYNC_MODE: 'secret' }), /SQL_READER_SECRET_ARN/);
  assert.throws(() => sqlReaderConfiguration({ SQL_READER_SYNC_MODE: 'disabled', SQL_READER_SECRET_ARN: 'reader' }), /conflict/i);
});

test('reader modes explicitly select Terraform, a supplied secret, or disabled', () => {
  assert.deepEqual(sqlReaderConfiguration({}), { mode: 'terraform' });
  assert.deepEqual(sqlReaderConfiguration({ AURORA_SECRET_ARN: 'master', SQL_READER_SYNC_MODE: 'terraform' }), { mode: 'terraform' });
  assert.deepEqual(sqlReaderConfiguration({ SQL_READER_SYNC_MODE: 'disabled' }), { mode: 'disabled' });
  assert.deepEqual(sqlReaderConfiguration({ SQL_READER_SYNC_MODE: 'secret', SQL_READER_SECRET_ARN: 'reader' }), { mode: 'secret', arn: 'reader' });
});
