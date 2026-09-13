import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareRuntimeHost } from './prepare-runtime-host.mjs';

const env = { TARGET: 'dev', CI_READONLY_RUNTIME_DEV: 'true', PLAN_SCOPE: 'full',
  AWS_ACCOUNT_ID_DEV: '123456789012', SMOKE_CREDENTIAL_FILE: '/private/credentials.json' };
function fixture(result) {
  const calls = [], cleaned = [];
  return { calls, cleaned, dependencies: {
    readCredentials: () => ({ email: 'fixture@example.test', password: 'FIXTURE_ONLY' }),
    output: name => ({ public_url: 'https://dev.example.test', cloudfront_domain: 'dexample.cloudfront.net' })[name],
    authenticate: async input => { calls.push(input); return result; },
    cleanup: file => cleaned.push(file),
  } };
}
test('requires actual host preparation, not a database-only or flags-only success', async () => {
  for (const result of [{ status: 'ok' }, { status: 'ok', mode: 'verify' }, { status: 'failed', mode: 'prepare' }]) {
    const f = fixture(result);
    await assert.rejects(prepareRuntimeHost(env, f.dependencies), /runtime_host_preparation_failed/);
    assert.deepEqual(f.cleaned, [env.SMOKE_CREDENTIAL_FILE]);
  }
});
test('binds host-only proof to the intended account and applied URLs', async () => {
  const f = fixture({ status: 'ok', mode: 'prepare' });
  assert.deepEqual(await prepareRuntimeHost(env, f.dependencies), { host_registry: 'verified' });
  assert.deepEqual(f.calls[0].runtimeConfig, {
    schemaVersion: 1, mode: 'prepare', hostOnly: true, expectedAccountId: env.AWS_ACCOUNT_ID_DEV,
  });
  assert.equal(f.calls[0].publicUrl, 'https://dev.example.test');
  assert.deepEqual(f.cleaned, [env.SMOKE_CREDENTIAL_FILE]);
});
test('invalid context makes no authentication call and remote errors are not exposed', async () => {
  const f = fixture({ status: 'ok', mode: 'prepare' });
  await assert.rejects(prepareRuntimeHost({ ...env, TARGET: 'main' }, f.dependencies), /runtime_host_preparation_failed/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(prepareRuntimeHost(env, { ...f.dependencies,
    authenticate: async () => { throw new Error('PRIVATE_REMOTE_DETAIL'); } }), e =>
    e.message === 'runtime_host_preparation_failed');
});

test('workflow requires host proof before planning and always cleans the private credentials', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/terraform.yml', import.meta.url), 'utf8');
  const proof = workflow.indexOf('name: Verify host registry before runtime activation');
  const plan = workflow.indexOf('name: terraform plan');
  assert.ok(proof > 0 && plan > proof);
  const step = workflow.slice(proof, workflow.indexOf('      - name:', proof + 6));
  assert.match(step, /vars.CI_READONLY_RUNTIME_DEV == 'true'/);
  assert.doesNotMatch(step, /continue-on-error|if: steps.host_credentials/);
  const preparation = workflow.slice(workflow.indexOf('      - uses: actions/setup-node@v4'), proof);
  for (const block of [...preparation.split('      - ').filter(s => /if:/.test(s)), step]) {
    assert.match(block, /if:.*github.event_name == 'workflow_dispatch'/);
  }
  assert.match(workflow, /name: Clean host verification credentials\n        if: always\(\)/);
});
