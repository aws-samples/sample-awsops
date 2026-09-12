// Workflow boundaries are executable configuration. Keep the required Plan real,
// and test its bootstrap path without giving fixture code credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openPlan } from './plan-artifact.mjs';
const workflow = readFileSync(new URL('../../../.github/workflows/terraform.yml', import.meta.url), 'utf8');
function job(name) {
  return workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm'))?.[1] ?? '';
}
function stepRun(body, name) {
  const lines = body.split('\n');
  const index = lines.findIndex(line => line.trim() === `- name: ${name}`);
  assert.ok(index >= 0, `missing step ${name}`);
  const runIndex = lines.findIndex((line, i) => i > index && line.trim() === 'run: |');
  assert.ok(runIndex > index);
  const script = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() && !line.startsWith('          ')) break;
    script.push(line.slice(10));
  }
  return script.join('\n');
}

test('PR-authored tests run in a credential-free hosted job, outside Plan', () => {
  const tests = job('guard-tests');
  assert.match(tests, /runs-on: ubuntu-latest/);
  assert.match(tests, /contents: read/);
  assert.doesNotMatch(tests, /id-token: write|secrets\./);
  assert.match(tests, /node --test/);
  assert.match(tests, /terraform init -backend=false -input=false -lockfile=readonly/);
  assert.match(tests, /terraform validate/);
  assert.doesNotMatch(job('plan'), /node --test/);
  assert.doesNotMatch(workflow.split('jobs:')[0], /id-token: write/);
});

test('Plan checks out immutable base config for PRs and names its exact source SHA', () => {
  const plan = job('plan');
  assert.match(plan, /name: Plan\b/);
  assert.match(plan, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/);
  assert.match(plan, /persist-credentials: false/);
  assert.match(plan, /PLAN_SOURCE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/);
  assert.match(plan, /git rev-parse HEAD/);
  assert.match(plan, /terraform plan -out=tfplan/);
  assert.doesNotMatch(plan, /skip=1|Skipping plan/);
  assert.match(plan, /github\.event_name == 'push'/);
});

test('manual apply has a separately reviewed, narrow origin-bootstrap override', () => {
  assert.match(workflow, /reviewed_origin_bootstrap:/);
  assert.match(job('apply'), /REVIEWED_ORIGIN_BOOTSTRAP: \$\{\{ inputs\.reviewed_origin_bootstrap \}\}/);
});

test('failure cleanup works before checkout and preserves unrelated workspace files', () => {
  const root = mkdtempSync(join(tmpdir(), 'awsops-cleanup-'));
  try {
    writeFileSync(join(root, 'retained.txt'), 'keep');
    for (const name of ['plan', 'apply']) {
      const body = job(name);
      const cleanup = body.slice(body.indexOf('- name: Clean sensitive files off the runner'));
      const directory = cleanup.match(/working-directory: (.+)/)?.[1] ?? 'terraform/foundation';
      const result = spawnSync('bash', ['-e', '-c', stepRun(body, 'Clean sensitive files off the runner')], {
        cwd: join(root, directory), encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.equal(readFileSync(join(root, 'retained.txt'), 'utf8'), 'keep');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dev builder configuration is shared and demo/smoke secrets are step scoped', () => {
  const deploy = readFileSync(new URL('../../../.github/workflows/deploy-web.yml', import.meta.url), 'utf8');
  for (const name of ['dev-core', 'dev-images', 'dev-release']) {
    const block = deploy.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm'))[1];
    const beforeSteps = block.split('    steps:')[0];
    assert.doesNotMatch(beforeSteps, /TF_VAR_demo_password|SMOKE_SECRET_ARN/);
    if (name === 'dev-images') assert.match(beforeSteps, /DOCKER_CONFIG:/);
    assert.match(block, /Preserve encrypted failure diagnostics/);
  }
});

test('a trusted bootstrap base without helpers still executes a real plan; errors stay failures', () => {
  const plan = job('plan');
  const prepare = stepRun(plan, 'Prepare the trusted dev stage when supported');
  const command = stepRun(plan, 'terraform plan');
  const root = mkdtempSync(join(tmpdir(), 'awsops-plan-bootstrap-'));
  try {
    mkdirSync(join(root, 'terraform/foundation'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/terraform'), `#!/bin/sh
printf '%s\\n' "$*" >> "$PLAN_CALLS"
test "$1" = plan || exit 29
exit "\${PLAN_EXIT:-0}"
`, { mode: 0o700 });
    const env = { ...process.env, TARGET: 'dev', PLAN_SOURCE_SHA: 'a'.repeat(40),
      PATH: `${join(root, 'bin')}:${process.env.PATH}`, PLAN_CALLS: join(root, 'calls'),
      GITHUB_STEP_SUMMARY: join(root, 'summary') };
    let result = spawnSync('bash', ['-euo', 'pipefail', '-c', prepare], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync('bash', ['-euo', 'pipefail', '-c', command], {
      cwd: join(root, 'terraform/foundation'), env, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, 'calls'), 'utf8'), /^plan -out=tfplan/m);
    assert.doesNotMatch(readFileSync(join(root, 'calls'), 'utf8'), /validate|var-file/);
    result = spawnSync('bash', ['-euo', 'pipefail', '-c', command], {
      cwd: join(root, 'terraform/foundation'), env: { ...env, PLAN_EXIT: '1' }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    writeFileSync(join(root, 'terraform/foundation/tfplan.log'), 'private-bootstrap-diagnostic');
    const diagnosticsOutput = join(root, 'diagnostics-output');
    result = spawnSync('bash', ['-euo', 'pipefail', '-c', stepRun(plan, 'Preserve encrypted failure diagnostics')], {
      cwd: root, env: { ...env, RUNNER_TEMP: join(root, 'temp'), GITHUB_OUTPUT: diagnosticsOutput,
        TF_PLAN_ENC_KEY: 'example-bootstrap-key' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const diagnostics = Object.fromEntries(readFileSync(diagnosticsOutput, 'utf8').trim().split('\n').map(line => line.split('=')));
    assert.equal(diagnostics.encrypted, 'true');
    const logs = JSON.parse(openPlan(readFileSync(diagnostics.path), { kind: 'failure-diagnostics' }, 'example-bootstrap-key'));
    assert.equal(logs['tfplan.log'], 'private-bootstrap-diagnostic');
    assert.doesNotMatch(result.stdout + result.stderr, /private-bootstrap-diagnostic/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
