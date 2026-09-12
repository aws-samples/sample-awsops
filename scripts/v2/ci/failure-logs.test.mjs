import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openPlan } from './plan-artifact.mjs';
const script = fileURLToPath(new URL('./failure-logs.mjs', import.meta.url));
function fixture(key) {
  const root = mkdtempSync(join(tmpdir(), 'awsops-failure-logs-'));
  mkdirSync(join(root, 'terraform/foundation/.build/ci'), { recursive: true });
  mkdirSync(join(root, 'retained'));
  writeFileSync(join(root, 'terraform/foundation/tfplan.log'), 'private-diagnostic-marker');
  writeFileSync(join(root, 'terraform/foundation/.build/ci/last-error.log'), 'private-controller-marker');
  const output = join(root, 'output');
  const env = { ...process.env, TF_PLAN_ENC_KEY: key, RUNNER_TEMP: join(root, 'retained'),
    GITHUB_OUTPUT: output, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'test' };
  return { root, output, env };
}
test('failure logs remain decryptable after source cleanup and are never uploaded as plaintext', () => {
  const f = fixture('example-encryption-key');
  try {
    const result = spawnSync(process.execPath, [script], { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = Object.fromEntries(readFileSync(f.output, 'utf8').trim().split('\n').map(line => line.split('=')));
    assert.equal(output.encrypted, 'true');
    rmSync(join(f.root, 'terraform'), { recursive: true });
    const encrypted = readFileSync(output.path);
    assert.ok(!encrypted.includes(Buffer.from('private-diagnostic-marker')));
    const logs = JSON.parse(openPlan(encrypted, { kind: 'failure-diagnostics' }, f.env.TF_PLAN_ENC_KEY).toString());
    assert.equal(logs['tfplan.log'], 'private-diagnostic-marker');
    assert.equal(logs['last-error.log'], 'private-controller-marker');
    assert.equal(statSync(output.retained_dir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(output.retained_dir), ['diagnostics.enc']);
    assert.doesNotMatch(result.stdout + result.stderr, /private-diagnostic-marker|private-controller-marker/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('an unavailable encryption key fails and deletes plaintext instead of retaining it on the shared runner', () => {
  const f = fixture('');
  try {
    const result = spawnSync(process.execPath, [script], { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    const output = Object.fromEntries(readFileSync(f.output, 'utf8').trim().split('\n').map(line => line.split('=')));
    assert.notEqual(output.encrypted, 'true');
    assert.equal(existsSync(join(f.root, 'terraform/foundation/tfplan.log')), false);
    assert.equal(existsSync(join(f.root, 'terraform/foundation/.build/ci/last-error.log')), false);
    assert.equal(output.retained_dir, undefined);
    assert.match(result.stderr, /plaintext.*deleted/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
