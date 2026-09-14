import { test } from 'node:test';
import { SmokeError, authenticatedSmoke } from '../authenticated-smoke.mjs';
import { verifyRuntimeSmoke } from '../runtime-smoke.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyAwsError, ReleaseError, validateContext, validateDeployment, validateCatalog, captureDeployment, release,
  MIN_CATALOG_TYPES,
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
  return { status: 'catalog', types: ['cloudfront', 'rds', ...sourceTypes.filter(t => !['cloudfront', 'rds'].includes(t))] };
}
const sourceTypes = JSON.parse(execFileSync('python3', ['-c',
  'import ast,json,sys; t=ast.parse(open(sys.argv[1]).read()); print(json.dumps([k.value for n in t.body if isinstance(n,ast.Assign) and any(isinstance(a,ast.Name) and a.id in ("QUERIES","SDK_SYNCS") for a in n.targets) for k in n.value.keys]))',
  new URL('../steampipe/sync_lambda.py', import.meta.url).pathname], { encoding: 'utf8' }));
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
  const calls = [], authenticated = [], prepared = [];
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
    assert.equal(input.password, 'FIXTURE_PASSWORD');
    assert.equal(options.tempRoot, directory);
    if (options.includeDatabaseClock) {
      prepared.push({ input, options });
      assert.deepEqual(input.runtimeConfig, {
        schemaVersion: 1, mode: 'prepare', hostOnly: true, expectedAccountId: account,
      });
      const timestamp = options.now();
      return { status: 'ok', mode: 'prepare', public_tables: 1, database_clock: {
        server_time: new Date(timestamp).toISOString(),
        request_started_at_ms: timestamp, response_observed_at_ms: timestamp,
      } };
    }
    authenticated.push({ input, options });
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
  return { root, directory, credentials, env: localEnv, responses, calls, authenticated, prepared, run, authenticate,
    release: (options = {}) => release(deployment(), { env: localEnv, run, authenticate, ...options }),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      if (previousTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previousTemp;
    } };
}

async function withFixture(action, overrides = {}) {
  const f = fixture(overrides);
  try { return await action(f); } finally { f.cleanup(); }
}

function runCli(f, mode, extraEnv = {}, input, extraArgs = []) {
  const guard = mkdtempSync(join(f.root, 'cli-guard-')), called = join(guard, 'aws-called');
  writeFileSync(join(guard, 'aws'), `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(called)}, 'called');
process.exit(99);
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [new URL('./runtime-release.mjs', import.meta.url).pathname,
    mode, ...extraArgs], { env: { ...f.env, PATH: guard, ...extraEnv }, input, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(existsSync(called), false, 'The CLI must reject preflight failures before any AWS operation');
  assert.ok(!(result.stdout + result.stderr).includes('FIXTURE_PASSWORD'));
  return result;
}

test('CLI run cleans owned credentials on early context and deployment-file failures without deleting siblings', async () => {
  for (const kind of ['context', 'arguments', 'missing', 'malformed', 'symlink', 'outside', 'credential_symlink',
    'directory_symlink']) await withFixture(async f => {
    const neighbor = mkdtempSync(join(f.root, 'neighbor-')), sentinel = join(neighbor, 'credentials.json');
    const privateData = '{"private":"FIXTURE_PASSWORD"}';
    writeFileSync(sentinel, privateData, { mode: 0o600 });
    const file = join(f.directory, 'runtime-deployment.json');
    const extraEnv = { RUNTIME_DEPLOYMENT_FILE: file };
    let expected = 'failed';
    if (kind === 'context') { extraEnv.GITHUB_REPOSITORY = 'wrong/repo'; expected = 'invalid_dev_source'; }
    else if (kind === 'arguments') expected = 'invalid_command';
    else if (kind === 'malformed') { writeFileSync(file, '{FIXTURE_PASSWORD', { mode: 0o600 }); expected = 'invalid_response'; }
    else if (kind === 'symlink') symlinkSync(sentinel, file);
    else if (kind === 'outside') { extraEnv.RUNTIME_DEPLOYMENT_FILE = sentinel; expected = 'invalid_private_path'; }
    else if (kind === 'credential_symlink') { rmSync(f.credentials); symlinkSync(sentinel, f.credentials); }
    else if (kind === 'directory_symlink') {
      rmSync(f.directory, { recursive: true }); symlinkSync(neighbor, f.directory);
    }
    const result = runCli(f, 'run', extraEnv, undefined, kind === 'arguments' ? ['extra'] : []);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), `Runtime release: ${expected}`);
    assert.equal(existsSync(f.directory), false);
    assert.equal(readFileSync(sentinel, 'utf8'), privateData, 'Cleanup must not follow links or delete a sibling');
  });
});

test('CLI run preserves the primary diagnostic when cleanup refuses an unowned credential path', async () => withFixture(async f => {
  const sibling = mkdtempSync(join(f.root, 'sibling-')), file = join(sibling, 'credentials.json');
  writeFileSync(file, 'FIXTURE_PASSWORD', { mode: 0o600 });
  const result = runCli(f, 'run', { GITHUB_REPOSITORY: 'wrong/repo', SMOKE_CREDENTIAL_FILE: file });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'Runtime release: invalid_dev_source');
  assert.equal(readFileSync(file, 'utf8'), 'FIXTURE_PASSWORD');
  assert.equal(existsSync(f.credentials), true);
}));

test('CLI capture keeps private credentials and captured state for the later run phase', async () => {
  for (const valid of [true, false]) await withFixture(async f => {
    const output = join(f.root, 'github-output');
    const result = runCli(f, 'capture', { GITHUB_OUTPUT: output },
      valid ? JSON.stringify(deployment()) : '{FIXTURE_PASSWORD');
    assert.equal(result.status, valid ? 0 : 1);
    assert.equal(existsSync(f.credentials), true);
    assert.equal(statSync(f.credentials).mode & 0o777, 0o600);
    if (valid) {
      const file = join(f.directory, 'runtime-deployment.json');
      assert.equal(readFileSync(output, 'utf8'), `deployment_file=${file}\n`);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), deployment());
      assert.equal(statSync(file).mode & 0o777, 0o600);
    } else assert.equal(result.stderr.trim(), 'Runtime release: invalid_response');
  });
});

test('wrong source, role/account or mode fails before AWS calls', async () => {
  for (const change of [
    { TARGET: 'main' }, { AWS_ACCOUNT_ID_DEV: '' }, { AWS_ACCOUNT_ID_DEV: '999999999999' },
    { CI_ROLE_ARN: '' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_WORKFLOW_REF: 'wrong' },
    { PIN_SHA: '' }, { RUNTIME_MODE: 'database-only' }, { INVENTORY_POLICY: 'core' },
    { PUBLIC_URL: 'http://dev.example.com' }, { CLOUDFRONT_DOMAIN: 'attacker.example.com' },
  ]) await withFixture(async f => {
    await assert.rejects(f.release({ env: { ...f.env, ...change } }));
    assert.equal(f.calls.length, 0);
  });
  assert.doesNotThrow(() => validateContext(env));
});

test('the own CloudFront probe waits through busy/superseded without another full fan-out', async () => withFixture(async f => {
  let clock = Date.now() - 30_000, probes = 0;
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
  assert.deepEqual(f.authenticated[0].input.runtimeConfig.expectedQueuedTypes, catalog().types);
  assert.equal(f.authenticated[0].input.runtimeConfig.collectionMode, 'release');
}));

test('full collection synchronously drives every source catalog type with at most four workers', async () => {
  const types = sourceTypes;
  assert.equal(MIN_CATALOG_TYPES, types.length, 'The runtime floor must match the current registered source catalog');
  await withFixture(async f => {
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
    const result = await release(deployment(), { env: f.env,
      authenticate: (...args) => {
        if (!args[1].includeDatabaseClock)
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
  }, { catalog: { status: 'catalog', types } });
});

test('partial type is reported, other types settle, and incomplete collection cannot reach smoke', async () => withFixture(async f => {
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
}, { probes: { rds: { type: 'rds', status: 'partial', row_count: 0,
  unknown_attribute_count: 0, unreachable_account_count: 1 } } }));

test('reserved dispatcher names cannot enter the synchronous catalog', () => {
  for (const type of ['all', 'catalog'])
    assert.throws(() => validateCatalog({ status: 'catalog', types: [type, ...catalog().types.slice(1), 'cloudfront'] }),
      /invalid_collection_catalog/);
});

test('owned probes must disclose known counts and zero unknown attributes before authentication', async () => {
  for (const change of [{ unknown_attribute_count: 1 }, { unknown_attribute_count: null },
    { unknown_attribute_count: undefined }, { row_count: null }]) await withFixture(async f => {
    await assert.rejects(f.release(),
      /collection_probe_incomplete|inventory_incomplete/);
    assert.equal(f.authenticated.length, 0);
  }, { probe: { type: 'cloudfront', status: 'succeeded', row_count: 1,
    unknown_attribute_count: 0, ...change } });
});

test('unknown attributes in a collector success cannot satisfy complete collection', async () => withFixture(async f => {
  await assert.rejects(f.release(),
    error => error.message === 'inventory_incomplete' && error.collection_attempts.types.rds.status === 'unknown');
  assert.equal(f.authenticated.length, 0);
}, { probes: { rds: { type: 'rds', status: 'succeeded', row_count: 1,
  unknown_attribute_count: 1 } } }));

test('a throttled type has a bounded deadline without starving another catalog type', async () => withFixture(async f => {
  let clock = Date.now();
  const began = clock;
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
}));
test('catalog admission retries only confirmed throttling', async () => withFixture(async f => {
  let clock = Date.now() - 30_000, attempts = 0;
  const began = clock;
  await release(deployment(), { env: f.env, now: () => clock, wait: async ms => { clock += ms; },
    run: async (command, args) => {
      if (args[0] === 'lambda' && args[1] === 'invoke' && JSON.parse(args[args.indexOf('--payload') + 1]).type === 'catalog' && attempts++ < 2)
        throw new ReleaseError('aws_throttled');
      return f.run(command, args);
    }, authenticate: f.authenticate });
  assert.equal(attempts, 3);
  assert.equal(f.authenticated[0].input.runtimeConfig.collectionStartedAt, new Date(began + 20_000).toISOString());
}));

test('a long busy probe retries only when the next complete call preserves the proof reserve', async () => {
  for (const duration of [300_000, 420_000]) await withFixture(async f => {
    let clock = Date.now() - 900_000, probes = 0;
    const began = clock;
    let remainingFast = sourceTypes.length - 1, finishFast;
    const fastTypesSettled = new Promise(resolve => { finishFast = resolve; });
    const action = release(deployment(), { env: f.env, now: () => clock, wait: async ms => { clock += ms; },
      run: async (command, args, options) => {
        if (args[0] === 'lambda' && args[1] === 'invoke'
          && JSON.parse(args[args.indexOf('--payload') + 1]).type === 'cloudfront') {
          probes++;
          assert.equal(options.env.AWS_MAX_ATTEMPTS, '1');
          assert.equal(options.timeout, 450_000);
          await fastTypesSettled; // Other lanes finish while the slow CloudFront call is in flight.
          clock += duration;
          writeFileSync(args.at(-1), JSON.stringify({ type: 'cloudfront',
            status: probes === 1 ? 'busy' : 'succeeded',
            ...(probes > 1 ? { row_count: 1, unknown_attribute_count: 0 } : {}) }));
          return JSON.stringify({ StatusCode: 200, ExecutedVersion: '$LATEST' });
        }
        const result = await f.run(command, args);
        if (args[0] === 'lambda' && args[1] === 'invoke'
          && JSON.parse(args[args.indexOf('--payload') + 1]).type !== 'catalog'
          && --remainingFast === 0) finishFast();
        return result;
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
  });
});

test('uncertain CloudFront delivery is never retried or accepted as readiness', async () => withFixture(async f => {
  let probes = 0;
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
}));
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
  assert.deepEqual(validateCatalog(catalog()), catalog().types);
  for (const value of [{ status: 'partial', types: ['cloudfront'] }, { status: 'catalog', types: [] },
    { status: 'catalog', types: ['rds'] }, { status: 'catalog', types: ['cloudfront', 'cloudfront'] },
    { ...catalog(), status: 'partial' },
    { ...catalog(), types: ['cloudfront', 'cloudfront', ...catalog().types.slice(2)] },
    { ...catalog(), arbitrary: 'PRIVATE' }]) assert.throws(() => validateCatalog(value));
});
test('catalog floor rejects a shrunken hash-matching collector before type invocation or authentication', async () => {
  for (const types of [['cloudfront'], ['cloudfront', 'rds'], catalog().types.slice(0, -1)]) {
    assert.throws(() => validateCatalog({ status: 'catalog', types }), /invalid_collection_catalog/);
    await withFixture(async f => {
      await assert.rejects(f.release(), /invalid_collection_catalog/);
      assert.deepEqual(f.calls.filter(a => a[0] === 'lambda' && a[1] === 'invoke')
        .map(a => JSON.parse(a[a.indexOf('--payload') + 1]).type), ['catalog']);
      assert.equal(f.prepared.length, 0);
      assert.equal(f.authenticated.length, 0);
      assert.equal(existsSync(f.directory), false);
    }, { catalog: { status: 'catalog', types } });
  }
});
test('full catalog retains upper bound, valid names, unique members and CloudFront requirement', () => {
  const types = [...catalog().types, ...Array.from({ length: 128 - sourceTypes.length }, (_, i) => `future_${i}`)];
  assert.deepEqual(validateCatalog({ status: 'catalog', types }), types);
  for (const invalid of [[...types, 'too_many'], ['replacement', ...catalog().types.slice(1)],
    ['cloudfront', null, ...catalog().types.slice(2)], ['cloudfront', 'bad/type', ...catalog().types.slice(2)]])
    assert.throws(() => validateCatalog({ status: 'catalog', types: invalid }), /invalid_collection_catalog/);
});
test('collect binds running web, code hash, canonical coverage and the fresh own-workload probe', async () => withFixture(async f => {
  const now = Date.now();
  const result = await f.release({ now: () => now });
  assert.equal(result.status, 'full_verified');
  assert.equal(result.inventory_policy, 'full');
  assert.equal(result.inventory_quality.counts.verified, sourceTypes.length);
  assert.equal(result.web_tasks, 1);
  assert.equal(result.workers, 2);
  assert.equal(f.authenticated.length, 1);
  assert.deepEqual(f.authenticated[0].input.runtimeConfig, {
    schemaVersion: 1, mode: 'verify', hostOnly: true, expectedAccountId: account,
    expectedCloudfrontId: 'E123EXAMPLE', expectedQueuedTypes: catalog().types,
    collectionStartedAt: new Date(now).toISOString(), collectionMode: 'release',
    inventoryPolicy: 'full',
  });
  const invoke = f.calls.find(a => a[0] === 'lambda' && a[1] === 'invoke');
  assert.equal(invoke[invoke.indexOf('--function-name') + 1], deployment().inventory.sync_function_arn);
  assert.equal(invoke[invoke.indexOf('--invocation-type') + 1], 'RequestResponse');
  assert.equal(invoke[invoke.indexOf('--payload') + 1], '{"type":"catalog"}');
  assert.ok(!invoke.includes('--log-type'));
  assert.ok(!existsSync(f.directory));
}));

test('identity, wrong task role/revision/image/architecture and Lambda code failures block invocation', async () => {
  const r = await withFixture(f => f.responses);
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
  for (const change of changes) await withFixture(async f => {
    await assert.rejects(f.release(),
      e => !e.message.includes('PRIVATE'));
    assert.ok(!f.calls.some(a => a[0] === 'lambda' && a[1] === 'invoke'));
    assert.equal(f.authenticated.length, 0);
    assert.ok(!existsSync(f.directory));
  }, change);
});

for (const [label, change, readError] of [
  ['changed hash', { CodeSha256: Buffer.alloc(32, 4).toString('base64') }],
  ['same hash with a new revision', { RevisionId: '22222222-2222-4222-8222-222222222222' }],
  ['missing revision', { RevisionId: undefined }],
  ['update in progress', { LastUpdateStatus: 'InProgress' }],
  ...['aws_timeout', 'aws_access_denied', 'aws_throttled'].map(code => [code, {}, code]),
]) test(`collector recheck rejects ${label} before authentication and workers`, async () => withFixture(async f => {
  let configReads = 0;
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
    assert.equal(error.collection_attempts.counts.succeeded, sourceTypes.length);
    return true;
  });
  assert.equal(configReads, 2);
  assert.equal(f.authenticated.length, 0);
  assert.equal(existsSync(f.directory), false);
}));

test('bad invocation acknowledgement never starts smoke, and database-only return cannot pass collect', async () => {
  for (const change of [
    { invoke: { StatusCode: 200, FunctionError: 'Unhandled' } },
    { catalog: { ...catalog(), status: 'partial' } },
    { probe: { type: 'cloudfront', status: 'partial' } },
    { probe: { type: 'other', status: 'succeeded' } },
    { authResult: { status: 'ok', mode: 'database' } },
    { authResult: { status: 'ok', mode: 'verify' } },
  ]) await withFixture(async f => {
    await assert.rejects(f.release());
    assert.ok(!existsSync(f.directory));
  }, change);
});

test('prepare uses ordinary authenticated account preparation before backend boot, without Lambda access', async () => withFixture(async f => {
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
}));

test('capture persists only validated deployment metadata in the credential directory', async () => withFixture(async f => {
  const file = captureDeployment(deployment(), f.env);
  assert.equal(file, join(f.directory, 'runtime-deployment.json'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), deployment());
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => captureDeployment(deployment(), f.env)); // no overwrite/symlink following
}));

test('disabled runtime features fail capture before any deployment contract or AWS call', async () => withFixture(async f => {
  const value = deployment();
  value.features.inventory = false;
  assert.throws(() => captureDeployment(value, f.env), /runtime_not_enabled/);
  assert.equal(existsSync(join(f.directory, 'runtime-deployment.json')), false);
  assert.equal(f.calls.length, 0);
}));

test('cleanup cannot replace a primary fixed context failure', async () => {
  await assert.rejects(release(deployment(), {
    env: { ...env, GITHUB_REPOSITORY: 'wrong/repo', SMOKE_CREDENTIAL_FILE: '/invalid/credentials.json' },
    run: async () => { throw new Error('AWS must not run'); },
  }), error => error.message === 'invalid_dev_source');
});

test('existing OCI indexes bind the running ARM64 child and reject indexes without ARM64', async () => {
  for (const architecture of ['arm64', 'amd64']) for (const aliases of [false, true]) {
    const child = `sha256:${'d'.repeat(64)}`;
    const index = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [{ digest: child, platform: { architecture, os: 'linux' } }] });
    const indexDigest = `sha256:${createHash('sha256').update(index).digest('hex')}`;
    await withFixture(async f => {
      f.responses['ecr batch-get-image'].images[0].imageManifest = index;
      f.responses['ecr batch-get-image'].images[0].imageId.imageDigest = indexDigest;
      if (aliases) {
        const entry = f.responses['ecr batch-get-image'].images[0];
        f.responses['ecr batch-get-image'].images.push({ ...entry, imageId: { ...entry.imageId, imageTag: 'web-latest' } });
      }
      f.env.EXPECTED_WEB_DIGEST = indexDigest;
      f.responses['ecs describe-tasks'].tasks[0].containers[0].imageDigest = child;
      const action = f.release();
      if (architecture === 'arm64') assert.equal((await action).status, 'full_verified');
      else {
        await assert.rejects(action);
        assert.ok(!f.calls.some(a => a[0] === 'lambda' && a[1] === 'invoke'));
      }
    });
  }
});

test('digest lookup accepts the two promotion tags only as one identical image identity', async () => {
  for (const event of ['push', 'workflow_dispatch']) await withFixture(async f => {
    f.env.GITHUB_WORKFLOW_REF = 'aws-samples/sample-awsops/.github/workflows/deploy-web.yml@refs/heads/dev';
    f.env.GITHUB_EVENT_NAME = event;
    f.env.EXPECTED_WEB_DIGEST = digest;
    const entry = f.responses['ecr batch-get-image'].images[0];
    f.responses['ecr batch-get-image'].images.push({ ...entry, imageId: { ...entry.imageId, imageTag: 'web-latest' } });
    assert.equal((await f.release()).status, 'full_verified');
    assert.equal(f.responses['ecr batch-get-image'].images.length, 2);
    const call = f.calls.find(args => args[0] === 'ecr');
    assert.ok(call.includes(`imageDigest=${digest}`));
  });
});

test('every additional ECR entry must match account repository digest and identical bounded manifest', async () => {
  for (const change of [
    { registryId: '999999999999' }, { repositoryName: 'another-repository' },
    { imageId: { imageTag: 'web-latest', imageDigest: `sha256:${'f'.repeat(64)}` } },
    { imageManifest: `${body} ` }, { imageManifest: 'x'.repeat(256_001) },
    { imageManifest: null }, { imageId: null }, null, 'malformed',
  ]) await withFixture(async f => {
    f.env.EXPECTED_WEB_DIGEST = digest;
    const entry = f.responses['ecr batch-get-image'].images[0];
    const alias = { ...entry, imageId: { ...entry.imageId, imageTag: 'web-latest' } };
    f.responses['ecr batch-get-image'].images.push(change && typeof change === 'object' ? { ...alias, ...change } : change);
    await assert.rejects(f.release(), /web_image_identity_mismatch/);
    assert.equal(f.calls.some(args => args[0] === 'ecs' || args[0] === 'lambda'), false);
    assert.equal(f.prepared.length, 0);
  });
});

test('tag lookup keeps every returned entry bound to the requested tag', async () => {
  for (const tag of [`web-${sha}`, 'web-latest', undefined]) await withFixture(async f => {
    const entry = f.responses['ecr batch-get-image'].images[0];
    f.responses['ecr batch-get-image'].images.push({ ...entry, imageId: { ...entry.imageId, imageTag: tag } });
    const operation = f.release();
    if (tag === `web-${sha}`) assert.equal((await operation).status, 'full_verified');
    else {
      await assert.rejects(operation, /web_image_identity_mismatch/);
      assert.equal(f.prepared.length, 0);
    }
    assert.ok(f.calls.find(args => args[0] === 'ecr').includes(`imageTag=web-${sha}`));
  });
});

test('ECR normalization still rejects empty malformed failed and hash-mismatched responses', async () => {
  for (const images of [[], undefined, {}, [null], ['malformed']]) await withFixture(async f => {
    f.responses['ecr batch-get-image'].images = images;
    await assert.rejects(f.release(), /expected_web_image_missing|web_image_identity_mismatch/);
    assert.equal(f.prepared.length, 0);
  });
  for (const failed of [true, false]) await withFixture(async f => {
    f.env.EXPECTED_WEB_DIGEST = digest;
    const response = f.responses['ecr batch-get-image'];
    if (failed) response.failures = [{ failureCode: 'ImageNotFound' }];
    else response.images[0].imageManifest = `${body} `;
    response.images.push({ ...response.images[0], imageId: { ...response.images[0].imageId, imageTag: 'web-latest' } });
    await assert.rejects(f.release(), failed ? /expected_web_image_missing/ : /web_manifest_digest_mismatch/);
    assert.equal(f.prepared.length, 0);
  });
});

test('post-pin release requires a digest and ignores a moved source tag', async () => {
  for (const selected of [undefined, 'invalid', digest]) await withFixture(async f => {
    f.env.GITHUB_WORKFLOW_REF = 'aws-samples/sample-awsops/.github/workflows/deploy-web.yml@refs/heads/dev';
    if (selected !== undefined) f.env.EXPECTED_WEB_DIGEST = selected;
    f.responses['ecr batch-get-image'].images[0].imageId.imageTag = 'source-tag-moved';
    const operation = f.release();
    if (selected === digest) {
      assert.equal((await operation).status, 'full_verified');
      const call = f.calls.find(a => a[0] === 'ecr');
      assert.ok(call.includes(`imageDigest=${digest}`));
      assert.ok(!call.some(a => a.startsWith('imageTag=')));
    } else {
      await assert.rejects(operation, /expected_web_digest/);
      assert.equal(f.calls.length, 0);
    }
  });
});

test('approved root digest still rejects a different running image', async () => withFixture(async f => {
  f.env.EXPECTED_WEB_DIGEST = digest;
  f.responses['ecs describe-tasks'].tasks[0].containers[0].imageDigest = `sha256:${'e'.repeat(64)}`;
  await assert.rejects(f.release(),
    /running_web_mismatch/);
  assert.equal(f.authenticated.length, 0);
}));

test('full controller rejects successful-looking incomplete inventory proof', async () => {
  for (const status of ['gaps', 'complete']) {
    const quality = { status, catalog_types: catalog().types,
      counts: { expected: sourceTypes.length, verified: sourceTypes.length - 1, missing: 1 },
      types: { verified: catalog().types.filter(t => t !== 'rds'), missing: ['rds'] } };
    await withFixture(async f => {
      f.env.INVENTORY_POLICY = 'full';
      await assert.rejects(f.release(),
        /complete_runtime_proof_required/);
    }, { authResult: { status: 'ok', mode: 'verify',
      inventory_policy: 'full', inventory_quality: quality, workers: 2 } });
  }
});

test('complete proof must contain every verified type and zero consistent gap counters', async () => {
  for (const mutate of [
    quality => { quality.counts.unknown = 1; },
    quality => { quality.types.pending.push('rds'); },
    quality => { quality.types.verified[1] = quality.types.verified[0]; },
    quality => { quality.counts.pending = '0'; },
  ]) await withFixture(async f => {
    await assert.rejects(release(deployment(), { env: f.env, run: f.run,
      authenticate: async (...args) => {
        const result = await f.authenticate(...args);
        if (!args[1].includeDatabaseClock) mutate(result.inventory_quality);
        return result;
      },
    }), /complete_runtime_proof_required/);
    assert.equal(existsSync(f.directory), false);
  });
});

test('controller total budget emits a typed failure before the outer step timeout', async () => withFixture(async f => {
  let clock = Date.now();
  await assert.rejects(release(deployment(), { env: f.env, now: () => clock, authenticate: f.authenticate,
    run: async (cmd, args, options) => {
      assert.ok(options.timeout <= 150_000);
      clock += 600_000;
      return f.run(cmd, args);
    } }), error => error.message === 'release_timeout');
  assert.equal(f.authenticated.length, 0);
}));

test('runtime proof receives the earlier controller or marker deadline without resetting it', async () => {
  for (const setupMinutes of [0, 25, 26]) await withFixture(async f => {
    const start = Date.now() - setupMinutes * 60_000 - 1000;
    let clock = start;
    const action = release(deployment(), { env: f.env, now: () => clock, authenticate: f.authenticate,
      run: async (cmd, args) => {
        if (args[0] === 'sts') clock += setupMinutes * 60_000;
        return f.run(cmd, args);
      } });
    if (setupMinutes === 26) {
      await assert.rejects(action, error => {
        assert.equal(error.collection_attempts.counts.not_started, sourceTypes.length);
        assert.equal(error.collection_attempts.counts.deadline, sourceTypes.length);
        return true;
      });
      assert.equal(f.authenticated.length, 0);
      return;
    }
    await action;
    const { input, options } = f.authenticated[0];
    const marker = Date.parse(input.runtimeConfig.collectionStartedAt);
    assert.equal(options.deadline, Math.min(start + 50 * 60_000, marker + 30 * 60_000));
  });
});

test('late batches cannot spend the authentication and runtime proof reserve', async () => {
  for (const setupMinutes of [0, 25]) {
    const first = ['cloudfront', 'rds', 'ec2', 's3', 'iam_user'];
    const types = [...first, ...sourceTypes.filter(type => !first.includes(type))];
    await withFixture(async f => {
      let clock = Date.now() - (setupMinutes + 10) * 60_000;
      const invoked = [];
      let finishBatch;
      const batch = new Promise(resolve => { finishBatch = resolve; });
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
    }, { catalog: { status: 'catalog', types } });
  }
});

test('a successful adapter cannot certify release at or beyond the marker deadline', async () => {
  for (const lateBy of [0, 1]) await withFixture(async f => {
    let clock = Date.now() - 1000;
    await assert.rejects(release(deployment(), { env: f.env, run: f.run, now: () => clock,
      authenticate: async (input, options) => {
        const result = await f.authenticate(input, options);
        if (!options.includeDatabaseClock)
          clock = Date.parse(input.runtimeConfig.collectionStartedAt) + 30 * 60_000 + lateBy;
        return result;
      } }), error => error instanceof ReleaseError && error.message === 'release_timeout');
    assert.equal(existsSync(f.directory), false);
  });
});

test('capture refuses unsafe credential modes and existing symlink targets', async () => {
  for (const unsafe of ['mode', 'symlink']) await withFixture(async f => {
    if (unsafe === 'mode') chmodSync(f.credentials, 0o644);
    else symlinkSync(f.credentials, join(f.directory, 'runtime-deployment.json'));
    assert.throws(() => captureDeployment(deployment(), f.env));
    assert.match(readFileSync(f.credentials, 'utf8'), /FIXTURE_PASSWORD/);
  });
});

test('release freshness starts before the owned probe and is not reset by its response', async () => withFixture(async f => {
  const start = Date.now() - 2000;
  let time = start;
  const run = async (cmd, args) => {
    if (args[0] === 'lambda' && args[1] === 'invoke') time += 1000;
    return f.run(cmd, args);
  };
  await release(deployment(), { env: f.env, run, authenticate: f.authenticate, now: () => time });
  assert.equal(f.authenticated[0].input.runtimeConfig.collectionStartedAt, new Date(start + 1000).toISOString());
}));

test('DB request-start calibration preserves skew and the earlier controller deadline', async () => {
  for (const skew of [-5000, 5000]) for (const setup of [0, 25 * 60_000]) await withFixture(async f => {
    const began = Date.now();
    let raw = began, requestStarted;
    const result = await release(deployment(), { env: f.env, now: () => raw,
      run: async (cmd, args, options) => {
        if (args[0] === 'sts') raw += setup;
        if (args[0] === 'lambda' && args[1] === 'invoke'
          && JSON.parse(args[args.indexOf('--payload') + 1]).type !== 'catalog')
          assert.equal(f.prepared.length, 1, 'Host and DB clock proof must precede every type');
        return f.run(cmd, args, options);
      },
      authenticate: async (input, options) => {
        if (!options.includeDatabaseClock) return f.authenticate(input, options);
        const prepared = await f.authenticate(input, options);
        assert.deepEqual(f.calls.filter(a => a[0] === 'lambda' && a[1] === 'invoke')
          .map(a => JSON.parse(a[a.indexOf('--payload') + 1]).type), ['catalog']);
        raw += 1000; requestStarted = raw;
        raw += setup === 0 && skew > 0 ? 35_000 : 2000;
        prepared.database_clock = { server_time: new Date(requestStarted + skew).toISOString(),
          request_started_at_ms: requestStarted, response_observed_at_ms: raw };
        raw += 3000; // Host registry proof follows the DB response.
        return prepared;
      },
    });
    assert.equal(result.status, 'full_verified');
    const { input, options } = f.authenticated[0];
    assert.equal(input.runtimeConfig.collectionStartedAt, new Date(requestStarted + skew).toISOString());
    assert.equal(options.now(), raw + skew);
    assert.equal(options.deadline, Math.min(began + 50 * 60_000, requestStarted + 30 * 60_000) + skew);
    assert.equal(options.deadline - options.now(),
      Math.min(began + 50 * 60_000, requestStarted + 30 * 60_000) - raw);
  });
});

test('failed prepare or unbound DB clock metadata invokes no collection types', async () => {
  for (const mutate of [
    r => { r.status = 'failed'; }, r => { r.mode = 'database'; }, r => { r.public_tables = 0; },
    r => { delete r.database_clock; }, r => { r.database_clock.server_time = 'invalid'; },
    r => { r.database_clock.server_time = r.database_clock.server_time.replace('.000Z', 'Z'); },
    r => { r.database_clock.request_started_at_ms = NaN; },
    r => { r.database_clock.response_observed_at_ms = Infinity; },
    r => { r.database_clock.request_started_at_ms = String(r.database_clock.request_started_at_ms); },
    r => { r.database_clock.request_started_at_ms -= 1001; },
    r => { r.database_clock.response_observed_at_ms = r.database_clock.request_started_at_ms - 1; },
    r => { r.database_clock.response_observed_at_ms += 40_000; },
    r => { r.database_clock.response_observed_at_ms = r.database_clock.request_started_at_ms + 35_001; },
    () => { throw new SmokeError('Runtime smoke: host_registry'); },
    () => { throw new Error('PRIVATE_REMOTE_DETAIL'); },
    (r, expire) => { expire(); },
  ]) await withFixture(async f => {
    let raw = Date.parse('2026-09-14T12:00:00.000Z');
    await assert.rejects(release(deployment(), { env: f.env, run: f.run, now: () => raw,
      authenticate: async (input, options) => {
        if (!options.includeDatabaseClock) return f.authenticate(input, options);
        const result = await f.authenticate(input, options);
        result.database_clock.request_started_at_ms += 1000;
        result.database_clock.response_observed_at_ms += 2000;
        raw += 40_000;
        mutate(result, () => { raw += 50 * 60_000; });
        return result;
      },
    }), e => /database_clock_invalid|host_registry|authenticated_runtime_proof_failed|release_timeout/.test(e.message)
      && !e.message.includes('PRIVATE'));
    assert.deepEqual(f.calls.filter(a => a[0] === 'lambda' && a[1] === 'invoke')
      .map(a => JSON.parse(a[a.indexOf('--payload') + 1]).type), ['catalog']);
    assert.equal(f.authenticated.length, 0);
    assert.equal(existsSync(f.directory), false);
  });
});

test('calibrated collection still rejects rows one millisecond before the DB marker', async () => {
  for (const skew of [-5000, 5000]) await withFixture(async f => {
    let raw = Date.now();
    const dbMarker = raw + skew, paths = [];
    await assert.rejects(release(deployment(), { env: f.env, run: f.run, now: () => raw,
      authenticate: async (input, options) => {
        if (options.includeDatabaseClock) {
          const result = await f.authenticate(input, options);
          result.database_clock.server_time = new Date(dbMarker).toISOString();
          return result;
        }
        try {
          return await verifyRuntimeSmoke(input.runtimeConfig, async path => {
            paths.push(path);
            if (path === '/api/accounts') return { accounts: [{ accountId: account, isHost: true, enabled: true }] };
            assert.equal(path, '/api/inventory/summary?accounts=self&view=collection');
            return { collection: { configured: true, readOk: true, runs: catalog().types.map(type => ({
              type, accountId: 'self', status: 'succeeded', row_count: 1,
              started_at: new Date(dbMarker - 1).toISOString(), last_success_at: new Date(dbMarker - 1).toISOString(),
              unknown_attribute_count: 0, unknown_attributes: false,
            })) } };
          }, { ...options, wait: async ms => { raw += ms; } });
        } catch (error) { throw new SmokeError(error.message); }
      },
    }), /collection_stale/);
    assert.equal(f.prepared.length, 1);
    assert.ok(paths.length > 1);
    assert.ok(paths.every(path => path === '/api/accounts' || path.startsWith('/api/inventory/summary?')));
  });
});

test('retains trusted smoke diagnostics while suppressing arbitrary thrown text', async () => {
  for (const [error, expected] of [
    [new SmokeError('Runtime smoke: runtime_parameters_not_ready(runtime_arn=denied)'),
      'Runtime smoke: runtime_parameters_not_ready(runtime_arn=denied)'],
    [new Error('PRIVATE_REMOTE_DETAIL'), 'authenticated_runtime_proof_failed'],
  ]) await withFixture(async f => {
    await assert.rejects(release(deployment(), { env: f.env, run: f.run,
      authenticate: async (...args) => {
        if (args[1].includeDatabaseClock) return f.authenticate(...args);
        throw error;
      } }), e => e.message === expected);
  });
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
  for (const code of ['aws_access_denied', 'aws_throttled']) await withFixture(async f => {
    let clock = Date.now(), calls = 0;
    const started = clock;
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
  });
});

for (const skew of [-5000, 5000]) test(`real authenticated smoke composes DB clock and full release with skew ${skew}`,
  async () => withFixture(async f => {
    let raw = Date.parse('2026-09-14T12:00:00.000Z'), marker, configReads = 0;
    const events = [], runs = [], jobs = [], phases = [];
    const runCurl = async (command, args, options) => {
      assert.equal(command, 'curl');
      assert.ok(!JSON.stringify({ args, env: options.env }).includes('FIXTURE_PASSWORD'));
      const path = new URL(args.at(-1)).pathname;
      const output = args[args.indexOf('--output') + 1];
      const body = args.includes('--data-binary')
        ? JSON.parse(readFileSync(args[args.indexOf('--data-binary') + 1].slice(1), 'utf8')) : {};
      events.push(path);
      let response, status = '200';
      if (path === '/api/auth/login') {
        assert.equal(body.password, 'FIXTURE_PASSWORD');
        writeFileSync(args[args.indexOf('--cookie-jar') + 1],
          '#HttpOnly_dev.example.com\tFALSE\t/\tTRUE\t0\tawsops_token\tFIXTURE_COOKIE\n');
        response = { ok: true };
      } else if (path === '/api/db') {
        const server_time = new Date(raw + skew).toISOString();
        marker ??= server_time;
        response = { status: 'ok', public_tables: 42, server_time };
      } else if (path === '/api/accounts') {
        response = { accounts: [{ accountId: account, isHost: true, enabled: true }] };
      } else if (path === '/api/inventory/summary') {
        response = { collection: { configured: true, readOk: true, runs } };
      } else if (path === '/api/inventory/cloudfront') {
        response = { rows: [{ resource_id: 'E123EXAMPLE', account_id: 'self',
          captured_at: runs[0].started_at, data: { id: 'E123EXAMPLE' } }] };
      } else if (path === '/api/deployment/readiness') {
        assert.equal(configReads, 2);
        response = { schemaVersion: 1, nonce: body.nonce, accountId: account, status: 'ready', reason: 'ok',
          webIdentity: true, parameters: { runtime_arn: 'ready', interpreter_id: 'ready', memory_id: 'ready' },
          agent: { schemaVersion: 1, mode: 'deployment_readiness', nonce: body.nonce, accountId: account,
            status: 'ready', reason: 'ok', inventory: { count: 1, ageMinutes: 0 },
            checks: { identity: true, inventorySummary: true, inventoryQuery: true,
              knownResource: true, freshInventory: true, model: true } } };
      } else if (path === '/api/jobs') {
        const job_id = `${jobs.length ? '22222222' : '11111111'}-1111-4111-8111-111111111111`;
        jobs.push({ job_id, type: body.type, runtime: body.type === 'noop' ? 'lambda' : 'fargate',
          status: 'succeeded', dry_run: body.dry_run, result: { ok: true } });
        response = { job_id, status: 'queued' }; status = '202';
      } else {
        response = jobs.find(job => path === `/api/jobs/${job.job_id}`);
        assert.ok(response, 'Only the two owned worker status routes may follow enqueue');
      }
      raw += 10;
      assert.equal(statSync(output).mode & 0o777, 0o600);
      writeFileSync(output, JSON.stringify(response));
      return { stdout: status };
    };
    const result = await release(deployment(), { env: f.env, now: () => raw,
      run: async (cmd, args, options) => {
        if (args[0] === 'lambda' && args[1] === 'get-function-configuration') configReads++;
        if (args[0] === 'lambda' && args[1] === 'invoke') {
          const { type } = JSON.parse(args[args.indexOf('--payload') + 1]);
          events.push(type);
          if (type !== 'catalog') {
            assert.deepEqual(phases, ['prepare']);
            const timestamp = new Date(raw + skew).toISOString();
            assert.ok(Date.parse(timestamp) >= Date.parse(marker));
            runs.push({ type, accountId: 'self', status: 'succeeded', row_count: 1,
              started_at: timestamp, last_success_at: timestamp,
              unknown_attribute_count: 0, unknown_attributes: false });
          }
        }
        return f.run(cmd, args, options);
      },
      authenticate: (input, options) => {
        phases.push(input.runtimeConfig.mode);
        if (input.runtimeConfig.mode === 'verify') {
          assert.equal(input.runtimeConfig.collectionStartedAt, marker);
          assert.equal(options.now(), raw + skew);
        }
        return authenticatedSmoke(input, { ...options, runCurl });
      },
    });
    assert.equal(result.status, 'full_verified');
    assert.deepEqual(phases, ['prepare', 'verify']);
    assert.deepEqual(events.slice(0, 4), ['catalog', '/api/auth/login', '/api/db', '/api/accounts']);
    assert.deepEqual(result.inventory_quality.types.verified, catalog().types);
    assert.deepEqual(jobs.map(job => [job.type, job.runtime, job.dry_run]),
      [['noop', 'lambda', false], ['noop-heavy', 'fargate', false]]);
    assert.equal(result.workers, 2);
    assert.equal(existsSync(f.directory), false);
    assert.ok(!JSON.stringify(result).includes('FIXTURE_COOKIE'));
  }));
