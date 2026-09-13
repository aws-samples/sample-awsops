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
function credentialsIndex(steps) {
  return steps.findIndex(s => s.uses?.startsWith('aws-actions/configure-aws-credentials'));
}
function assertAccountGuards(job) {
  assert.equal(job.env.AWS_ACCOUNT_ID_DEV, '${{ vars.AWS_ACCOUNT_ID_DEV }}');
  const steps = job.steps;
  const before = steps.findIndex(s => s.run?.includes('runtime-build.mjs check-role'));
  const after = steps.findIndex(s => s.run?.includes('runtime-build.mjs verify-role'));
  assert.ok(before >= 0 && before < credentialsIndex(steps));
  assert.ok(after > credentialsIndex(steps));
  return after;
}

test('backend builds are manual dev only, component-limited and hand off no account-bearing URI', () => {
  const w = workflow('build-runtime-images.yml');
  assert.deepEqual(Object.keys(w.on), ['workflow_dispatch']);
  assert.deepEqual(w.on.workflow_dispatch.inputs.component.options, ['steampipe', 'worker']);
  assert.deepEqual(Object.keys(w.jobs.build.outputs).sort(), ['digest', 'project']);
  assert.deepEqual(w.jobs.build.needs, ['guard']);
  assert.equal(w.jobs.build.env.AWS_ACCOUNT_ID_DEV, '${{ vars.AWS_ACCOUNT_ID_DEV }}');
  assert.equal(w.jobs.build.env.RUNTIME_ROLE_ARN, '${{ secrets.AWS_CI_BUILD_DEV_ROLE_ARN }}');
  const base = { GITHUB_REPOSITORY: 'aws-samples/sample-awsops', GITHUB_REF: 'refs/heads/dev',
    GITHUB_EVENT_NAME: 'workflow_dispatch', COMPONENT: 'worker' };
  for (const change of [{}, { GITHUB_REF: 'refs/heads/main' }, { COMPONENT: 'agent' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: 'wrong/repo' }]) {
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', w.jobs.guard.steps[0].run],
      { env: { ...process.env, ...base, ...change } });
    assert.equal(r.status === 0, Object.keys(change).length === 0);
  }
  const steps = w.jobs.build.steps;
  assert.ok(steps.findIndex(s => s.run?.includes('check-role')) < credentialsIndex(steps));
  assert.ok(!JSON.stringify(w).match(/create-repository|create-role|:latest/));
});

test('reusable migration keeps original caller dispatch guard and separate concurrency', () => {
  const w = workflow('deploy-migrations.yml');
  assert.deepEqual(Object.keys(w.on).sort(), ['workflow_call', 'workflow_dispatch']);
  assert.match(w.jobs.guard.steps[0].run, /GITHUB_EVENT_NAME" = "workflow_dispatch"/);
  assert.doesNotMatch(w.jobs.guard.steps[0].run, /workflow_call/);
  const agent = workflow('deploy-agentcore.yml');
  assert.equal(agent.jobs['migrate-dev'].uses, './.github/workflows/deploy-migrations.yml');
  assert.equal(agent.jobs['migrate-dev'].secrets, 'inherit');
  assert.match(agent.jobs['migrate-dev'].if, /refs\/heads\/dev/);
  assert.deepEqual(agent.jobs.deploy.needs, ['migrate-dev']);
  assert.match(agent.jobs.deploy.if, /needs.migrate-dev.result == 'success'/);
  assert.notEqual(agent.concurrency?.group, w.concurrency.group);
});

test('migration checks expected account and actual STS caller before build, execution and cleanup', () => {
  const w = workflow('deploy-migrations.yml');
  for (const name of ['build', 'migrate']) {
    const index = assertAccountGuards(w.jobs[name]);
    const steps = w.jobs[name].steps;
    const write = steps.findIndex(s => s.uses?.startsWith('docker/build-push-action') ||
      s.name === 'Read migration output and run');
    assert.ok(index < write);
  }
  const cleanup = w.jobs.migrate.steps.find(s => s.name === 'Stop only this run task if necessary');
  assert.match(cleanup.if, /steps.account.outcome == 'success'/);
});

test('AgentCore dev waits for private migration and uses strict account guards without runner DB migration', () => {
  const w = workflow('deploy-agentcore.yml');
  const after = assertAccountGuards(w.jobs.deploy);
  const steps = w.jobs.deploy.steps;
  const migrate = steps.find(s => s.name === 'make migrate');
  assert.equal(migrate.if, "github.ref != 'refs/heads/dev'");
  assert.ok(after < steps.findIndex(s => s.name === 'Restore terraform.foundation backend'));
  assert.equal(w.jobs.deploy.env.DOCKER, "${{ github.ref == 'refs/heads/dev' && 'docker' || 'sudo docker' }}");
  assert.match(w.jobs.deploy.env.AGENT_IMAGE_TAG, /agent-\{0\}.*github.sha/);
});
