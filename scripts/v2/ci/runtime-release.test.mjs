import { test } from 'node:test';
import { SmokeError } from '../authenticated-smoke.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateContext, validateDeployment, validateAcknowledgement, captureDeployment, release,
} from './runtime-release.mjs';

const account = '123456789012', project = 'awsops-fixture', region = 'ap-northeast-2';
const sha = 'a'.repeat(40);
const prefix = `arn:aws:ecs:${region}:${account}:`;
const taskDefinition = `${prefix}task-definition/${project}-web:7`;
const taskArn = `${prefix}task/${project}/${'b'.repeat(32)}`;
const clusterArn = `${prefix}cluster/${project}`;
const role = `arn:aws:iam::${account}:role/platform/DeploymentRole`;
const image = `${account}.dkr.ecr.${region}.amazonaws.com/${project}-web`;
const body = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { digest: `sha256:${'c'.repeat(64)}` }, layers: [] });
const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
const env = {
  TARGET: 'dev', AWS_REGION: region, AWS_ACCOUNT_ID_DEV: account, CI_ROLE_ARN: role,
  GITHUB_REPOSITORY: 'aws-samples/sample-awsops', GITHUB_REF: 'refs/heads/dev',
  GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'aws-samples/sample-awsops/.github/workflows/collect-runtime.yml@refs/heads/dev',
  RUNTIME_MODE: 'collect', PIN_SHA: sha,
  PUBLIC_URL: 'https://dev.example.com', CLOUDFRONT_DOMAIN: 'd123.cloudfront.net',
};
function deployment() {
  return {
    schema_version: 1, account_id: account, region, project,
    features: { inventory: true, agentcore: true, workers: true },
    web: { cluster: project, service: `${project}-web`, task_role_arn: `arn:aws:iam::${account}:role/${project}-task` },
    inventory: { sync_function_name: `${project}-inv-sync`,
      sync_function_arn: `arn:aws:lambda:${region}:${account}:function:${project}-inv-sync`,
      sync_code_sha256: Buffer.alloc(32, 3).toString('base64') },
    known: { cloudfront_distribution_id: 'E123EXAMPLE' },
  };
}
function ack() {
  return { status: 'dispatched', queued_count: 2, failed_count: 0,
    queued_types: ['cloudfront', 'rds'], failed_types: [] };
}
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-tests-'));
  const previousTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = root;
  const directory = mkdtempSync(join(root, 'awsops-smoke-credentials-'));
  chmodSync(directory, 0o700);
  const credentials = join(directory, 'credentials.json');
  writeFileSync(credentials, '{"email":"demo@example.com","password":"FIXTURE_PASSWORD"}', { mode: 0o600 });
  const localEnv = { ...env, RUNNER_TEMP: root, SMOKE_CREDENTIAL_FILE: credentials };
  const responses = {
    'sts get-caller-identity': { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/DeploymentRole/FixtureSession` },
    'ecr batch-get-image': { images: [{ registryId: account, repositoryName: `${project}-web`,
      imageId: { imageTag: `web-${sha}`, imageDigest: digest }, imageManifest: body }], failures: [] },
    'ecs describe-services': { services: [{ serviceName: `${project}-web`,
      serviceArn: `${prefix}service/${project}/${project}-web`, clusterArn, status: 'ACTIVE',
      taskDefinition, desiredCount: 1, runningCount: 1, pendingCount: 0,
      deployments: [{ status: 'PRIMARY', taskDefinition, rolloutState: 'COMPLETED' }] }], failures: [] },
    'ecs describe-task-definition': { taskDefinition: {
      taskDefinitionArn: taskDefinition, taskRoleArn: deployment().web.task_role_arn,
      runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      containerDefinitions: [{ name: 'web', essential: true, image: `${image}:web-latest` }],
    } },
    'ecs list-tasks': { taskArns: [taskArn] },
    'ecs describe-tasks': { tasks: [{ taskArn, clusterArn, group: `service:${project}-web`,
      taskDefinitionArn: taskDefinition, lastStatus: 'RUNNING', desiredStatus: 'RUNNING',
      healthStatus: 'HEALTHY', platformFamily: 'Linux',
      containers: [{ name: 'web', lastStatus: 'RUNNING', imageDigest: digest, healthStatus: 'HEALTHY' }],
    }], failures: [] },
    'lambda get-function-configuration': { FunctionName: `${project}-inv-sync`,
      FunctionArn: deployment().inventory.sync_function_arn, CodeSha256: deployment().inventory.sync_code_sha256,
      State: 'Active', LastUpdateStatus: 'Successful', Architectures: ['arm64'] },
  };
  const calls = [], authenticated = [];
  const run = async (command, args) => {
    assert.equal(command, 'aws');
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    if (key === 'lambda invoke') {
      const output = args.at(-1);
      writeFileSync(output, JSON.stringify(overrides.ack || ack()), { mode: 0o600 });
      return JSON.stringify(overrides.invoke || { StatusCode: 200, ExecutedVersion: '$LATEST' });
    }
    if (overrides.throwAt === key) throw new Error('PRIVATE_REMOTE_DETAIL');
    return JSON.stringify(Object.hasOwn(overrides, key) ? overrides[key] : responses[key]);
  };
  const authenticate = async (input, options) => {
    authenticated.push({ input, options });
    assert.equal(input.password, 'FIXTURE_PASSWORD');
    assert.equal(options.tempRoot, directory);
    const config = JSON.parse(readFileSync(join(directory, 'runtime-smoke.json'), 'utf8'));
    assert.deepEqual(config, input.runtimeConfig);
    assert.equal(config.hostOnly, true);
    return overrides.authResult || { status: 'ok', mode: input.runtimeConfig.mode,
      collected_types: input.runtimeConfig.expectedQueuedTypes?.length, workers: 2 };
  };
  return { root, directory, credentials, env: localEnv, responses, calls, authenticated, run, authenticate,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      if (previousTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previousTemp;
    } };
}

test('wrong source, role/account or mode fails before AWS calls', async () => {
  for (const change of [
    { TARGET: 'main' }, { AWS_ACCOUNT_ID_DEV: '' }, { AWS_ACCOUNT_ID_DEV: '999999999999' },
    { CI_ROLE_ARN: '' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_WORKFLOW_REF: 'wrong' },
    { PIN_SHA: '' }, { RUNTIME_MODE: 'database-only' },
    { PUBLIC_URL: 'http://dev.example.com' }, { CLOUDFRONT_DOMAIN: 'attacker.example.com' },
  ]) {
    const f = fixture();
    try {
      await assert.rejects(release(deployment(), { env: { ...f.env, ...change }, run: f.run, authenticate: f.authenticate }));
      assert.equal(f.calls.length, 0);
    } finally { f.cleanup(); }
  }
  assert.doesNotThrow(() => validateContext(env));
});

test('Terraform schema is snake_case and collect cannot accept disabled/partial configuration', () => {
  assert.equal(validateDeployment(deployment(), validateContext(env)).project, project);
  for (const change of [
    { schema_version: undefined, schemaVersion: 1 }, { account_id: '999999999999' },
    { region: 'us-east-1' }, { features: { inventory: false, agentcore: true, workers: true } },
    { web: { ...deployment().web, task_role_arn: role } },
    { inventory: { ...deployment().inventory, sync_function_name: 'other-function' } },
    { inventory: { ...deployment().inventory, sync_code_sha256: 'invalid' } },
  ]) assert.throws(() => validateDeployment({ ...deployment(), ...change }, validateContext(env)));
});

test('all-type acknowledgement rejects partial, duplicate, missing-cloudfront and inconsistent counts', () => {
  assert.deepEqual(validateAcknowledgement(ack()), ['cloudfront', 'rds']);
  for (const change of [
    { status: 'partial' }, { failed_count: 1 }, { failed_types: ['rds'] }, { queued_count: 3 },
    { queued_types: ['rds', 'rds'] }, { queued_types: ['cloudfront', 'cloudfront'] },
    { queued_count: 0, queued_types: [] }, { message: 'PRIVATE' },
  ]) assert.throws(() => validateAcknowledgement({ ...ack(), ...change }));
});

test('collect binds actual running web, code hash, pre-invoke time and full private verification config', async () => {
  const f = fixture();
  const now = Date.now();
  try {
    const result = await release(deployment(), {
      env: f.env, run: f.run, authenticate: f.authenticate, now: () => now,
    });
    assert.deepEqual(result, { status: 'ready', mode: 'verify', collected_types: 2, web_tasks: 1 });
    assert.equal(f.authenticated.length, 1);
    assert.deepEqual(f.authenticated[0].input.runtimeConfig, {
      schemaVersion: 1, mode: 'verify', hostOnly: true, expectedAccountId: account,
      expectedCloudfrontId: 'E123EXAMPLE', expectedQueuedTypes: ['cloudfront', 'rds'],
      collectionStartedAt: new Date(now).toISOString(),
    });
    const invoke = f.calls.find(a => a[0] === 'lambda' && a[1] === 'invoke');
    assert.equal(invoke[invoke.indexOf('--function-name') + 1], deployment().inventory.sync_function_arn);
    assert.equal(invoke[invoke.indexOf('--invocation-type') + 1], 'RequestResponse');
    assert.equal(invoke[invoke.indexOf('--payload') + 1], '{"type":"all"}');
    assert.ok(!invoke.includes('--log-type'));
    assert.ok(!existsSync(f.directory));
  } finally { f.cleanup(); }
});

test('identity, wrong task role/revision/image/architecture and Lambda code failures block invocation', async () => {
  const template = fixture();
  const r = template.responses;
  template.cleanup();
  const changes = [
    { 'sts get-caller-identity': { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/OtherRole/session` } },
    { 'ecs describe-task-definition': { taskDefinition: { ...r['ecs describe-task-definition'].taskDefinition, taskRoleArn: role } } },
    { 'ecs describe-task-definition': { taskDefinition: { ...r['ecs describe-task-definition'].taskDefinition, runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' } } } },
    { 'ecs describe-tasks': { tasks: [{ ...r['ecs describe-tasks'].tasks[0], taskDefinitionArn: taskDefinition.replace(':7', ':6') }], failures: [] } },
    { 'ecs describe-tasks': { tasks: [{ ...r['ecs describe-tasks'].tasks[0], containers: [{ name: 'web', lastStatus: 'RUNNING', imageDigest: `sha256:${'f'.repeat(64)}` }] }], failures: [] } },
    { 'ecs list-tasks': { taskArns: [taskArn], nextToken: 'more' } },
    { 'lambda get-function-configuration': { ...r['lambda get-function-configuration'], CodeSha256: Buffer.alloc(32, 4).toString('base64') } },
    { throwAt: 'lambda get-function-configuration' },
  ];
  for (const change of changes) {
    const f = fixture(change);
    try {
      await assert.rejects(release(deployment(), { env: f.env, run: f.run, authenticate: f.authenticate }),
        e => !e.message.includes('PRIVATE'));
      assert.ok(!f.calls.some(a => a[0] === 'lambda' && a[1] === 'invoke'));
      assert.equal(f.authenticated.length, 0);
      assert.ok(!existsSync(f.directory));
    } finally { f.cleanup(); }
  }
});

test('bad invocation acknowledgement never starts smoke, and database-only return cannot pass collect', async () => {
  for (const change of [
    { invoke: { StatusCode: 200, FunctionError: 'Unhandled' } },
    { ack: { ...ack(), failed_count: 1 } },
    { authResult: { status: 'ok', mode: 'database' } },
    { authResult: { status: 'ok', mode: 'verify' } },
  ]) {
    const f = fixture(change);
    try {
      await assert.rejects(release(deployment(), { env: f.env, run: f.run, authenticate: f.authenticate }));
      assert.ok(!existsSync(f.directory));
    } finally { f.cleanup(); }
  }
});

test('prepare uses ordinary authenticated account preparation before backend boot, without Lambda access', async () => {
  const f = fixture();
  try {
    f.env.RUNTIME_MODE = 'prepare'; f.env.PIN_SHA = '';
    const value = deployment();
    value.features = { inventory: false, agentcore: false, workers: false };
    value.inventory = { sync_function_name: null, sync_function_arn: null, sync_code_sha256: null };
    const run = (cmd, args) => {
      if (args.slice(0, 2).join(' ') === 'ecr batch-get-image') {
        const response = structuredClone(f.responses['ecr batch-get-image']);
        response.images[0].imageId.imageTag = 'web-latest';
        return Promise.resolve(JSON.stringify(response));
      }
      return f.run(cmd, args);
    };
    assert.equal((await release(value, { env: f.env, run, authenticate: f.authenticate })).mode, 'prepare');
    assert.equal(f.authenticated[0].input.runtimeConfig.mode, 'prepare');
    assert.ok(!f.calls.some(a => a[0] === 'lambda'));
  } finally { f.cleanup(); }
});

test('capture persists only validated deployment metadata in the credential directory', () => {
  const f = fixture();
  try {
    const file = captureDeployment(deployment(), f.env);
    assert.equal(file, join(f.directory, 'runtime-deployment.json'));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), deployment());
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => captureDeployment(deployment(), f.env)); // no overwrite/symlink following
  } finally { f.cleanup(); }
});

test('existing OCI indexes bind the running ARM64 child and reject indexes without ARM64', async () => {
  for (const architecture of ['arm64', 'amd64']) {
    const child = `sha256:${'d'.repeat(64)}`;
    const index = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [{ digest: child, platform: { architecture, os: 'linux' } }] });
    const indexDigest = `sha256:${createHash('sha256').update(index).digest('hex')}`;
    const f = fixture();
    f.responses['ecr batch-get-image'].images[0].imageManifest = index;
    f.responses['ecr batch-get-image'].images[0].imageId.imageDigest = indexDigest;
    f.responses['ecs describe-tasks'].tasks[0].containers[0].imageDigest = child;
    try {
      const action = release(deployment(), { env: f.env, run: f.run, authenticate: f.authenticate });
      if (architecture === 'arm64') assert.equal((await action).status, 'ready');
      else {
        await assert.rejects(action);
        assert.ok(!f.calls.some(a => a[0] === 'lambda' && a[1] === 'invoke'));
      }
    } finally { f.cleanup(); }
  }
});

test('capture refuses unsafe credential modes and existing symlink targets', () => {
  for (const unsafe of ['mode', 'symlink']) {
    const f = fixture();
    try {
      if (unsafe === 'mode') chmodSync(f.credentials, 0o644);
      else symlinkSync(f.credentials, join(f.directory, 'runtime-deployment.json'));
      assert.throws(() => captureDeployment(deployment(), f.env));
      assert.match(readFileSync(f.credentials, 'utf8'), /FIXTURE_PASSWORD/);
    } finally { f.cleanup(); }
  }
});

test('the collection timestamp precedes invocation, even if the response arrives later', async () => {
  const f = fixture();
  const start = Date.now() - 2000;
  let time = start;
  const run = async (cmd, args) => {
    if (args[0] === 'lambda' && args[1] === 'invoke') time += 1000;
    return f.run(cmd, args);
  };
  try {
    await release(deployment(), { env: f.env, run, authenticate: f.authenticate, now: () => time });
    assert.equal(f.authenticated[0].input.runtimeConfig.collectionStartedAt, new Date(start).toISOString());
  } finally { f.cleanup(); }
});

test('retains trusted smoke diagnostics while suppressing arbitrary thrown text', async () => {
  for (const [error, expected] of [
    [new SmokeError('Runtime smoke: runtime_parameters_not_ready(runtime_arn=denied)'),
      'Runtime smoke: runtime_parameters_not_ready(runtime_arn=denied)'],
    [new Error('PRIVATE_REMOTE_DETAIL'), 'authenticated_runtime_proof_failed'],
  ]) {
    const f = fixture();
    try {
      await assert.rejects(release(deployment(), { env: f.env, run: f.run,
        authenticate: async () => { throw error; } }), e => e.message === expected);
    } finally { f.cleanup(); }
  }
});
