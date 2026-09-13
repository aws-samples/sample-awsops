import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('immutable provisioner and readiness protocol regressions run in the existing CI test glob', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./runtime-build-provision.test.py', import.meta.url)), '-q'], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' },
  });
  assert.equal(result.status, 0, result.stderr);
});
