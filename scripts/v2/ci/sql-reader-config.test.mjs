import test from 'node:test';
import assert from 'node:assert/strict';

const { sqlReaderConfiguration } = await import('../sql-reader-config.mjs');

test('legacy CLI defaults to Terraform; runtime requires an explicit reader mode', () => {
  assert.deepEqual(sqlReaderConfiguration({}), { mode: 'terraform' });
  for (const key of ['AURORA_SECRET_ARN', 'AURORA_ENDPOINT', 'AURORA_DATABASE']) {
    assert.throws(() => sqlReaderConfiguration({ [key]: 'runtime' }), /SQL_READER_SYNC_MODE/);
    assert.throws(() => sqlReaderConfiguration({ [key]: 'runtime', SQL_READER_SYNC_MODE: 'terraform' }), /runtime|environment/i);
  }
});

test('secret mode requires a selected ARN; disabled mode is explicit', () => {
  assert.deepEqual(sqlReaderConfiguration({
    AURORA_SECRET_ARN: 'master', SQL_READER_SYNC_MODE: 'secret', SQL_READER_SECRET_ARN: ' reader ',
  }), { mode: 'secret', arn: 'reader' });
  assert.deepEqual(sqlReaderConfiguration({
    AURORA_SECRET_ARN: 'master', SQL_READER_SYNC_MODE: 'disabled', SQL_READER_SECRET_ARN: '',
  }), { mode: 'disabled' });
  assert.deepEqual(sqlReaderConfiguration({ SQL_READER_SYNC_MODE: 'terraform' }), { mode: 'terraform' });
});

test('invalid or conflicting reader settings fail closed', () => {
  for (const env of [
    { SQL_READER_SYNC_MODE: 'secret' },
    { SQL_READER_SYNC_MODE: 'secret', SQL_READER_SECRET_ARN: '  ' },
    { SQL_READER_SYNC_MODE: 'disabled', SQL_READER_SECRET_ARN: 'reader' },
    { SQL_READER_SYNC_MODE: 'terraform', SQL_READER_SECRET_ARN: 'reader' },
    { SQL_READER_SECRET_ARN: 'reader' },
    { SQL_READER_SYNC_MODE: 'typo' },
  ]) assert.throws(() => sqlReaderConfiguration(env), /SQL_READER/);
});
