import { test } from 'node:test';
import { SmokeError } from '../authenticated-smoke.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyAwsError, ReleaseError, validateContext, validateDeployment, validateCatalog, captureDeployment, release,
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
function catalog() {
  return { status: 'catalog', types: ['cloudfront', 'rds'] };
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
      RevisionId: '11111111-1111-4111-8111-111111111111',
      State: 'Active', LastUpdateStatus: 'Successful', Architectures: ['arm64'], Timeout: 420 },
  };
  const calls = [], authenticated = [];
  const run = async (command, args) => {
    assert.equal(command, 'aws');
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    if (key === 'lambda invoke') {
      const output = args.at(-1);
      assert.equal(args[args.indexOf('--invocation-type') + 1], 'RequestResponse');
      const { type } = JSON.parse(args[args.indexOf('--payload') + 1]);
      assert.ok(['catalog', ...(overrides.catalog?.types || catalog().types)].includes(type));
      writeFileSync(output, JSON.stringify(type === 'catalog' ? (overrides.catalog || catalog())
        : (overrides.probes?.[type] || (type === 'cloudfront' && overrides.probe) ||
          { type, status: 'succeeded', row_count: 1, unknown_attribute_count: 0 })), { mode: 0o600 });
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
    const gaps = { partial: [], failed: [], stale: [], missing: [], unknown: [], pending: [], invalid: [] };
    return overrides.authResult || { status: 'ok',
      mode: config.mode, workers: 2, inventory_policy: config.inventoryPolicy,
      inventory_quality: { status: 'complete', catalog_types: config.expectedQueuedTypes,
        counts: { expected: config.expectedQueuedTypes?.length, verified: config.expectedQueuedTypes?.length,
          ...Object.fromEntries(Object.keys(gaps).map(key => [key, 0])) },
        types: { ...gaps, verified: config.expectedQueuedTypes } } };
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
    { PIN_SHA: '' }, { RUNTIME_MODE: 'database-only' }, { INVENTORY_POLICY: 'core' },
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

test('the own CloudFront probe waits through busy/superseded without another full fan-out', async () => {
  const f = fixture();
  let clock = Date.now() - 30_000, probes = 0;
  try {
    await release(deployment(), { env: f.env, now: () => clock, wait: async ms => { clock += ms; },
      run: async (command, args, options) => {
        if (args[0] === 'lambda' && args[1] === 'invoke' && JSON.parse(args[args.indexOf('--payload') + 1]).type === 'cloudfront') {
          probes++;
          assert.equal(options.timeout, 450_000);
          assert.equal(args[args.indexOf('--invocation-type') + 1], 'RequestResponse');
          writeFileSync(args.at(-1), JSON.stringify({ type: 'cloudfront',
            status: probes === 1 ? 'busy' : probes === 2 ? 'failed' : 'succeeded',
            ...(probes === 2 ? { error: 'inventory sync superseded' } : probes > 2 ? { row_count: 1, unknown_attribute_count: 0 } : {}) }));
          return JSON.stringify({ StatusCode: 200, ExecutedVersion: '$LATEST' });
        }
        return f.run(command, args);
      }, authenticate: f.authenticate,
    });
    assert.equal(probes, 3);
    assert.deepEqual(f.authenticated[0].input.runtimeConfig.expectedQueuedTypes, ['cloudfront', 'rds']);
    assert.equal(f.authenticated[0].input.runtimeConfig.collectionMode, 'release');
  } finally { f.cleanup(); }
});

test('full collection synchronously drives every source catalog type with at most four workers', async () => {
  const { execFileSync } = await import('node:child_process');
  const source = new URL('../steampipe/sync_lambda.py', import.meta.url);
  const types = JSON.parse(execFileSync('python3', ['-c',
    'import ast,json,sys; t=ast.parse(open(sys.argv[1]).read()); print(json.dumps([k.value for n in t.body if isinstance(n,ast.Assign) and any(isinstance(a,ast.Name) and a.id in ("QUERIES","SDK_SYNCS") for a in n.targets) for k in n.value.keys]))',
    source.pathname], { encoding: 'utf8' }));
  assert.ok(types.length >= 43);
  const f = fixture({ catalog: { status: 'catalog', types } });
  const policy = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys; sys.path.insert(0,sys.argv[1]); from ci_verifier_sessions import workload_policy; e,d=json.load(sys.stdin); print(json.dumps(workload_policy(e,d)))',
    new URL('../', import.meta.url).pathname],
  { input: JSON.stringify([f.env, deployment()]), encoding: 'utf8' }));
  const invocation = policy.Statement.filter(s => s.Action.includes('lambda:InvokeFunction'));
  assert.equal(invocation.length, 1);
  assert.equal(invocation[0].Effect, 'Allow');
  assert.deepEqual(invocation[0].Condition, { StringEquals: { 'aws:RequestedRegion': region } });
  let active = 0, peak = 0, configReads = 0;
  const invoked = [];
  try {
    const result = await release(deployment(), { env: f.env,
      authenticate: (...args) => {
        assert.equal(configReads, 2, 'Recheck the collector before authentication and workers');
        return f.authenticate(...args);
      },
      run: async (cmd, args, options) => {
        if (args[0] === 'lambda' && args[1] === 'get-function-configuration' && ++configReads === 2) {
          assert.equal(active, 0, 'All owned collection RPCs must settle before the recheck');
          assert.deepEqual([...invoked].sort(), [...types].sort());
          assert.equal(options.timeout, 15_000);
          assert.equal(args[args.indexOf('--function-name') + 1], deployment().inventory.sync_function_arn);
          assert.ok(!args.includes('--qualifier'));
        }
        if (args[0] !== 'lambda' || args[1] !== 'invoke') return f.run(cmd, args, options);
        assert.equal(args[args.indexOf('--function-name') + 1], invocation[0].Resource);
        const payload = JSON.parse(args[args.indexOf('--payload') + 1]);
        assert.deepEqual(Object.keys(payload), ['type']);
        const { type } = payload;
        if (type === 'catalog') return f.run(cmd, args, options);
        invoked.push(type); active++; peak = Math.max(peak, active);
        try { await new Promise(resolve => setTimeout(resolve, 2)); return await f.run(cmd, args, options); }
        finally { active--; }
      } });
    assert.deepEqual([...invoked].sort(), [...types].sort());
    assert.ok(peak > 1 && peak <= 4);
    assert.equal(result.status, 'full_verified');
    assert.equal(result.collection_attempts.counts.succeeded, types.length);
    assert.deepEqual(f.authenticated[0].input.runtimeConfig.expectedQueuedTypes, types);
  } finally { f.cleanup(); }
});

test('partial type is reported, other types settle, and incomplete collection cannot reach smoke', async () => {
  const f = fixture({ probes: { rds: { type: 'rds', status: 'partial', row_count: 0,
    unknown_attribute_count: 0, unreachable_account_count: 1 } } });
  try {
    await assert.rejects(release(deployment(), { env: f.env, authenticate: f.authenticate,
      run: async (cmd, args, options) => {
        if (args[0] === 'lambda' && args[1] === 'invoke' &&
          JSON.parse(args[args.indexOf('--payload') + 1]).type === 'cloudfront') {
          await new Promise(resolve => setTimeout(resolve, 20));
          assert.ok(existsSync(f.directory), 'An admitted collector must settle before cleanup');
        }
        return f.run(cmd, args, options);
      } }), error => {
      assert.equal(error.message, 'collection_partial');
      assert.equal(error.collection_attempts.types.rds.status, 'partial');
      assert.equal(error.collection_attempts.types.rds.unreachable_account_count, 1);
      assert.equal(error.collection_attempts.types.cloudfront.status, 'succeeded');
      return true;
    });
    assert.equal(f.authenticated.length, 0);
    assert.ok(!existsSync(f.directory));
  } finally { f.cleanup(); }
});

test('reserved dispatcher names cannot enter the synchronous catalog', () => {
  for (const type of ['all', 'catalog'])
    assert.throws(() => validateCatalog({ status: 'catalog', types: ['cloudfront', type] }),
      /invalid_collection_catalog/);
});

test('owned probes must disclose known counts and zero unknown attributes before authentication', async () => {
  for (const change of [{ unknown_attribute_count: 1 }, { unknown_attribute_count: null },
    { unknown_attribute_count: undefined }, { row_count: null }]) {
    const f = fixture({ probe: { type: 'cloudfront', status: 'succeeded', row_count: 1,
      unknown_attribute_count: 0, ...change } });
    try {
      await assert.rejects(release(deployment(), { env: f.env, run: f.run, authenticate: f.authenticate }),
        /collection_probe_incomplete|inventory_incomplete/);
      assert.equal(f.authenticated.length, 0);
    } finally { f.cleanup(); }
  }
});

test('unknown attributes in a collector success cannot satisfy complete collection', async () => {
  const f = fixture({ probes: { rds: { type: 'rds', status: 'succeeded', row_count: 1,
    unknown_attribute_count: 1 } } });
  try {
    await assert.rejects(release(deployment(), { env: f.env, run: f.run, authenticate: f.authenticate }),
      error => error.message === 'inventory_incomplete' && error.collection_attempts.types.rds.status === 'unknown');
    assert.equal(f.authenticated.length, 0);
  } finally { f.cleanup(); }
});

test('a throttled type has a bounded deadline without starving another catalog type', async () => {
  const f = fixture(); let clock = Date.now();
  const began = clock;
  try {
    await assert.rejects(release(deployment(), { env: f.env, now: () => clock,
      wait: async ms => { clock += ms; }, authenticate: f.authenticate,
      run: async (cmd, args, options) => {
        if (args[0] === 'lambda' && args[1] === 'invoke' &&
          JSON.parse(args[args.indexOf('--payload') + 1]).type === 'cloudfront')
          throw new ReleaseError('aws_throttled');
        return f.run(cmd, args, options);
      } }), error => {
      assert.equal(error.message, 'collection_probe_throttled');
      assert.equal(error.collection_attempts.types.cloudfront.status, 'deadline');
      assert.equal(error.collection_attempts.types.rds.status, 'succeeded');
      return true;
    });
    assert.ok(clock - began <= 900_000);
    assert.equal(f.authenticated.length, 0);
  } finally { f.cleanup(); }
});
test('catalog admission retries only confirmed throttling', async () => {
  const f = fixture();
  let clock = Date.now() - 30_000, attempts = 0;
  const began = clock;
  try {
    await release(deployment(), { env: f.env, now: () => clock, wait: async ms => { clock += ms; },
      run: async (command, args) => {
        if (args[0] === 'lambda' && args[1] === 'invoke' && JSON.parse(args[args.indexOf('--payload') + 1]).type === 'catalog' && attempts++ < 2)
          throw new ReleaseError('aws_throttled');
        return f.run(command, args);
      }, authenticate: f.authenticate });
    assert.equal(attempts, 3);
    assert.equal(f.authenticated[0].input.runtimeConfig.collectionStartedAt, new Date(began + 20_000).toISOString());
  } finally { f.cleanup(); }
});

test('a long busy probe retries only when the next complete call preserves the proof reserve', async () => {
  for (const duration of [300_000, 420_000]) {
    const f = fixture();
    let clock = Date.now() - 900_000, probes = 0;
    const began = clock;
    try {
      const action = release(deployment(), { env: f.env, now: () => clock, wait: async ms => { clock += ms; },
        run: async (command, args, options) => {
          if (args[0] === 'lambda' && args[1] === 'invoke'
            && JSON.parse(args[args.indexOf('--payload') + 1]).type === 'cloudfront') {
            probes++;
            assert.equal(options.env.AWS_MAX_ATTEMPTS, '1');
            assert.equal(options.timeout, 450_000);
            clock += duration;
            writeFileSync(args.at(-1), JSON.stringify({ type: 'cloudfront',
              status: probes === 1 ? 'busy' : 'succeeded',
              ...(probes > 1 ? { row_count: 1, unknown_attribute_count: 0 } : {}) }));
            return JSON.stringify({ StatusCode: 200, ExecutedVersion: '$LATEST' });
          }
          return f.run(command, args);
        }, authenticate: f.authenticate });
      if (duration === 420_000) {
        await assert.rejects(action, /collection_probe_busy/);
        assert.equal(probes, 1);
        assert.equal(clock - began, 430_000);
        assert.equal(f.authenticated.length, 0);
      } else {
        await action;
        assert.equal(probes, 2);
        assert.equal(clock - began, 610_000);
        assert.equal(f.authenticated[0].input.runtimeConfig.collectionStartedAt, new Date(began).toISOString());
      }
    } finally { f.cleanup(); }
  }
});

test('uncertain CloudFront delivery is never retried or accepted as readiness', async () => {
  const f = fixture();
  let probes = 0;
  try {
    await assert.rejects(release(deployment(), { env: f.env, authenticate: f.authenticate,
      run: async (command, args) => {
        if (args[0] === 'lambda' && args[1] === 'invoke'
          && JSON.parse(args[args.indexOf('--payload') + 1]).type === 'cloudfront') {
          probes++;
          throw new ReleaseError('aws_request_failed');
        }
        return f.run(command, args);
      } }), /collection_probe_failed/);
    assert.equal(probes, 1);
    assert.equal(f.authenticated.length, 0);
  } finally { f.cleanup(); }
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

test('catalog rejects a partial, duplicate, empty or incomplete canonical set', () => {
  assert.deepEqual(validateCatalog(catalog()), ['cloudfront', 'rds']);
  for (const value of [{ status: 'partial', types: ['cloudfront'] }, { status: 'catalog', types: [] },
    { status: 'catalog', types: ['rds'] }, { status: 'catalog', types: ['cloudfront', 'cloudfront'] },
    { ...catalog(), arbitrary: 'PRIVATE' }]) assert.throws(() => validateCatalog(value));
});
test('collect binds running web, code hash, canonical coverage and the fresh own-workload probe', async () => {
  const f = fixture();
  const now = Date.now();
  try {
    const result = await release(deployment(), {
      env: f.env, run: f.run, authenticate: f.authenticate, now: () => now,
    });
    assert.equal(result.status, 'full_verified');
    assert.equal(result.inventory_policy, 'full');
    assert.equal(result.inventory_quality.counts.verified, 2);
    assert.equal(result.web_tasks, 1);
    assert.equal(result.workers, 2);
    assert.equal(f.authenticated.length, 1);
    assert.deepEqual(f.authenticated[0].input.runtimeConfig, {
      schemaVersion: 1, mode: 'verify', hostOnly: true, expectedAccountId: account,
      expectedCloudfrontId: 'E123EXAMPLE', expectedQueuedTypes: ['cloudfront', 'rds'],
      collectionStartedAt: new Date(now).toISOString(), collectionMode: 'release',
      inventoryPolicy: 'full',
    });
    const invoke = f.calls.find(a => a[0] === 'lambda' && a[1] === 'invoke');
    assert.equal(invoke[invoke.indexOf('--function-name') + 1], deployment().inventory.sync_function_arn);
    assert.equal(invoke[invoke.indexOf('--invocation-type') + 1], 'RequestResponse');
    assert.equal(invoke[invoke.indexOf('--payload') + 1], '{"type":"catalog"}');
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
    ...[undefined, null, '', '   ', 123, {}].map(RevisionId => ({
      'lambda get-function-configuration': { ...r['lambda get-function-configuration'], RevisionId },
    })),
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

for (const [label, change, readError] of [
  ['changed hash', { CodeSha256: Buffer.alloc(32, 4).toString('base64') }],
  ['same hash with a new revision', { RevisionId: '22222222-2222-4222-8222-222222222222' }],
  ['missing revision', { RevisionId: undefined }],
  ['update in progress', { LastUpdateStatus: 'InProgress' }],
  ...['aws_timeout', 'aws_access_denied', 'aws_throttled'].map(code => [code, {}, code]),
]) test(`collector recheck rejects ${label} before authentication and workers`, async () => {
  const f = fixture();
  let configReads = 0;
  try {
    await assert.rejects(release(deployment(), { env: f.env, authenticate: f.authenticate,
      run: async (cmd, args, options) => {
        if (args[0] === 'lambda' && args[1] === 'get-function-configuration'
          && ++configReads === 2 && readError) throw new ReleaseError(readError);
        if (args[0] === 'lambda' && args[1] === 'invoke'
          && JSON.parse(args[args.indexOf('--payload') + 1]).type === 'cloudfront')
          Object.assign(f.responses['lambda get-function-configuration'], change);
        return f.run(cmd, args, options);
      },
    }), error => {
      assert.equal(error.message, readError || 'inventory_code_mismatch');
      assert.equal(error.collection_attempts.counts.succeeded, 2);
      return true;
    });
    assert.equal(configReads, 2);
    assert.equal(f.authenticated.length, 0);
    assert.equal(existsSync(f.directory), false);
  } finally { f.cleanup(); }
});

test('bad invocation acknowledgement never starts smoke, and database-only return cannot pass collect', async () => {
  for (const change of [
    { invoke: { StatusCode: 200, FunctionError: 'Unhandled' } },
    { catalog: { ...catalog(), status: 'partial' } },
    { probe: { type: 'cloudfront', status: 'partial' } },
    { probe: { type: 'other', status: 'succeeded' } },
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

test('disabled runtime features fail capture before any deployment contract or AWS call', () => {
  const f = fixture();
  try {
    const value = deployment();
    value.features.inventory = false;
    assert.throws(() => captureDeployment(value, f.env), /runtime_not_enabled/);
    assert.equal(existsSync(join(f.directory, 'runtime-deployment.json')), false);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('cleanup cannot replace a primary fixed context failure', async () => {
  await assert.rejects(release(deployment(), {
    env: { ...env, GITHUB_REPOSITORY: 'wrong/repo', SMOKE_CREDENTIAL_FILE: '/invalid/credentials.json' },
    run: async () => { throw new Error('AWS must not run'); },
  }), error => error.message === 'invalid_dev_source');
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
    f.env.EXPECTED_WEB_DIGEST = indexDigest;
    f.responses['ecs describe-tasks'].tasks[0].containers[0].imageDigest = child;
    try {
      const action = release(deployment(), { env: f.env, run: f.run, authenticate: f.authenticate });
      if (architecture === 'arm64') assert.equal((await action).status, 'full_verified');
      else {
        await assert.rejects(action);
        assert.ok(!f.calls.some(a => a[0] === 'lambda' && a[1] === 'invoke'));
      }
    } finally { f.cleanup(); }
  }
});

test('post-pin release requires a digest and ignores a moved source tag', async () => {
  for (const selected of [undefined, 'invalid', digest]) {
    const f = fixture();
    f.env.GITHUB_WORKFLOW_REF = 'aws-samples/sample-awsops/.github/workflows/deploy-web.yml@refs/heads/dev';
    if (selected !== undefined) f.env.EXPECTED_WEB_DIGEST = selected;
    f.responses['ecr batch-get-image'].images[0].imageId.imageTag = 'source-tag-moved';
    try {
      const operation = release(deployment(), { env: f.env, run: f.run, authenticate: f.authenticate });
      if (selected === digest) {
        assert.equal((await operation).status, 'full_verified');
        const call = f.calls.find(a => a[0] === 'ecr');
        assert.ok(call.includes(`imageDigest=${digest}`));
        assert.ok(!call.some(a => a.startsWith('imageTag=')));
      } else {
        await assert.rejects(operation, /expected_web_digest/);
        assert.equal(f.calls.length, 0);
      }
    } finally { f.cleanup(); }
  }
});

test('approved root digest still rejects a different running image', async () => {
  const f = fixture();
  f.env.EXPECTED_WEB_DIGEST = digest;
  f.responses['ecs describe-tasks'].tasks[0].containers[0].imageDigest = `sha256:${'e'.repeat(64)}`;
  try {
    await assert.rejects(release(deployment(), { env: f.env, run: f.run, authenticate: f.authenticate }),
      /running_web_mismatch/);
    assert.equal(f.authenticated.length, 0);
  } finally { f.cleanup(); }
});

test('full controller rejects successful-looking incomplete inventory proof', async () => {
  for (const status of ['gaps', 'complete']) {
    const quality = { status, catalog_types: ['cloudfront', 'rds'],
      counts: { expected: 2, verified: 1, missing: 1 }, types: { verified: ['cloudfront'], missing: ['rds'] } };
    const f = fixture({ authResult: { status: 'ok', mode: 'verify',
      inventory_policy: 'full', inventory_quality: quality, workers: 2 } });
    f.env.INVENTORY_POLICY = 'full';
    try {
      await assert.rejects(release(deployment(), { env: f.env, run: f.run, authenticate: f.authenticate }),
        /complete_runtime_proof_required/);
    } finally { f.cleanup(); }
  }
});

test('complete proof must contain every verified type and zero consistent gap counters', async () => {
  for (const mutate of [
    quality => { quality.counts.unknown = 1; },
    quality => { quality.types.pending.push('rds'); },
    quality => { quality.types.verified = ['cloudfront', 'cloudfront']; },
    quality => { quality.counts.pending = '0'; },
  ]) {
    const f = fixture();
    try {
      await assert.rejects(release(deployment(), { env: f.env, run: f.run,
        authenticate: async (...args) => {
          const result = await f.authenticate(...args);
          mutate(result.inventory_quality);
          return result;
        },
      }), /complete_runtime_proof_required/);
      assert.equal(existsSync(f.directory), false);
    } finally { f.cleanup(); }
  }
});

test('controller total budget emits a typed failure before the outer step timeout', async () => {
  const f = fixture();
  let clock = Date.now();
  try {
    await assert.rejects(release(deployment(), { env: f.env, now: () => clock, authenticate: f.authenticate,
      run: async (cmd, args, options) => {
        assert.ok(options.timeout <= 150_000);
        clock += 600_000;
        return f.run(cmd, args);
      } }), error => error.message === 'release_timeout');
    assert.equal(f.authenticated.length, 0);
  } finally { f.cleanup(); }
});

test('runtime proof receives the earlier controller or marker deadline without resetting it', async () => {
  for (const setupMinutes of [0, 25, 26]) {
    const f = fixture();
    const start = Date.now() - setupMinutes * 60_000 - 1000;
    let clock = start;
    try {
      const action = release(deployment(), { env: f.env, now: () => clock, authenticate: f.authenticate,
        run: async (cmd, args) => {
          if (args[0] === 'sts') clock += setupMinutes * 60_000;
          return f.run(cmd, args);
        } });
      if (setupMinutes === 26) {
        await assert.rejects(action, error => {
          assert.equal(error.collection_attempts.counts.not_started, 2);
          assert.equal(error.collection_attempts.counts.deadline, 2);
          return true;
        });
        assert.equal(f.authenticated.length, 0);
        continue;
      }
      await action;
      const { input, options } = f.authenticated[0];
      const marker = Date.parse(input.runtimeConfig.collectionStartedAt);
      assert.equal(options.deadline, Math.min(start + 50 * 60_000, marker + 30 * 60_000));
    } finally { f.cleanup(); }
  }
});

test('late batches cannot spend the authentication and runtime proof reserve', async () => {
  for (const setupMinutes of [0, 25]) {
    const types = ['cloudfront', 'rds', 'ec2', 's3', 'iam_user'];
    const f = fixture({ catalog: { status: 'catalog', types } });
    let clock = Date.now() - (setupMinutes + 10) * 60_000;
    const invoked = [];
    let finishBatch;
    const batch = new Promise(resolve => { finishBatch = resolve; });
    try {
      await assert.rejects(release(deployment(), { env: f.env, now: () => clock,
        authenticate: f.authenticate,
        run: async (cmd, args) => {
          if (args[0] === 'sts') clock += setupMinutes * 60_000;
          if (args[0] === 'lambda' && args[1] === 'invoke') {
            const { type } = JSON.parse(args[args.indexOf('--payload') + 1]);
            if (type !== 'catalog') {
              invoked.push(type);
              if (invoked.length === 4) {
                clock += setupMinutes ? 31_000 : 331_000;
                finishBatch();
              }
              await batch;
            }
          }
          return f.run(cmd, args);
        },
      }), error => {
        assert.equal(error.collection_attempts.counts.succeeded, 4);
        assert.equal(error.collection_attempts.types.iam_user.status, 'deadline');
        assert.equal(error.collection_attempts.types.iam_user.attempts, 0);
        return true;
      });
      assert.deepEqual(invoked, types.slice(0, 4));
      assert.equal(f.authenticated.length, 0);
      assert.equal(existsSync(f.directory), false);
    } finally { f.cleanup(); }
  }
});

test('a successful adapter cannot certify release at or beyond the marker deadline', async () => {
  for (const lateBy of [0, 1]) {
    const f = fixture();
    let clock = Date.now() - 1000;
    try {
      await assert.rejects(release(deployment(), { env: f.env, run: f.run, now: () => clock,
        authenticate: async (input, options) => {
          const result = await f.authenticate(input, options);
          clock = Date.parse(input.runtimeConfig.collectionStartedAt) + 30 * 60_000 + lateBy;
          return result;
        } }), error => error instanceof ReleaseError && error.message === 'release_timeout');
      assert.equal(existsSync(f.directory), false);
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

test('release freshness starts before the owned probe and is not reset by its response', async () => {
  const f = fixture();
  const start = Date.now() - 2000;
  let time = start;
  const run = async (cmd, args) => {
    if (args[0] === 'lambda' && args[1] === 'invoke') time += 1000;
    return f.run(cmd, args);
  };
  try {
    await release(deployment(), { env: f.env, run, authenticate: f.authenticate, now: () => time });
    assert.equal(f.authenticated[0].input.runtimeConfig.collectionStartedAt, new Date(start + 1000).toISOString());
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

test('AWS CLI diagnostics classify only known codes without relaying private details', () => {
  for (const [stderr, expected] of [
    ['An error occurred (TooManyRequestsException) when calling the Invoke operation: PRIVATE', 'aws_throttled'],
    ['An error occurred (AccessDeniedException) when calling the Invoke operation: PRIVATE', 'aws_access_denied'],
    ['An error occurred (AccessDenied) when calling the Invoke operation: PRIVATE', 'aws_access_denied'],
    ['PRIVATE TooManyRequestsException in unrelated diagnostic', 'aws_request_failed'],
    ['An error occurred (ResourceNotFoundException) when calling the Invoke operation: PRIVATE', 'aws_request_failed'],
  ]) assert.equal(classifyAwsError({ stderr }).message, expected);
  assert.equal(classifyAwsError(undefined).message, 'aws_request_failed');
  assert.equal(classifyAwsError({ killed: true, stderr: 'PRIVATE' }).message, 'aws_timeout');
  for (const kind of ['Read', 'Connect'])
    assert.equal(classifyAwsError({ stderr: `${kind} timeout on endpoint URL: "PRIVATE"` }).message, 'aws_timeout');
});

test('dispatcher denial does not repeat and confirmed throttling has a hard admission deadline', async () => {
  for (const code of ['aws_access_denied', 'aws_throttled']) {
    const f = fixture();
    let clock = Date.now(), calls = 0;
    const started = clock;
    try {
      await assert.rejects(release(deployment(), { env: f.env, now: () => clock,
        wait: async ms => { clock += ms; }, authenticate: f.authenticate,
        run: async (command, args) => {
          if (args[0] === 'lambda' && args[1] === 'invoke') { calls++; throw new ReleaseError(code); }
          return f.run(command, args);
        },
      }), new RegExp(code === 'aws_throttled' ? 'collection_probe_throttled' : 'collection_probe_denied'));
      assert.ok(clock - started <= 450_000);
      assert.equal(f.authenticated.length, 0);
      assert.ok(code === 'aws_throttled' ? calls > 1 && calls <= 45 : calls === 1);
    } finally { f.cleanup(); }
  }
});
