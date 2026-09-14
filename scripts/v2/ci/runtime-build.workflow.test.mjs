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
function assertAccountGuards(job, migration = false) {
  assert.equal(job.env.AWS_ACCOUNT_ID_DEV, '${{ secrets.AWS_ACCOUNT_ID_DEV }}');
  const steps = job.steps;
  const suffix = migration ? 'migration-role' : 'role';
  const before = steps.findIndex(s => s.run?.includes(`runtime-build.mjs check-${suffix}`));
  const after = steps.findIndex(s => s.run?.includes(`runtime-build.mjs verify-${suffix}`));
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
  assert.equal(w.jobs.build.env.AWS_ACCOUNT_ID_DEV, '${{ secrets.AWS_ACCOUNT_ID_DEV }}');
  assert.equal(w.jobs.build.env.RUNTIME_ROLE_ARN, '${{ secrets.AWS_CI_BUILD_DEV_ROLE_ARN }}');
  const migration = workflow('deploy-migrations.yml');
  assert.equal(w.jobs.build.environment, undefined, 'The build role requires a branch-ref OIDC subject');
  assert.equal(migration.jobs.build.environment, undefined);
  assert.equal(migration.jobs.migrate.environment, 'development', 'Deployer environment protection remains');
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
  const names = ['TF_TFVARS_DEV', 'TF_BACKEND_HCL_DEV', 'AWS_ACCOUNT_ID_DEV',
    'AWS_CI_BUILD_DEV_ROLE_ARN', 'AWS_CI_DEPLOYER_DEV_ROLE_ARN'];
  assert.deepEqual(agent.jobs['migrate-dev'].secrets,
    Object.fromEntries(names.map(name => [name, '${{ secrets.' + name + ' }}'])));
  assert.deepEqual(w.on.workflow_call.secrets,
    Object.fromEntries(names.map(name => [name, { required: true }])));
  assert.match(agent.jobs['migrate-dev'].if, /refs\/heads\/dev/);
  assert.deepEqual(agent.jobs.deploy.needs, ['migrate-dev']);
  assert.match(agent.jobs.deploy.if, /needs.migrate-dev.result == 'success'/);
  assert.notEqual(agent.concurrency?.group, w.concurrency.group);
});

test('migration checks expected account and actual STS caller before build, execution and cleanup', () => {
  const w = workflow('deploy-migrations.yml');
  for (const name of ['build', 'migrate']) {
    const index = assertAccountGuards(w.jobs[name], true);
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

test('manual runtime image setup precedes a fresh one-hour session and bounded build step', () => {
  const job = workflow('build-runtime-images.yml').jobs.build;
  const steps = job.steps;
  const credentials = credentialsIndex(steps);
  for (const action of ['docker/setup-qemu-action', 'docker/setup-buildx-action']) {
    assert.ok(steps.findIndex(s => s.uses?.startsWith(action)) < credentials);
  }
  assert.equal(steps[credentials].with['role-duration-seconds'], 3600);
  assert.equal(steps[credentials].with['unset-current-credentials'], true);
  assert.ok(job['timeout-minutes'] <= 60);
  const build = steps.find(s => s.id === 'image');
  assert.ok(steps.indexOf(build) > credentials);
  assert.ok(build['timeout-minutes'] <= 50);
});

test('dev AgentCore refreshes the same role between build-only and digest-bound provision-only', () => {
  const job = workflow('deploy-agentcore.yml').jobs.deploy;
  const steps = job.steps;
  const buildCred = steps.findIndex(s => s.name === 'Fresh development credentials for image build');
  const buildCheck = steps.findIndex(s => s.name === 'Verify refreshed development build caller');
  const build = steps.findIndex(s => s.id === 'agent_image');
  const provisionCred = steps.findIndex(s => s.name === 'Fresh development credentials for provisioning');
  const provisionCheck = steps.findIndex(s => s.name === 'Verify refreshed development provision caller');
  const provision = steps.findIndex(s => s.name === 'Provision verified development agent image');
  assert.ok(buildCred > steps.findIndex(s => s.uses?.startsWith('docker/setup-buildx-action')));
  assert.ok(buildCred > steps.findIndex(s => s.run?.includes('npm ci')));
  assert.ok(buildCred < buildCheck && buildCheck < build && build < provisionCred &&
    provisionCred < provisionCheck && provisionCheck < provision);
  for (const i of [buildCred, provisionCred]) {
    assert.equal(steps[i].if, "github.ref == 'refs/heads/dev'");
    assert.equal(steps[i].with['role-to-assume'], '${{ secrets.AWS_CI_DEPLOYER_DEV_ROLE_ARN }}');
    assert.equal(steps[i].with['role-duration-seconds'], 3600);
    assert.equal(steps[i].with['unset-current-credentials'], true);
  }
  for (const i of [buildCheck, provisionCheck]) {
    assert.match(steps[i].run, /get-caller-identity/);
    assert.match(steps[i].run, /runtime-build.mjs verify-role/);
    assert.ok(steps[i]['timeout-minutes'] <= 2);
  }
  assert.match(steps[build].run, /agentcore.mjs --build-only/);
  assert.match(steps[provision].run, /agentcore.mjs --provision-only/);
  assert.equal(steps[provision].env.AGENT_IMAGE_DIGEST, '${{ steps.agent_image.outputs.digest }}');
  assert.equal(steps[provision].env.AGENT_IMAGE_PROJECT, '${{ steps.agent_image.outputs.project }}');
  assert.ok(steps[build]['timeout-minutes'] <= 52 && steps[provision]['timeout-minutes'] <= 52);
  assert.equal(steps.find(s => s.name === 'make agentcore').if, "github.ref != 'refs/heads/dev'");
});

test('AgentCore prepares pinned Python SDK before AWS/image work and cleans its private packages', () => {
  const w = workflow('deploy-agentcore.yml');
  const job = w.jobs.deploy;
  const setup = job.steps.find(s => s.uses === 'actions/setup-python@v5');
  assert.equal(setup?.with['python-version'], '3.12');
  const prepare = job.steps.find(s => s.name === 'Prepare isolated AgentCore provisioner SDK');
  assert.ok(prepare);
  assert.ok(job.steps.indexOf(prepare) < job.steps.findIndex(s => s.uses?.startsWith('aws-actions/configure-aws-credentials')));
  assert.match(prepare.run, /setup-provision-python.py prepare/);
  const cleanup = job.steps.find(s => s.name === 'Clean AgentCore provisioner SDK');
  assert.ok(cleanup.if.includes('always()'));
  assert.match(cleanup.run, /setup-provision-python.py cleanup/);
});
