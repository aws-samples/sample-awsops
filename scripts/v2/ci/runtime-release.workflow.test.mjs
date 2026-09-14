import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function workflow(name) {
  return JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,yaml; d=yaml.safe_load(open(sys.argv[1])); d["on"]=d.pop(True,d.get("on")); print(json.dumps(d))',
    join(root, '.github/workflows', name)], { encoding: 'utf8' }));
}
const named = (job, name) => {
  const value = job.steps.find(s => s.name === name);
  assert.ok(value, name);
  return value;
};

test('all dev web releases require private preparation, contract capture and full runtime gate', () => {
  const w = workflow('deploy-web.yml');
  const job = w.jobs.deploy;
  for (const name of ['Prepare configured demo credentials', 'Capture development runtime contract',
    'Authenticated development runtime readiness']) {
    const step = named(job, name);
    assert.equal(step.if, "github.ref == 'refs/heads/dev'");
    assert.notEqual(step['continue-on-error'], true);
  }
  const gate = named(job, 'Authenticated development runtime readiness');
  assert.equal(job.env.RUNTIME_MODE, 'collect');
  assert.equal(gate.env.RUNTIME_DEPLOYMENT_FILE, '${{ steps.runtime.outputs.deployment_file }}');
  assert.equal(gate.env.SMOKE_CREDENTIAL_FILE, '${{ steps.demo.outputs.credential_file }}');
  assert.match(gate.run, /node scripts\/v2\/ci\/runtime-release.mjs run/);
  assert.doesNotMatch(gate.run, /authenticated-smoke.mjs|verify_database|CI_READONLY_RUNTIME_DEV/);
  assert.ok(job.steps.indexOf(gate) > job.steps.indexOf(named(job, 'Wait for services-stable')));
  assert.ok(job.steps.indexOf(named(job, 'Capture development runtime contract')) <
    job.steps.indexOf(named(job, 'Clean restored terraform config off the runner')));
  const capture = job.steps.indexOf(named(job, 'Capture development runtime contract'));
  const mutations = job.steps.filter(step => /ecr put-image|ecs update-service/.test(step.run || ''));
  assert.equal(mutations.length, 2);
  assert.ok(mutations.every(step => capture < job.steps.indexOf(step)));
  assert.equal(named(job, 'Clean prepared demo credentials off the runner').if,
    "always() && github.ref == 'refs/heads/dev'");
});

test('dev build and deployment bind configured and actual CI account before ECR or ECS writes', () => {
  const w = workflow('deploy-web.yml');
  for (const job of [w.jobs.build, w.jobs.deploy]) {
    assert.equal(job.env.AWS_ACCOUNT_ID_DEV, '${{ secrets.AWS_ACCOUNT_ID_DEV }}');
    const steps = job.steps;
    const configured = steps.findIndex(s => s.run?.includes('ci_runtime_policy.py verify-role'));
    const credentials = steps.findIndex(s => s.uses?.startsWith('aws-actions/configure-aws-credentials'));
    const actual = steps.findIndex(s => s.run?.includes('ci_runtime_policy.py verify-caller'));
    assert.ok(configured >= 0 && configured < credentials && actual > credentials);
    assert.equal(steps[configured].if, "github.ref == 'refs/heads/dev'");
    assert.equal(steps[actual].if, "github.ref == 'refs/heads/dev'");
    assert.ok(actual < steps.findIndex(s => s.name?.startsWith('Verify the web ECR') ||
      s.name === 'Pin web-latest to the approved image'));
  }
});

test('manual preparation/collection is dev-only and does not build, deploy or change AWS infrastructure', () => {
  const w = workflow('collect-runtime.yml');
  assert.deepEqual(Object.keys(w.on), ['workflow_dispatch']);
  assert.deepEqual(w.on.workflow_dispatch.inputs.mode.options, ['prepare', 'collect']);
  const job = w.jobs.verify;
  assert.equal(job.environment, 'development');
  assert.equal(job.env.RUNTIME_MODE, '${{ inputs.mode }}');
  assert.equal(job.env.PIN_SHA, '${{ inputs.image_sha }}');
  assert.equal(job.env.AWS_ACCOUNT_ID_DEV, '${{ secrets.AWS_ACCOUNT_ID_DEV }}');
  const guard = named(w.jobs.guard, 'Validate manual development operation');
  const good = { GITHUB_REPOSITORY: 'aws-samples/sample-awsops', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/dev', MODE: 'prepare', IMAGE_SHA: '' };
  for (const change of [{}, { MODE: 'collect', IMAGE_SHA: 'a'.repeat(40) },
    { MODE: 'collect' }, { MODE: 'prepare', IMAGE_SHA: 'a'.repeat(40) },
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'push' }]) {
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', guard.run],
      { env: { ...process.env, ...good, ...change } });
    assert.equal(r.status === 0, Object.keys(change).length === 0 || (change.MODE === 'collect' && Boolean(change.IMAGE_SHA)));
  }
  assert.doesNotMatch(JSON.stringify(job), /update-service|put-image|terraform apply|build-push-action|admin-create-user|admin-set-user-password/);
  assert.match(named(job, 'Run development collection operation').run, /runtime-release.mjs run/);
  assert.equal(named(job, 'Clean private development files').if, 'always()');
});
