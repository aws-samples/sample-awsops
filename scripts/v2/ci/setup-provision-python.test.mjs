import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('isolated provisioner SDK setup preserves credential and cleanup boundaries', () => {
  const result = spawnSync('python3', ['-m', 'pytest',
    fileURLToPath(new URL('./test_setup_provision_python.py', import.meta.url)), '-q'], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
