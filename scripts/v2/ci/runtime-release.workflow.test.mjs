import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

test('producer proof precedes migration and its digest reaches promotion, exact verification and runtime readiness', () => {
  const { build, 'image-proof': proof, 'migrate-dev': migrate, deploy } = workflow('deploy-web.yml').jobs;
  // The Python controller tests exercise actual guarded publication and receipts.
  // This contract verifies that the workflow passes their evidence between jobs.
  const image = named(build, 'Build and push (arm64)');
  const receipt = named(build, 'Record the image producer');
  const retained = named(build, 'Retain the build receipt for explicit reuse');
  assert.equal(image.id, 'image');
  assert.equal(image.with.platforms, 'linux/arm64');
  assert.equal(build.outputs.digest, '${{ steps.image.outputs.digest }}');
  assert.equal(build.outputs.project, '${{ steps.stack.outputs.project }}');
  assert.equal(receipt.env.IMAGE_DIGEST, build.outputs.digest);
  assert.equal(receipt.env.IMAGE_PROJECT, build.outputs.project);
  assert.match(receipt.run, /ci_web_image\.py receipt/);
  assert.ok(build.steps.indexOf(image) < build.steps.indexOf(receipt));
  assert.ok(build.steps.indexOf(receipt) < build.steps.indexOf(retained));
  assert.equal(retained.with['if-no-files-found'], 'error');
  assert.deepEqual(proof.needs, ['guard', 'build']);
  const preflight = named(proof, 'Verify producer receipt and ECR content without mutation');
  assert.equal(preflight.id, 'proof');
  assert.equal(preflight.run.trim(), 'python3 scripts/v2/ci_web_deploy.py preflight-image');
  assert.equal(preflight.env.FRESH_DIGEST, '${{ needs.build.outputs.digest }}');
  assert.equal(preflight.env.FRESH_PROJECT, '${{ needs.build.outputs.project }}');
  assert.equal(preflight.env.IMAGE_BUILD_RUN_ID, '${{ inputs.image_build_run_id }}');
  assert.equal(proof.outputs.digest, '${{ steps.proof.outputs.digest }}');
  assert.deepEqual(migrate.needs, ['guard', 'image-proof']);
  for (const job of [migrate, deploy]) {
    assert.match(job.if, /needs\.image-proof\.result == 'success'/);
    assert.match(job.if, /needs\.image-proof\.outputs\.digest != ''/);
  }
  assert.deepEqual(deploy.needs, ['guard', 'build', 'image-proof', 'migrate-dev']);
  const pin = named(deploy, 'Promote the verified image and start its deployment');
  const exact = named(deploy, 'Verify exact deployment and healthy running web image');
  const gate = named(deploy, 'Authenticated development runtime readiness');
  assert.equal(pin.id, 'pin');
  assert.equal(pin.run.trim(), 'python3 scripts/v2/ci_web_deploy.py deploy');
  assert.equal(pin.env.PREFLIGHT_DIGEST, '${{ needs.image-proof.outputs.digest }}');
  assert.equal(pin.env.FRESH_DIGEST, preflight.env.FRESH_DIGEST);
  assert.equal(pin.env.FRESH_PROJECT, preflight.env.FRESH_PROJECT);
  assert.equal(pin.env.PIN_SHA, preflight.env.PIN_SHA);
  assert.equal(pin.env.IMAGE_BUILD_RUN_ID, preflight.env.IMAGE_BUILD_RUN_ID);
  assert.equal(pin.env.MIGRATED_SHA, '${{ needs.migrate-dev.outputs.source_sha }}');
  assert.equal(pin.env.MIGRATED_PROJECT, '${{ needs.migrate-dev.outputs.project }}');
  assert.equal(exact.run.trim(), 'python3 scripts/v2/ci_web_deploy.py verify');
  for (const [key, output] of Object.entries({
    WEB_DIGEST: 'digest', WEB_RUNTIME_DIGEST: 'runtime_digest',
    WEB_DEPLOYMENT_ID: 'deployment_id', WEB_OLD_DEPLOYMENT_ID: 'old_deployment_id',
    WEB_TASK_REVISION: 'task_revision', WEB_DESIRED_COUNT: 'desired_count',
  })) assert.equal(exact.env[key], `\${{ steps.pin.outputs.${output} }}`);
  assert.equal(gate.env.EXPECTED_WEB_DIGEST, exact.env.WEB_DIGEST);
  assert.equal(deploy.outputs.expected_image_digest, exact.env.WEB_DIGEST);
  assert.equal(deploy.outputs.expected_runtime_digest, exact.env.WEB_RUNTIME_DIGEST);
  assert.ok(deploy.steps.indexOf(pin) < deploy.steps.indexOf(exact));
  assert.ok(deploy.steps.indexOf(exact) < deploy.steps.indexOf(gate));
  for (const step of deploy.steps)
    assert.doesNotMatch(step.run || '', /\becr\s+(?:batch-get-image|put-image)\b|\becs\s+update-service\b/);
});

test('all dev web releases require private preparation, contract capture and full runtime gate', () => {
  const w = workflow('deploy-web.yml');
  const job = w.jobs.deploy;
  for (const name of ['Prepare configured demo credentials', 'Capture development runtime contract',
    'Build restricted workload verification session', 'Authenticated development runtime readiness']) {
    const step = named(job, name);
    assert.equal(step.if, "github.ref == 'refs/heads/dev'");
    assert.notEqual(step['continue-on-error'], true);
  }
  const gate = named(job, 'Authenticated development runtime readiness');
  assert.equal(job.env.RUNTIME_MODE, 'collect');
  assert.equal(job.env.INVENTORY_POLICY, 'full');
  assert.equal(job.env.TARGET, '${{ github.ref_name }}');
  assert.equal(job.env.AWS_REGION, 'ap-northeast-2');
  assert.equal(job.env.CI_ROLE_ARN, '${{ secrets.AWS_CI_DEPLOYER_DEV_ROLE_ARN }}');
  assert.equal(job.env.PIN_SHA, '${{ inputs.image_sha || github.sha }}');
  assert.equal(gate.env.RUNTIME_MODE, undefined);
  assert.equal(gate.env.INVENTORY_POLICY, undefined);
  assert.equal(gate.env.RUNTIME_DEPLOYMENT_FILE, '${{ steps.runtime.outputs.deployment_file }}');
  assert.equal(gate.env.SMOKE_CREDENTIAL_FILE, '${{ steps.demo.outputs.credential_file }}');
  assert.equal(gate.env.EXPECTED_WEB_DIGEST, '${{ steps.pin.outputs.digest }}');
  assert.equal(named(job, 'Promote the verified image and start its deployment').id, 'pin');
  assert.match(gate.run, /node scripts\/v2\/ci\/runtime-release.mjs run/);
  assert.doesNotMatch(gate.run, /authenticated-smoke.mjs|verify_database|CI_READONLY_RUNTIME_DEV/);
  const ordered = [
    'Prepare configured demo credentials',
    'Resolve ECS cluster/service/URL + ECR repo',
    'Capture development runtime contract',
    'Clean restored terraform config off the runner',
    'Promote the verified image and start its deployment',
    'Verify exact deployment and healthy running web image',
    'Smoke test',
    'Build restricted workload verification session',
    'Refresh development credentials for runtime verification',
    'Authenticated development runtime readiness',
  ].map(name => job.steps.indexOf(named(job, name)));
  for (let index = 1; index < ordered.length; index++)
    assert.ok(ordered[index - 1] < ordered[index], 'release proof order');
  assert.ok(job.steps.indexOf(named(job, 'Capture development runtime contract')) <
    job.steps.indexOf(named(job, 'Clean restored terraform config off the runner')));
  const capture = job.steps.indexOf(named(job, 'Capture development runtime contract'));
  const mutations = job.steps.filter(step =>
    /ci_web_deploy\.py deploy|\becr\s+put-image\b|\becs\s+update-service\b/.test(step.run || ''));
  assert.deepEqual(mutations, [named(job, 'Promote the verified image and start its deployment')]);
  assert.ok(mutations.every(step => capture < job.steps.indexOf(step)));
  assert.equal(named(job, 'Clean prepared demo credentials off the runner').if,
    "always() && github.ref == 'refs/heads/dev'");
});

test('Deploy Web always cleans its captured Terraform cache without deleting other run files', () => {
  const job = workflow('deploy-web.yml').jobs.deploy;
  const cleanup = named(job, 'Clean restored terraform config off the runner');
  assert.equal(cleanup.if, 'always()');
  assert.equal(cleanup['working-directory'], 'terraform/foundation');
  assert.equal(job.steps.indexOf(cleanup),
    job.steps.indexOf(named(job, 'Capture development runtime contract')) + 1);
  assert.ok(job.steps.indexOf(cleanup) <
    job.steps.indexOf(named(job, 'Promote the verified image and start its deployment')));
  for (const inputsPresent of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'terraform-cleanup-'));
    const foundation = join(dir, cleanup['working-directory']);
    const sibling = join(dir, 'other-checkout/.terraform');
    try {
      mkdirSync(join(foundation, '.terraform'), { recursive: true });
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(foundation, '.terraform/terraform.tfstate'), 'PRIVATE_BACKEND_CACHE');
      writeFileSync(join(sibling, 'terraform.tfstate'), 'other-run-cache');
      writeFileSync(join(foundation, 'tfplan'), 'saved-plan');
      writeFileSync(join(foundation, '.terraform.lock.hcl'), 'provider-lock');
      const credentials = join(dir, 'credentials.json');
      writeFileSync(credentials, 'captured-proof-credentials', { mode: 0o600 });
      if (inputsPresent) for (const name of ['backend.hcl', 'terraform.tfvars'])
        writeFileSync(join(foundation, name), 'PRIVATE_RESTORED_INPUT');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', cleanup.run],
        { cwd: foundation, encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: dir } });
      assert.equal(result.status, 0, result.stderr);
      for (const name of ['backend.hcl', 'terraform.tfvars', '.terraform'])
        assert.equal(existsSync(join(foundation, name)), false, name);
      assert.equal(readFileSync(join(sibling, 'terraform.tfstate'), 'utf8'), 'other-run-cache');
      assert.equal(readFileSync(join(foundation, 'tfplan'), 'utf8'), 'saved-plan');
      assert.equal(readFileSync(join(foundation, '.terraform.lock.hcl'), 'utf8'), 'provider-lock');
      assert.equal(readFileSync(credentials, 'utf8'), 'captured-proof-credentials');
      assert.equal(result.stdout + result.stderr, '');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('the real runtime gate passes a private credential file without an inline proof password', () => {
  const gate = named(workflow('deploy-web.yml').jobs.deploy, 'Authenticated development runtime readiness');
  assert.equal(gate.env.SMOKE_CREDENTIAL_FILE, '${{ steps.demo.outputs.credential_file }}');
  assert.doesNotMatch(JSON.stringify(gate.env), /TF_VAR_DEMO_PASSWORD|SMOKE_PASSWORD|demo_password/i);
  assert.doesNotMatch(gate.run, /--password|TF_VAR_demo_password|SMOKE_PASSWORD/i);
  const dir = mkdtempSync(join(tmpdir(), 'runtime-gate-'));
  try {
    const credentials = join(dir, 'credentials.json');
    const capture = join(dir, 'controller-input.json');
    writeFileSync(credentials, JSON.stringify({ email: 'fixture@example.com', password: 'PRIVATE_PROOF_PASSWORD' }),
      { mode: 0o600 });
    writeFileSync(join(dir, 'node'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.SMOKE_CREDENTIAL_FILE;
const proof = JSON.parse(fs.readFileSync(file, 'utf8'));
if ((fs.statSync(file).mode & 0o777) !== 0o600) process.exit(90);
if (JSON.stringify({ args, env: process.env }).includes(proof.password)) process.exit(91);
fs.writeFileSync(process.env.TEST_GATE_CAPTURE, JSON.stringify({ args, credential_file: file }));
`, { mode: 0o700 });
    const values = {
      '${{ steps.tf.outputs.url }}': 'https://dev.example.com',
      '${{ steps.tf.outputs.cloudfront_domain }}': 'd123.cloudfront.net',
      '${{ steps.demo.outputs.credential_file }}': credentials,
      '${{ steps.runtime.outputs.deployment_file }}': join(dir, 'runtime-deployment.json'),
      '${{ steps.workload_session.outputs.session_policy }}': 'restricted-policy',
      '${{ steps.pin.outputs.digest }}': `sha256:${'a'.repeat(64)}`,
    };
    const env = Object.fromEntries(Object.entries(gate.env).map(([key, expression]) => {
      assert.ok(Object.hasOwn(values, expression), key);
      return [key, values[expression]];
    }));
    const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', gate.run], {
      cwd: root, encoding: 'utf8',
      env: { ...env, PATH: `${dir}:${process.env.PATH}`, TEST_GATE_CAPTURE: capture },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      args: ['scripts/v2/ci/runtime-release.mjs', 'run'], credential_file: credentials,
    });
    assert.equal(result.stdout + result.stderr, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dev runtime identity and all-branch image identity both precede ECR access or deployment', () => {
  const w = workflow('deploy-web.yml');
  for (const [job, role, boundary] of [
    [w.jobs.build, 'AWS_CI_BUILD_DEV_ROLE_ARN', 'Verify the web ECR repository exists before building'],
    [w.jobs.deploy, 'AWS_CI_DEPLOYER_DEV_ROLE_ARN', 'Promote the verified image and start its deployment'],
  ]) {
    assert.equal(job.env.AWS_ACCOUNT_ID_DEV, '${{ secrets.AWS_ACCOUNT_ID_DEV }}');
    assert.equal(job.env.CI_ROLE_ARN, `\${{ secrets.${role} }}`);
    const steps = job.steps;
    const configured = steps.findIndex(s => s.run?.includes('ci_runtime_policy.py verify-role'));
    const credentials = steps.findIndex(s => s.uses?.startsWith('aws-actions/configure-aws-credentials'));
    const actual = steps.findIndex(s => s.run?.includes('ci_runtime_policy.py verify-caller'));
    assert.ok(configured >= 0 && configured < credentials && actual > credentials);
    assert.equal(steps[configured].if, "github.ref == 'refs/heads/dev'");
    assert.equal(steps[actual].if, "github.ref == 'refs/heads/dev'");
    const operation = steps.indexOf(named(job, boundary));
    assert.ok(actual < operation);
    assert.equal(steps[credentials].with['role-to-assume'], '${{ steps.sel.outputs.role }}');
    const imageConfigured = steps.findIndex(s => s.run?.includes('ci_web_image.py check-role'));
    const imageActual = steps.findIndex(s => s.run?.includes('ci_web_image.py verify-role'));
    assert.ok(imageConfigured >= 0 && imageConfigured < credentials);
    assert.ok(imageActual > credentials && imageActual < operation);
    for (const step of [steps[imageConfigured], steps[imageActual]]) {
      assert.equal(step.if, undefined, 'image identity checks must cover every branch');
      assert.equal(step.env.CI_ROLE_ARN, '${{ steps.sel.outputs.role }}');
      assert.notEqual(step['continue-on-error'], true);
    }
    for (const step of steps.filter(s => /ci_web_(?:image|deploy)\.py/.test(s.run || '')))
      assert.equal(step.env.CI_ROLE_ARN, '${{ steps.sel.outputs.role }}');
  }
});

test('manual preparation/collection is dev-only and does not build, deploy or change AWS infrastructure', () => {
  const w = workflow('collect-runtime.yml');
  assert.deepEqual(Object.keys(w.on), ['workflow_dispatch']);
  assert.deepEqual(w.on.workflow_dispatch.inputs.mode.options, ['prepare', 'collect']);
  assert.equal(w.on.workflow_dispatch.inputs.inventory_policy, undefined);
  const job = w.jobs.verify;
  assert.equal(job.environment, 'development');
  assert.equal(job.env.RUNTIME_MODE, '${{ inputs.mode }}');
  assert.equal(job.env.INVENTORY_POLICY, 'full');
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

test('manual collection removes restored Terraform secrets immediately after capture', () => {
  const job = workflow('collect-runtime.yml').jobs.verify;
  const capture = job.steps.indexOf(named(job, 'Capture current development outputs'));
  const cleanup = named(job, 'Remove captured Terraform inputs');
  const gate = job.steps.indexOf(named(job, 'Run development collection operation'));
  assert.equal(job.steps.indexOf(cleanup), capture + 1);
  assert.ok(job.steps.indexOf(cleanup) < gate);
  assert.match(cleanup.run, /rm -f terraform\/foundation\/backend.hcl terraform\/foundation\/terraform.tfvars/);
  assert.equal(named(job, 'Clean private development files').if, 'always()');
});

test('manual verification requires separate backend and workload session policies', () => {
  const job = workflow('collect-runtime.yml').jobs.verify;
  const assumes = job.steps.filter(s => s.uses?.startsWith('aws-actions/configure-aws-credentials'));
  assert.equal(assumes.length, 2);
  for (const [step, phase, duration] of [[assumes[0], 'backend_session', 1800],
    [assumes[1], 'workload_session', 3600]]) {
    assert.equal(step.with['inline-session-policy'], `\${{ steps.${phase}.outputs.session_policy }}`);
    assert.equal(step.if, `\${{ success() && steps.${phase}.outputs.session_policy != '' }}`);
    assert.equal(step.with['role-duration-seconds'], duration);
    assert.equal(step.with['unset-current-credentials'], true);
    assert.ok(job.steps.findIndex(s => s.id === phase) < job.steps.indexOf(step));
  }
  assert.ok(job.steps.findIndex(s => s.id === 'backend_session') <
    job.steps.indexOf(named(job, 'Restore private development inputs')));
  assert.ok(job.steps.indexOf(named(job, 'Remove captured Terraform inputs')) <
    job.steps.findIndex(s => s.id === 'workload_session'));
});

test('missing session policy fails before caller or runtime commands can run', () => {
  const job = workflow('collect-runtime.yml').jobs.verify;
  for (const [current, name, variable] of [
    [job, 'Verify actual development caller', 'BACKEND_SESSION_POLICY'],
    [job, 'Run development collection operation', 'WORKLOAD_SESSION_POLICY'],
    [workflow('deploy-web.yml').jobs.deploy, 'Authenticated development runtime readiness', 'WORKLOAD_SESSION_POLICY'],
  ]) {
    const guarded = 'aws(){ echo UNGUARDED_COMMAND >&2; exit 9; }\n'
      + 'node(){ echo UNGUARDED_COMMAND >&2; exit 9; }\n' + named(current, name).run;
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', guarded], {
      cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, [variable]: '',
        AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: '/dev/null',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null' },
    });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /UNGUARDED_COMMAND/);
  }
});

test('verification refreshes the same dev role after setup and stays within the new session', () => {
  for (const [file, jobName, gateName] of [['collect-runtime.yml', 'verify', 'Run development collection operation'],
    ['deploy-web.yml', 'deploy', 'Authenticated development runtime readiness']]) {
    const job = workflow(file).jobs[jobName];
    const refresh = named(job, 'Refresh development credentials for runtime verification');
    const gate = named(job, gateName);
    assert.equal(refresh.with['inline-session-policy'], '${{ steps.workload_session.outputs.session_policy }}');
    assert.match(refresh.if, /steps.workload_session.outputs.session_policy != ''/);
    assert.ok(job.steps.findIndex(s => s.id === 'workload_session') < job.steps.indexOf(refresh));
    assert.equal(refresh.with['role-to-assume'], '${{ secrets.AWS_CI_DEPLOYER_DEV_ROLE_ARN }}');
    assert.equal(refresh.with['unset-current-credentials'], true);
    assert.equal(refresh.with['role-duration-seconds'], 3600);
    assert.ok(gate['timeout-minutes'] < 60);
    assert.equal(job.steps.indexOf(refresh) + 1, job.steps.indexOf(gate));
    if (file === 'deploy-web.yml') assert.equal(refresh.if,
      "${{ success() && github.ref == 'refs/heads/dev' && steps.workload_session.outputs.session_policy != '' }}");
  }
});
