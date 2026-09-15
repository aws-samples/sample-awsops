import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareRuntimeHost } from './prepare-runtime-host.mjs';
import { verifyRuntimeSmoke } from '../runtime-smoke.mjs';

const env = { TARGET: 'dev', CI_READONLY_RUNTIME_DEV: 'true', PLAN_SCOPE: 'full',
  AWS_ACCOUNT_ID_DEV: '123456789012', SMOKE_CREDENTIAL_FILE: '/private/credentials.json' };
function fixture(result) {
  const calls = [], cleaned = [];
  return { calls, cleaned, dependencies: {
    plannedTargets: () => [],
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
test('planned targets allow onboarding subsets without reading a changed apply secret', async () => {
  const targets = [{ account_id: '999999999999', resource_type: 'ec2', resource_id: 'i-fixture' }];
  for (const phase of ['plan', 'apply']) {
    const f = fixture({ status: 'ok', mode: 'prepare' });
    const calls = [];
    delete f.dependencies.plannedTargets;
    await prepareRuntimeHost({ ...env, RUNTIME_PREFLIGHT_PHASE: phase, CI_RUNTIME_TARGETS_DEV: 'SECRET_MUST_NOT_BE_USED' }, {
      ...f.dependencies, terraform: (args, options) => {
        calls.push({ args, options });
        return phase === 'apply' ? JSON.stringify({ variables: { runtime_verification_targets: { value: targets } } })
          : JSON.stringify(JSON.stringify(targets));
      },
    });
    assert.deepEqual(f.calls[0].runtimeConfig, { schemaVersion: 1, mode: 'prepare',
      expectedAccountId: env.AWS_ACCOUNT_ID_DEV, expectedMemberTargets: targets, memberRegistryMode: 'onboarding' });
    assert.deepEqual(calls[0].args, phase === 'apply' ? ['show', '-json', 'tfplan'] : ['console', '-no-color']);
    assert.equal(calls[0].options.input, phase === 'plan' ? 'jsonencode(var.runtime_verification_targets)\n' : undefined);
    assert.deepEqual(f.cleaned, [env.SMOKE_CREDENTIAL_FILE]);
  }
});
test('actual registry verification permits initial activation and registered targets in both preflight phases', async () => {
  const target = { account_id: '999999999999', resource_type: 'ec2', resource_id: 'i-fixture' };
  const host = { accountId: env.AWS_ACCOUNT_ID_DEV, isHost: true, enabled: true };
  const member = { accountId: target.account_id, isHost: false, enabled: true };
  for (const phase of ['plan', 'apply']) {
    for (const [accounts, allowed] of [[[host], true], [[host, member], true],
      [[host, { ...member, accountId: '888888888888' }], false]]) {
      const f = fixture();
      delete f.dependencies.plannedTargets;
      const paths = [];
      const result = prepareRuntimeHost({ ...env, RUNTIME_PREFLIGHT_PHASE: phase,
        CI_RUNTIME_TARGETS_DEV: 'NEWER_SECRET_IS_NOT_AUTHORITY' }, {
        ...f.dependencies,
        terraform: () => phase === 'apply'
          ? JSON.stringify({ variables: { runtime_verification_targets: { value: [target] } } })
          : JSON.stringify(JSON.stringify([target])),
        authenticate: ({ runtimeConfig }) => verifyRuntimeSmoke(runtimeConfig, async path => {
          paths.push(path);
          assert.equal(path, '/api/accounts');
          return { accounts };
        }),
      });
      if (allowed) assert.equal((await result).host_registry, 'verified');
      else await assert.rejects(result, /runtime_host_preparation_failed/);
      assert.deepEqual(paths, ['/api/accounts']);
      assert.deepEqual(f.cleaned, [env.SMOKE_CREDENTIAL_FILE]);
    }
  }
});
test('malformed planned scope cannot authenticate and always cleans credentials', async () => {
  const f = fixture({ status: 'ok', mode: 'prepare' });
  await assert.rejects(prepareRuntimeHost(env, { ...f.dependencies, plannedTargets: () => null }),
    /runtime_host_preparation_failed/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.cleaned, [env.SMOKE_CREDENTIAL_FILE]);
});
test('legacy empty preflight defaults to planning while saved explicit null scope fails closed', async () => {
  for (const [phase, response, valid] of [
    [undefined, JSON.stringify('[]'), true],
    ['apply', JSON.stringify({ variables: {} }), true],
    ['apply', JSON.stringify({ variables: { runtime_verification_targets: { value: null } } }), false],
  ]) {
    const f = fixture({ status: 'ok', mode: 'prepare' });
    delete f.dependencies.plannedTargets;
    const result = prepareRuntimeHost({ ...env, RUNTIME_PREFLIGHT_PHASE: phase },
      { ...f.dependencies, terraform: () => response });
    if (valid) {
      assert.equal((await result).host_registry, 'verified');
      assert.equal(f.calls[0].runtimeConfig.hostOnly, true);
    } else {
      await assert.rejects(result, /runtime_host_preparation_failed/);
      assert.equal(f.calls.length, 0);
    }
    assert.deepEqual(f.cleaned, [env.SMOKE_CREDENTIAL_FILE]);
  }
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
