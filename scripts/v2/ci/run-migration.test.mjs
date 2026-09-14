import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';

// Keep AWS at the transport boundary: validation, registration, launch, polling
// and cleanup below all exercise the production controller.
import { runMigration, cleanupMigration, selectProject } from './run-migration.mjs';
import { databaseFailure } from '../migration-errors.mjs';
import { loadCredentials, readJsonSecret, migrateDatabase } from '../migrate.mjs';
import { initializeEmptyDatabase } from '../initialize-db.mjs';
const account = '123456789012';
const region = 'ap-northeast-2';
const project = 'awsops-v2-dev';
const prefix = `arn:aws:ecs:${region}:${account}:`;
const repo = `${account}.dkr.ecr.${region}.amazonaws.com/${project}-web`;
const digest = `sha256:${'d'.repeat(64)}`;
const sha = 'a'.repeat(40);
const templateArn = `${prefix}task-definition/${project}-migration:1`;
const cloneArn = `${prefix}task-definition/${project}-migration:2`;
const taskArn = `${prefix}task/${project}/${'b'.repeat(32)}`;
const cluster = `${prefix}cluster/${project}`;
const startedBy = 'migration-123-1';

function fixture() {
  return {
    context: {
      repository: 'aws-samples/sample-awsops', ref: 'refs/heads/dev',
      event: 'workflow_dispatch', sha, runId: '123', attempt: '1', project,
      region, digest, image: `${repo}@${digest}`,
      deployRoleArn: `arn:aws:iam::${account}:role/sample-awsops-dev-ci-deployer`,
    },
    config: {
      project, region, cluster, task_template_arn: templateArn, repository_url: repo,
      subnets: ['subnet-0123456789abcdef0', 'subnet-0123456789abcdef1'],
      security_groups: ['sg-0123456789abcdef0'], log_group: `/ecs/${project}-migration`,
    },
    template: {
      taskDefinitionArn: templateArn, family: `${project}-migration`,
      revision: 1, status: 'ACTIVE', registeredBy: 'metadata-must-not-be-copied',
      requiresAttributes: [], compatibilities: ['EC2', 'FARGATE'],
      executionRoleArn: `arn:aws:iam::${account}:role/${project}-task-execution`,
      taskRoleArn: `arn:aws:iam::${account}:role/${project}-migration-task`,
      networkMode: 'awsvpc', cpu: '256', memory: '512', volumes: [],
      requiresCompatibilities: ['FARGATE'],
      runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      containerDefinitions: [{
        name: 'migration', image: `${repo}:migration-unbuilt`, essential: true,
        user: '1000:1000', readonlyRootFilesystem: true, stopTimeout: 30,
        cpu: 0, mountPoints: [], portMappings: [], volumesFrom: [],
        environment: Object.entries({
          AWS_REGION: region, AURORA_ENDPOINT: `example.cluster-abc.${region}.rds.amazonaws.com`,
          AURORA_DATABASE: 'awsops',
          AURORA_SECRET_ARN: `arn:aws:secretsmanager:${region}:${account}:secret:rds!cluster-example-ABC123`,
          SQL_READER_SECRET_ARN: '', SQL_READER_SYNC_MODE: 'disabled', INITIALIZE_EMPTY_DB: '1',
        }).map(([name, value]) => ({ name, value })),
        logConfiguration: {
          logDriver: 'awslogs', options: {
            'awslogs-group': `/ecs/${project}-migration`, 'awslogs-region': region,
            'awslogs-stream-prefix': 'migration',
          },
        },
      }],
    },
  };
}

function task(overrides = {}) {
  return {
    taskArn, clusterArn: cluster, taskDefinitionArn: cloneArn, startedBy,
    lastStatus: 'STOPPED', launchType: 'FARGATE',
    containers: [{ name: 'migration', lastStatus: 'STOPPED', exitCode: 0, imageDigest: digest }],
    ...overrides,
  };
}

function harness(f = fixture(), override = {}) {
  const calls = [];
  const messages = [];
  let record;
  let time = 0;
  let registered;
  const deps = {
    now: () => time,
    sleep: async ms => { time += ms; },
    pollMs: 10, timeoutMs: 30, cleanupTimeoutMs: 30,
    log: m => messages.push(m),
    save: async r => { record = structuredClone(r); },
    currentSha: async () => { calls.push(['head']); return sha; },
    aws: async (service, operation, args) => {
      calls.push([service, operation, structuredClone(args)]);
      if (operation === 'list-tasks' && args.startedBy) {
        assert.ok(Object.keys(args).every(key => ['cluster', 'startedBy', 'maxResults', 'nextToken'].includes(key)),
          'ECS rejects combining startedBy with another ListTasks filter');
      }
      if (override[operation]) return override[operation](args, calls);
      switch (operation) {
        case 'get-caller-identity':
          return { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/sample-awsops-dev-ci-deployer/test` };
        case 'batch-get-image':
          return { images: [{ registryId: account, repositoryName: `${project}-web`,
            imageId: { imageDigest: digest, imageTag: `migration-${sha}` } }], failures: [] };
        case 'describe-task-definition': return { taskDefinition: f.template };
        case 'register-task-definition':
          registered = args;
          return { taskDefinition: { ...args, taskDefinitionArn: cloneArn, status: 'ACTIVE' } };
        case 'run-task': return { tasks: [task({ lastStatus: 'PROVISIONING' })], failures: [] };
        case 'describe-tasks': return { tasks: [task()], failures: [] };
        case 'stop-task': return { task: task() };
        case 'list-tasks': return { taskArns: [taskArn] };
        case 'get-log-events': return { events: [{ message: 'password=SECRET\n::warning::injected SQLSTATE 42P01' }] };
        default: throw new Error(`Unexpected transport ${service}/${operation}`);
      }
    },
  };
  return { f, deps, calls, messages, get record() { return record; }, get registered() { return registered; } };
}

test('select a literal project from dev tfvars; reject ambiguity without echoing config', () => {
  assert.equal(selectProject('project = "awsops-v2-dev"\nregion = "ap-northeast-2"\ndemo_password = "SECRET"'), project);
  for (const text of ['project="unsafe/other"', 'project="one"\nproject="two"',
    'project="${evil}"', 'project="a"; touch injected', 'region="us-east-1"\nproject="awsops-v2-dev"',
    'project = var.project', 'project = ""', 'region="us-east-1"', 'region=var.region',
    'region="ap-northeast-2"\nregion="ap-northeast-2"', '/* project omitted */', 'project=<<EOF']) {
    assert.throws(() => selectProject(text), /project|region|tfvars/i);
  }
});

test('configure-generated project omission resolves in lockstep with the Terraform default', async () => {
  const variables = await readFile(new URL('../../../terraform/foundation/variables.tf', import.meta.url), 'utf8');
  const defaultProject = /variable "project"\s*\{[^}]*\bdefault\s*=\s*"([^"]+)"/.exec(variables)?.[1];
  assert.equal(defaultProject, 'awsops-v2');
  const source = await readFile(new URL('../configure.mjs', import.meta.url), 'utf8');
  // Run the actual pure HCL writers without the interactive/AWS entry point.
  const writers = source.slice(source.indexOf('function hclString('), source.indexOf('function readExistingFlag('));
  for (const createNetwork of [true, false]) {
    const text = runInNewContext(`${writers}\nbuildTfvars(cfg)`, { cfg: {
      createNetwork, domainName: 'dev.example.com', hostedZoneName: 'example.com',
      vpcCidr: '10.0.0.0/16', existingVpcId: 'vpc-0123456789abcdef0',
      existingPrivateSubnetIds: ['subnet-0123456789abcdef0'], agentcoreEnabled: true,
    } });
    assert.doesNotMatch(text, /^\s*project\s*=/m);
    assert.equal(selectProject(text), defaultProject);
  }
  assert.equal(selectProject(''), defaultProject);
  assert.equal(selectProject('# project="ignored"\nregion="ap-northeast-2"'), defaultProject);
});

test('project CLI reads stdin and never prints the surrounding secret config', () => {
  for (const [input, expected] of [
    ['project = "awsops-v2-dev"\ndemo_password = "SECRET"\n', 'awsops-v2-dev'],
    ['demo_password = "SECRET"\n', 'awsops-v2'],
  ]) {
    const command = spawnSync(process.execPath, [new URL('./run-migration.mjs', import.meta.url).pathname, 'project'], {
      input, encoding: 'utf8',
    });
    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stdout, `${expected}\n`);
    assert.ok(!command.stderr.includes('SECRET'));
  }
});

test('default project cannot bypass the Terraform output cross-stack check', async () => {
  const h = harness();
  h.f.context.project = selectProject('');
  h.f.context.image = h.f.context.image.replace(project, h.f.context.project);
  await assert.rejects(runMigration(h.f, h.deps), /output does not match the development stack/);
  assert.equal(h.calls.length, 0);
});

test('AWS registration response defaults and JSON key order do not reject the approved clone', async () => {
  const h = harness(fixture(), {
    'register-task-definition': args => ({
      taskDefinition: {
        ...args, taskDefinitionArn: cloneArn, status: 'ACTIVE',
        containerDefinitions: [{
          ...args.containerDefinitions[0], cpu: 0, portMappings: [], mountPoints: [], volumesFrom: [],
          logConfiguration: {
            options: { 'awslogs-stream-prefix': 'migration', 'awslogs-region': region, 'awslogs-group': `/ecs/${project}-migration` },
            logDriver: 'awslogs',
          },
        }],
      },
    }),
  });
  await runMigration(h.f, h.deps);
});

test('launches exactly one private task pinned to this build digest, with only approved registration fields', async () => {
  const h = harness();
  const result = await runMigration(h.f, h.deps);
  assert.equal(result.taskArn, taskArn);
  assert.equal(result.exitCode, 0);
  assert.equal(h.registered.containerDefinitions[0].image, `${repo}@${digest}`);
  for (const field of ['revision', 'registeredBy', 'requiresAttributes', 'status', 'taskDefinitionArn', 'volumes']) {
    assert.equal(Object.hasOwn(h.registered, field), false, field);
  }
  const launches = h.calls.filter(c => c[1] === 'run-task');
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0][2], {
    cluster, taskDefinition: cloneArn, count: 1, launchType: 'FARGATE', platformVersion: '1.4.0',
    enableExecuteCommand: false, startedBy, clientToken: startedBy,
    networkConfiguration: { awsvpcConfiguration: {
      subnets: h.f.config.subnets, securityGroups: h.f.config.security_groups, assignPublicIp: 'DISABLED',
    } },
  });
  assert.equal(h.calls[h.calls.indexOf(launches[0]) - 1][0], 'head');
  assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
});

test('rejects other repositories, branches, events, malformed digest and untrusted deploy role before AWS', async () => {
  for (const [key, value] of Object.entries({
    repository: 'other/repo', ref: 'refs/heads/main', event: 'push', sha: 'HEAD',
    digest: 'latest', image: `${repo}:migration-${sha}`, runId: '../123',
    deployRoleArn: `arn:aws:iam::${account}:user/Administrator`,
  })) {
    const h = harness();
    h.f.context[key] = value;
    await assert.rejects(runMigration(h.f, h.deps));
    assert.equal(h.calls.length, 0, key);
  }
});

test('configured development role names, paths and surrounding input whitespace work without renaming IAM roles', async () => {
  for (const resource of ['DeploymentRole', 'platform/ci/Deploy+Preview']) {
    const f = fixture();
    f.context.deployRoleArn = ` \narn:aws:iam::${account}:role/${resource}\n`;
    const roleName = resource.split('/').at(-1);
    const h = harness(f, {
      'get-caller-identity': () => ({
        Account: account, Arn: `arn:aws:sts::${account}:assumed-role/${roleName}/GitHubActions`,
      }),
    });
    assert.equal((await runMigration(f, h.deps)).exitCode, 0);
    assert.equal(h.calls.filter(c => c[1] === 'run-task').length, 1);
  }
});

test('the exact configured caller is required before ECR or ECS access', async () => {
  const f = fixture();
  f.context.deployRoleArn = `arn:aws:iam::${account}:role/platform/DeploymentRole`;
  for (const caller of [
    { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/OtherRole/GitHubActions` },
    { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/DeploymentRole-extra/GitHubActions` },
    { Account: account, Arn: `arn:aws:iam::${account}:user/DeploymentRole` },
    { Account: '999999999999', Arn: `arn:aws:sts::999999999999:assumed-role/DeploymentRole/GitHubActions` },
  ]) {
    const h = harness(f, { 'get-caller-identity': () => caller });
    await assert.rejects(runMigration(f, h.deps), /caller/);
    assert.deepEqual(h.calls.map(c => c.slice(0, 2)), [['sts', 'get-caller-identity']]);
  }
});

test('build role preflight binds both development secrets and validates the actual STS caller privately', () => {
  const buildArn = `arn:aws:iam::${account}:role/platform/BuildRole`;
  const deployArn = `arn:aws:iam::${account}:role/platform/DeploymentRole`;
  const caller = { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/BuildRole/GitHubActions` };
  const cli = (mode, changes = {}, input = caller) => spawnSync(process.execPath,
    [new URL('./run-migration.mjs', import.meta.url).pathname, mode], {
      env: { ...process.env, BUILD_ROLE: ` ${buildArn}\n`, MIGRATION_DEPLOY_ROLE_ARN: deployArn, ...changes },
      input: JSON.stringify(input), encoding: 'utf8',
    });
  for (const mode of ['check-build-role', 'check-deploy-role', 'verify-build-role']) {
    const good = cli(mode);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, '');
  }
  for (const changes of [
    { BUILD_ROLE: '' }, { BUILD_ROLE: `arn:aws:iam::${account}:user/BuildRole` },
    { MIGRATION_DEPLOY_ROLE_ARN: deployArn.replace(account, '999999999999') },
    { BUILD_ROLE: `${buildArn}/` }, { BUILD_ROLE: 'SECRET\nnot-an-arn' },
  ]) {
    const bad = cli('check-build-role', changes);
    assert.notEqual(bad.status, 0);
    assert.ok(!`${bad.stdout}${bad.stderr}`.includes('SECRET'));
  }
  const badCaller = cli('verify-build-role', {}, { ...caller,
    Arn: `arn:aws:sts::${account}:assumed-role/OtherRole/GitHubActions` });
  assert.notEqual(badCaller.status, 0);
  assert.ok(!badCaller.stderr.includes(account));
});

test('rejects missing or cross-stack Terraform output before registration', async () => {
  const mutations = [
    f => { f.config = null; },
    f => { f.config.project = 'prod'; },
    f => { f.config.region = 'us-east-1'; },
    f => { f.config.cluster = cluster.replace(project, 'prod'); },
    f => { f.config.task_template_arn = templateArn.replace(`${project}-migration`, `${project}-web`); },
    f => { f.config.repository_url = repo.replace(account, '999999999999'); },
    f => { f.config.subnets = []; },
    f => { f.config.security_groups = ['sg-invalid']; },
    f => { f.config.log_group = '/ecs/other'; },
  ];
  for (const mutate of mutations) {
    const h = harness();
    mutate(h.f);
    await assert.rejects(runMigration(h.f, h.deps));
    assert.equal(h.calls.some(c => c[1] === 'register-task-definition'), false);
  }
});

test('wrong caller or a replaced image tag never registers or launches a task', async () => {
  for (const override of [
    { 'get-caller-identity': () => ({ Account: '999999999999' }) },
    { 'batch-get-image': () => ({ images: [{ imageId: { imageDigest: `sha256:${'e'.repeat(64)}` } }] }) },
  ]) {
    const h = harness(fixture(), override);
    await assert.rejects(runMigration(h.f, h.deps));
    assert.equal(h.calls.some(c => c[1] === 'register-task-definition'), false);
  }
});

test('rejects privilege, command, secret, image and runtime changes in the template', async () => {
  const mutations = [
    t => { t.taskRoleArn = `arn:aws:iam::${account}:role/Admin`; },
    t => { t.executionRoleArn = t.executionRoleArn.replace(account, '999999999999'); },
    t => { t.taskDefinitionArn = cloneArn; },
    t => { t.runtimePlatform.cpuArchitecture = 'X86_64'; },
    t => { t.containerDefinitions.push(structuredClone(t.containerDefinitions[0])); },
    t => { t.volumes = [{ name: 'unexpected' }]; },
    t => { t.containerDefinitions[0].command = ['sh', '-c', 'evil']; },
    t => { t.containerDefinitions[0].entryPoint = ['evil']; },
    t => { t.containerDefinitions[0].privileged = true; },
    t => { t.containerDefinitions[0].secrets = [{ name: 'DB_PASSWORD', valueFrom: 'secret' }]; },
    t => { t.containerDefinitions[0].environmentFiles = [{ value: 's3://evil', type: 's3' }]; },
    t => { t.containerDefinitions[0].environment.push({ name: 'NODE_OPTIONS', value: '--require evil' }); },
    t => { t.containerDefinitions[0].environment[0].value = 'us-east-1'; },
    t => { t.containerDefinitions[0].environment[3].value = `arn:aws:secretsmanager:${region}:999999999999:secret:evil`; },
    t => { t.containerDefinitions[0].image = 'public.ecr.aws/evil'; },
    t => { t.containerDefinitions[0].logConfiguration.options['awslogs-group'] = '/ecs/other'; },
  ];
  for (const mutate of mutations) {
    const h = harness();
    mutate(h.f.template);
    await assert.rejects(runMigration(h.f, h.deps));
    assert.equal(h.calls.some(c => c[1] === 'register-task-definition'), false, mutate.toString());
  }
});

test('branch SHA is rechecked immediately before RunTask', async () => {
  const h = harness();
  h.deps.currentSha = async () => 'f'.repeat(40);
  await assert.rejects(runMigration(h.f, h.deps), /branch/i);
  assert.equal(h.calls.some(c => c[1] === 'run-task'), false);
});

test('STOPPED with zero still requires the exact build digest at runtime', async () => {
  for (const imageDigest of [undefined, `sha256:${'e'.repeat(64)}`]) {
    const h = harness(fixture(), { 'describe-tasks': () => ({ tasks: [
      task({ containers: [{ name: 'migration', lastStatus: 'STOPPED', exitCode: 0, imageDigest }] }),
    ] }) });
    await assert.rejects(runMigration(h.f, h.deps), /digest/i);
  }
});

for (const exitCode of [undefined, null, false, '', '0', 1, -1]) {
  test(`STOPPED requires actual numeric zero (reject ${JSON.stringify(exitCode)})`, async () => {
    const h = harness(fixture(), { 'describe-tasks': () => ({ tasks: [
      task({ containers: [{ name: 'migration', lastStatus: 'STOPPED', exitCode }] }),
    ] }) });
    await assert.rejects(runMigration(h.f, h.deps), /exit/i);
    assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
    assert.ok(h.calls.some(c => c[1] === 'get-log-events'));
    assert.ok(!h.messages.join('\n').includes('SECRET'));
    assert.ok(!h.messages.join('\n').includes('::warning::injected'));
  });
}

test('zero exit on a RUNNING task does not pass; timeout stops only the owned task', async () => {
  const h = harness(fixture(), { 'describe-tasks': () => ({ tasks: [task({ lastStatus: 'RUNNING' })] }) });
  await assert.rejects(runMigration(h.f, h.deps), /timeout/i);
  const stops = h.calls.filter(c => c[1] === 'stop-task');
  assert.equal(stops.length, 1);
  assert.equal(stops[0][2].task, taskArn);
  assert.ok(h.calls.filter(c => c[1] === 'describe-tasks').length < 20);
});

test('bounded polling tolerates ECS eventual consistency without treating a missing task as success', async () => {
  let reads = 0;
  const h = harness(fixture(), { 'describe-tasks': () => ++reads === 1
    ? { tasks: [], failures: [{ arn: taskArn, reason: 'MISSING' }] }
    : { tasks: [task()] },
  });
  const result = await runMigration(h.f, h.deps);
  assert.equal(result.exitCode, 0);
  assert.equal(reads, 2);
  assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
});

test('transient status reads recover without stopping or relaunching a healthy migration', async () => {
  let reads = 0;
  const h = harness(fixture(), { 'describe-tasks': () => {
    if (++reads <= 2) throw new Error('throttle/timeout SECRET');
    return { tasks: [task()] };
  } });
  assert.equal((await runMigration(h.f, h.deps)).exitCode, 0);
  assert.equal(reads, 3);
  assert.equal(h.calls.filter(c => c[1] === 'run-task').length, 1);
  assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
});

test('persistent status failures exhaust a finite read budget without authorizing StopTask', async () => {
  const h = harness(fixture(), { 'describe-tasks': () => { throw new Error('timeout SECRET'); } });
  await assert.rejects(runMigration(h.f, h.deps));
  const reads = h.calls.filter(c => c[1] === 'describe-tasks').length;
  assert.ok(reads > 2 && reads <= 6, `bounded run and cleanup reads: ${reads}`);
  assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
});

test('read retries stop at the polling deadline and cancellation still cleans up', async () => {
  for (const cancel of [false, true]) {
    const abort = new AbortController();
    let reads = 0;
    const h = harness(fixture(), { 'describe-tasks': () => {
      if (++reads === 1) {
        if (cancel) abort.abort();
        else h.deps.sleep(30);
        throw new Error('timeout SECRET');
      }
      return { tasks: [task()] };
    } });
    h.deps.signal = abort.signal;
    await assert.rejects(runMigration(h.f, h.deps));
    assert.equal(reads, 2, 'only cleanup may read after cancellation/deadline');
    assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
  }
});

test('definitive empty launch failure persists no-launch state for the always cleanup step', async () => {
  const h = harness(fixture(), { 'run-task': () => ({ tasks: [], failures: [{ reason: 'capacity SECRET' }] }) });
  await assert.rejects(runMigration(h.f, h.deps), /launch/i);
  const before = h.calls.length;
  await cleanupMigration(h.record, h.f.context, h.deps);
  assert.equal(h.calls.length, before);
  assert.equal(h.deps.now(), 0);
  assert.equal(h.calls.some(c => ['list-tasks', 'stop-task'].includes(c[1])), false);
});

test('lost launch response discovers STOPPED tasks despite transient discovery and status failures', async () => {
  let lists = 0, reads = 0;
  const h = harness(fixture(), {
    'run-task': () => { throw new Error('lost response SECRET'); },
    'list-tasks': args => {
      if (++lists === 1) throw new Error('throttle SECRET');
      return { taskArns: args.desiredStatus === 'STOPPED' ? [taskArn] : [] };
    },
    'describe-tasks': () => {
      if (++reads === 1) throw new Error('timeout SECRET');
      return { tasks: [task()] };
    },
  });
  await assert.rejects(runMigration(h.f, h.deps), /launch/i);
  assert.equal(h.record.taskArn, taskArn);
  const listsByStatus = h.calls.filter(c => c[1] === 'list-tasks').map(c => c[2]);
  assert.ok(listsByStatus.some(args => args.startedBy === startedBy && !Object.hasOwn(args, 'desiredStatus')));
  assert.ok(listsByStatus.some(args => args.desiredStatus === 'STOPPED' && !Object.hasOwn(args, 'startedBy')));
  assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
  assert.ok(h.calls.some(c => c[1] === 'get-log-events'));
  assert.ok(!h.messages.some(m => /could not confirm/.test(m)));
});

test('cleanup deduplicates a task transitioning between discovery lists and rejects distinct tasks', async () => {
  for (const ambiguous of [false, true]) {
    const h = harness(fixture(), {
      'run-task': () => { throw new Error('lost response'); },
      'list-tasks': args => ({ taskArns: [ambiguous && args.desiredStatus === 'STOPPED'
        ? taskArn.replace('b'.repeat(32), 'c'.repeat(32)) : taskArn] }),
      'describe-tasks': args => ({ tasks: args.tasks.map(arn => task({ taskArn: arn })) }),
    });
    await assert.rejects(runMigration(h.f, h.deps), /launch/i);
    assert.equal(Boolean(h.record.taskArn), !ambiguous);
    assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
    assert.equal(h.messages.some(m => /could not confirm/.test(m)), ambiguous);
  }
});

test('STOPPED discovery pages past foreign tasks and filters by both startedBy and exact clone', async () => {
  const foreign = [
    task({ taskArn: `${prefix}task/${project}/${'c'.repeat(32)}`, startedBy: 'another-run' }),
    task({ taskArn: `${prefix}task/${project}/${'e'.repeat(32)}`, taskDefinitionArn: templateArn }),
  ];
  const tasks = new Map([...foreign, task()].map(t => [t.taskArn, t]));
  const h = harness(fixture(), {
    'run-task': () => { throw new Error('lost response'); },
    'list-tasks': args => {
      if (args.startedBy) return { taskArns: [] };
      assert.equal(args.cluster, cluster);
      assert.equal(args.desiredStatus, 'STOPPED');
      assert.equal(args.family, `${project}-migration`);
      return args.nextToken
        ? { taskArns: [taskArn], nextToken: null }
        : { taskArns: foreign.map(t => t.taskArn), nextToken: 'opaque-next-page' };
    },
    'describe-tasks': args => ({ tasks: args.tasks.map(arn => tasks.get(arn)) }),
  });
  await assert.rejects(runMigration(h.f, h.deps), /launch/i);
  assert.equal(h.record.taskArn, taskArn);
  assert.ok(h.calls.some(c => c[1] === 'list-tasks' && c[2].nextToken === 'opaque-next-page'));
  assert.ok(h.calls.some(c => c[1] === 'describe-tasks' && c[2].tasks.length === 2));
  assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
  assert.ok(!h.messages.some(m => /could not confirm/.test(m)));
});

test('foreign STOPPED tasks never get journaled, stopped or used for failure logs', async () => {
  for (const overrides of [{ startedBy: 'another-run' }, { taskDefinitionArn: templateArn }]) {
    const h = harness(fixture(), {
      'run-task': () => { throw new Error('lost response'); },
      'list-tasks': args => ({ taskArns: args.startedBy ? [] : [taskArn] }),
      'describe-tasks': () => ({ tasks: [task(overrides)] }),
    });
    await assert.rejects(runMigration(h.f, h.deps), /launch/i);
    assert.equal(h.record.taskArn, undefined);
    assert.equal(h.calls.some(c => ['stop-task', 'get-log-events'].includes(c[1])), false);
    assert.ok(h.deps.now() >= 30, 'foreign tasks are filtered and discovery continues until its deadline');
  }
});

test('discovery page limits, repeated tokens and unresolved pages fail closed before selecting a task', async () => {
  for (const mode of ['repeat', 'unbounded', 'invalid-token', 'missing-description']) {
    let pages = 0;
    const h = harness(fixture(), {
      'run-task': () => { throw new Error('lost response'); },
      'list-tasks': args => {
        if (args.startedBy) return { taskArns: [] };
        pages++;
        return { taskArns: [taskArn], nextToken: mode === 'invalid-token' ? 12
          : mode === 'missing-description' ? null : mode === 'repeat' ? 'same-token' : `page-${pages}` };
      },
      'describe-tasks': () => ({ tasks: mode === 'missing-description' ? [] : [task()] }),
    });
    await assert.rejects(runMigration(h.f, h.deps), /launch/i);
    assert.ok(pages > 0 && pages <= 5, `${mode} must stop within the page budget`);
    assert.equal(h.record.taskArn, undefined, 'partial discovery must not select even an owned task');
    assert.equal(h.calls.some(c => ['stop-task', 'get-log-events'].includes(c[1])), false);
    assert.ok(h.messages.some(m => /could not confirm/.test(m)));
  }
});

test('paginated discovery refuses two owned tasks even when they occur on different pages', async () => {
  const secondArn = taskArn.replace('b'.repeat(32), 'c'.repeat(32));
  const h = harness(fixture(), {
    'run-task': () => { throw new Error('lost response'); },
    'list-tasks': args => args.startedBy ? { taskArns: [] }
      : args.nextToken ? { taskArns: [secondArn] } : { taskArns: [taskArn], nextToken: 'second' },
    'describe-tasks': args => ({ tasks: args.tasks.map(arn => task({ taskArn: arn })) }),
  });
  await assert.rejects(runMigration(h.f, h.deps), /launch/i);
  assert.ok(h.calls.some(c => c[1] === 'list-tasks' && c[2].nextToken === 'second'));
  assert.equal(h.record.taskArn, undefined);
  assert.equal(h.calls.some(c => ['stop-task', 'get-log-events'].includes(c[1])), false);
  assert.ok(h.messages.some(m => /could not confirm/.test(m)));
});

test('transport failures never retry registration, launch or stop mutations', async () => {
  for (const operation of ['register-task-definition', 'run-task', 'stop-task']) {
    const h = harness(fixture(), {
      'run-task': () => ({ tasks: [task()], failures: [{ reason: 'partial launch' }] }),
      'describe-tasks': () => ({ tasks: [task({ lastStatus: 'RUNNING' })] }),
      [operation]: () => { throw new Error('lost mutation response SECRET'); },
    });
    await assert.rejects(runMigration(h.f, h.deps));
    assert.equal(h.calls.filter(c => c[1] === operation).length, 1, operation);
    assert.ok(!h.messages.join('\n').includes('SECRET'));
  }
});

test('partial launch failure still cleans its own returned task, preserving the launch error', async () => {
  let stopped = false;
  const h = harness(fixture(), {
    'run-task': () => ({ tasks: [task({ lastStatus: 'RUNNING' })], failures: [{ reason: 'SECRET' }] }),
    'describe-tasks': () => ({ tasks: [task({ lastStatus: stopped ? 'STOPPED' : 'RUNNING' })] }),
    'stop-task': () => { stopped = true; return {}; },
    'get-log-events': () => { throw new Error('SECRET access denied'); },
  });
  await assert.rejects(runMigration(h.f, h.deps), /launch/i);
  assert.equal(h.calls.filter(c => c[1] === 'stop-task').length, 1);
  assert.ok(!h.messages.join('\n').includes('SECRET'));
});

test('missing, unrelated and malformed task responses never authorize a stop', async () => {
  for (const response of [
    { tasks: [task({ startedBy: 'someone-else' })] },
    { tasks: [task({ taskArn: taskArn.replace('b'.repeat(32), 'c'.repeat(32)) })] },
    { tasks: [task({ taskDefinitionArn: templateArn })] },
    { tasks: [task({ clusterArn: cluster.replace(project, 'prod') })] },
    { tasks: [task({ lastStatus: undefined })] },
    { tasks: [] }, { failures: [{ reason: 'MISSING' }], tasks: [] },
  ]) {
    const h = harness(fixture(), { 'describe-tasks': () => response });
    await assert.rejects(runMigration(h.f, h.deps));
    assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
  }
});

test('cancellation is failure and invokes bounded ownership-checked cleanup', async () => {
  const abort = new AbortController();
  let stopped = false;
  const h = harness(fixture(), {
    'run-task': () => { abort.abort(); return { tasks: [task({ lastStatus: 'RUNNING' })] }; },
    'describe-tasks': () => ({ tasks: [task({ lastStatus: stopped ? 'STOPPED' : 'RUNNING' })] }),
    'stop-task': () => { stopped = true; return {}; },
  });
  h.deps.signal = abort.signal;
  await assert.rejects(runMigration(h.f, h.deps), /cancel/i);
  assert.equal(h.calls.filter(c => c[1] === 'stop-task').length, 1);
});

test('cancellation during the final status read cannot report success', async () => {
  const abort = new AbortController();
  const h = harness(fixture(), {
    'describe-tasks': () => { abort.abort(); return { tasks: [task()] }; },
  });
  h.deps.signal = abort.signal;
  await assert.rejects(runMigration(h.f, h.deps), /cancel/i);
  assert.equal(h.calls.some(c => c[1] === 'stop-task'), false);
});

test('lost RunTask response uses a saved run identity; cleanup cannot be redirected by a stale journal', async () => {
  const h = harness(fixture(), {
    'run-task': () => { throw new Error('transport lost response SECRET'); },
    'describe-tasks': () => ({ tasks: [task({ lastStatus: 'RUNNING' })] }),
  });
  await assert.rejects(runMigration(h.f, h.deps), /launch/i);
  assert.equal(h.record.startedBy, startedBy);
  assert.equal(h.record.taskArn, taskArn, 'Recovered ownership must survive process cancellation');
  assert.ok(h.calls.some(c => c[1] === 'list-tasks' && c[2].startedBy === startedBy));
  assert.equal(h.calls.filter(c => c[1] === 'stop-task').length, 1);
  const before = h.calls.length;
  await assert.rejects(cleanupMigration({ ...h.record, startedBy: 'migration-other' }, h.f.context, h.deps));
  assert.equal(h.calls.length, before);
});

test('cleanup is a no-op without this run journal; never enumerate the cluster', async () => {
  const h = harness();
  await cleanupMigration(null, h.f.context, h.deps);
  assert.equal(h.calls.length, 0);
});

async function checkFailureLogs(message, expected) {
  const h = harness(fixture(), {
    'run-task': () => ({ tasks: [task()], failures: [{ reason: 'launch failure' }] }),
    'get-log-events': () => ({ events: [{ message }] }),
  });
  await assert.rejects(runMigration(h.f, h.deps), /launch/i);
  assert.equal(h.messages.find(m => m.includes('categories:'))?.split('categories: ')[1], expected);
  assert.ok(!h.messages.join('\n').includes('SECRET'));
  assert.ok(!h.messages.join('\n').includes('::warning::'));
}

async function caughtDiagnostic(action) {
  let failure;
  try { await action(); } catch (error) { failure = error; }
  assert.ok(failure, 'runtime must reject the fixture');
  assert.doesNotMatch(failure.message, /SECRET|::warning::/);
  return failure.message;
}

// Only database transport is replaced. The runtime owns purposes, event
// handling, reader validation and connection cleanup before logs reach CI.
async function runtimeDiagnostic({ phase = 'connect', error,
  role = { rolsuper: false, rolreplication: false, rolbypassrls: false },
  secret = { username: 'awsops_sql_reader', password: 'SECRET' } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'migration-diagnostic-SECRET-'));
  class Client extends EventEmitter {
    async connect() { if (phase === 'connect') throw error; }
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('information_schema.columns')) {
        if (phase === 'connection-event') this.emit('error', error);
        return { rows: ['version', 'checksum'].map(column_name => ({ column_name, data_type: 'text' })) };
      }
      if (sql.includes('FROM pg_roles')) return { rows: role ? [role] : [] };
      if (sql.startsWith('ALTER ROLE')) throw error;
      return { rows: [] };
    }
    escapeLiteral(value) { return `'${value.replaceAll("'", "''")}'`; }
    async end() { if (phase === 'cleanup') throw error; }
  }
  try {
    if (phase === 'file') await symlink(join(directory, 'missing.sql'),
      join(directory, '01ARZ3NDEKTSV4RRFFQ69G5FAV_missing.sql'));
    return await caughtDiagnostic(() => migrateDatabase(new Client(), {
      migrationDir: directory, logger: { log() {} },
      env: phase === 'reader' ? { SQL_READER_SYNC_MODE: 'secret', SQL_READER_SECRET_ARN: 'reader' }
        : { SQL_READER_SYNC_MODE: 'disabled' },
      readSecret: async () => secret,
      terraformOutput: () => assert.fail('runtime must not invoke Terraform'),
    }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function credentialDiagnostic(error) {
  const env = Object.fromEntries(fixture().template.containerDefinitions[0].environment.map(v => [v.name, v.value]));
  return caughtDiagnostic(() => loadCredentials(env, {
    readSecret: arn => readJsonSecret(arn, { send: async () => { throw error; } }),
  }));
}

for (const [codes, category] of [
  ['NetworkingError TimeoutError RequestTimeout AbortError ECONNREFUSED ECONNRESET ENOTFOUND EAI_AGAIN ETIMEDOUT EPIPE', 'transport connectivity'],
  ['CERT_HAS_EXPIRED DEPTH_ZERO_SELF_SIGNED_CERT SELF_SIGNED_CERT_IN_CHAIN UNABLE_TO_VERIFY_LEAF_SIGNATURE UNABLE_TO_GET_ISSUER_CERT_LOCALLY ERR_TLS_CERT_ALTNAME_INVALID', 'transport TLS'],
]) for (const code of codes.split(' ')) {
  test(`failure logs do not blame Aurora for actual GetSecretValue transport failure: ${code}`, async () => {
    const message = await credentialDiagnostic(Object.assign(new Error('SECRET'), { code }));
    assert.match(message, /^Aurora master credentials: Migration credential read: Secrets Manager GetSecretValue read failed/);
    await checkFailureLogs(message, category);
  });
}

test('failure logs associate transport codes with their own runtime purpose across mixed events', async () => {
  const connection = await runtimeDiagnostic({ phase: 'connection-event', error: new Error('SECRET') });
  const credential = await credentialDiagnostic({ code: 'CERT_HAS_EXPIRED', message: 'SECRET' });
  await checkFailureLogs(`${connection}\n${credential}`, 'database connectivity, transport TLS');
});

for (const [codes, category] of [
  ['28P01 28000', 'database authentication'],
  ['42501', 'database permission'],
  ['55P03 40P01', 'database lock contention'],
  ['57014', 'database timeout'],
  ['08001 08006 57P01 57P03 ECONNREFUSED ECONNRESET ENOTFOUND EAI_AGAIN ETIMEDOUT EPIPE NetworkingError TimeoutError RequestTimeout AbortError', 'database connectivity'],
  ['CERT_HAS_EXPIRED DEPTH_ZERO_SELF_SIGNED_CERT SELF_SIGNED_CERT_IN_CHAIN UNABLE_TO_VERIFY_LEAF_SIGNATURE UNABLE_TO_GET_ISSUER_CERT_LOCALLY ERR_TLS_CERT_ALTNAME_INVALID', 'database TLS'],
  ['AccessDeniedException DecryptionFailure EncryptionFailure UnrecognizedClientException ExpiredTokenException InvalidSignatureException CredentialsProviderError TokenProviderError', 'AWS access/decryption'],
  ['ResourceNotFoundException', 'AWS missing resource'],
  ['ThrottlingException TooManyRequestsException', 'AWS throttling'],
  ['InternalServiceError InternalServiceErrorException InvalidParameterException InvalidRequestException', 'AWS service/request'],
  ['ENOENT EACCES EPERM EBUSY', 'filesystem'],
]) for (const code of codes.split(' ')) {
  test(`failure logs classify sanitized runtime metadata ${code}`, async () => {
    const error = Object.assign(new Error('password=SECRET ::warning::injected'), { code, name: code });
    const diagnostic = category.startsWith('AWS')
      ? await credentialDiagnostic(error)
      : await runtimeDiagnostic({ error });
    await checkFailureLogs(diagnostic, category);
  });
}

for (const [message, category] of [
  ['Concurrent migration is already running; retry after it finishes', 'migration lock'],
  ['Automatic migration blocked: file=fixture, reason=non-transactional-sql', 'automatic SQL policy'],
  ['Migration advisory lock returned an invalid result', 'invalid migration lock result'],
]) test(`failure logs classify ${category}`, async () => checkFailureLogs(message, category));

for (const [phase, purpose] of [
  ['connect', 'Connect to Aurora failed'],
  ['connection-event', 'Aurora connection error'],
  ['cleanup', 'Aurora connection cleanup failed'],
]) for (const code of [undefined, '57P01', '57P03']) {
  test(`failure logs classify actual ${phase}: ${code ?? 'codeless'}`, async () => {
    const message = await runtimeDiagnostic({ phase, error: Object.assign(new Error('SECRET'), { code }) });
    assert.equal(message, `${purpose}: ${code ? `SQLSTATE=${code}` : 'unclassified error'}`);
    await checkFailureLogs(message, 'database connectivity');
  });
}

test('failure logs do not guess codeless credential or reader-sync causes', async () => {
  await checkFailureLogs(await credentialDiagnostic(new Error('SECRET')),
    'unclassified (inspect the private log stream)');
  await checkFailureLogs(await runtimeDiagnostic({ phase: 'reader', error: new Error('SECRET') }),
    'unclassified (inspect the private log stream)');
});

for (const attribute of ['rolsuper', 'rolreplication', 'rolbypassrls']) {
  test(`failure logs classify actual reader elevation: ${attribute}`, async () => {
    // Elevation is checked even when password synchronization is disabled.
    await checkFailureLogs(await runtimeDiagnostic({ phase: 'validate', role: { [attribute]: true } }),
      'SQL-reader elevation');
  });
}
test('failure logs classify actual missing reader role', async () => {
  await checkFailureLogs(await runtimeDiagnostic({ phase: 'reader', role: null }), 'SQL-reader missing role');
});
test('failure logs classify actual malformed reader secret', async () => {
  await checkFailureLogs(await runtimeDiagnostic({ phase: 'reader', secret: {} }), 'secret configuration');
});

test('failure logs classify an actual migration asset read error without leaking its path', async () => {
  const message = await runtimeDiagnostic({ phase: 'file' });
  assert.equal(message, 'Prepare migrations failed: ENOENT');
  await checkFailureLogs(message, 'filesystem');
});

test('failure logs separate actual malformed-secret failures from initializer refusal', async () => {
  const env = Object.fromEntries(fixture().template.containerDefinitions[0].environment.map(v => [v.name, v.value]));
  for (const [action, category] of [
    [() => loadCredentials(env, { readSecret: async () => ({ username: 'awsops_admin', password: '' }) }), 'secret configuration'],
    [() => readJsonSecret('unused', { send: async () => ({ SecretString: 'SECRET invalid JSON' }) }), 'secret configuration'],
    [() => initializeEmptyDatabase({ query: async sql => ({ rows: [
      sql.includes('to_regclass') ? { ledger: null } : { occupied: true },
    ] }) }, '', ''), 'bootstrap refused nonempty database'],
  ]) {
    let failure;
    try { await action(); } catch (error) { failure = error; }
    assert.ok(failure, 'runtime must reject the fixture');
    await checkFailureLogs(failure.message, category);
  }
});

test('failure logs ignore audit text, notices and partial code matches', async () => {
  const forged = 'SQLSTATE=28P01, CERT_HAS_EXPIRED, Refusing initialization of a non-empty database without schema_migrations';
  for (const message of [
    databaseFailure('Reviewed SQL failed', { code: 'P0001', message: forged }, { migrationSql: true }).message,
    `  [db] notice (SQLSTATE=28P01) message="SECRET"`,
    'Connect to Aurora failed: SQLSTATE=28P01X, NOT_ACCESSDENIEDEXCEPTION, XECONNREFUSED',
  ]) await checkFailureLogs(message, 'unclassified (inspect the private log stream)');
});

test('failure logs retry ingestion and transport delays within a finite budget, retaining primary failure', async () => {
  for (const scenario of ['missing', 'empty', 'progress', 'unavailable', 'never-ingested']) {
    let reads = 0;
    const h = harness(fixture(), {
      'run-task': () => ({ tasks: [task()], failures: [{ reason: 'launch failure' }] }),
      'get-log-events': () => {
        reads++;
        if (scenario === 'unavailable' || (scenario === 'missing' && reads === 1)) throw new Error('SECRET no stream');
        return { events: reads < 3 || scenario === 'never-ingested'
          ? (scenario === 'progress' ? [{ message: 'pending (1): migration' }] : [])
          : [{ message: databaseFailure('Connect to Aurora failed', { code: '28P01' }).message }] };
      },
    });
    await assert.rejects(runMigration(h.f, h.deps), /launch/i);
    assert.equal(reads, 3);
    assert.ok(h.deps.now() > 0 && h.deps.now() <= 30);
    assert.match(h.messages.at(-1), scenario === 'unavailable' ? /unavailable/
      : scenario === 'never-ingested' ? /unclassified/ : /database authentication/);
    assert.ok(!h.messages.join('\n').includes('SECRET'));
  }
});

test('real CLI serializes only approved AWS operations; cancellation retains a usable ownership journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-cli-'));
  try {
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'fixture.json'), JSON.stringify({ ...fixture(), task: task() }));
    const fake = `#!${process.execPath}
const fs = require('node:fs');
const p = require('node:path');
const f = JSON.parse(fs.readFileSync(p.join(process.env.RUNNER_TEMP, 'fixture.json')));
const a = process.argv.slice(2);
if (p.basename(process.argv[1]) === 'gh') { console.log(f.context.sha); process.exit(0); }
const args = JSON.parse(a[a.indexOf('--cli-input-json')+1]);
fs.appendFileSync(p.join(process.env.RUNNER_TEMP,'calls'), JSON.stringify([a[0], a[1], args])+'\\n');
if (process.env.AWS_MAX_ATTEMPTS !== '1') throw new Error('Mutation retry safety violated');
let response;
const stopped = p.join(process.env.RUNNER_TEMP,'stopped');
const foreign = {...f.task, taskArn:f.task.taskArn.replace('b'.repeat(32),'c'.repeat(32)), startedBy:'another-run'};
switch(a[1]) {
case 'get-caller-identity':
 response = {Account:'123456789012',Arn:'arn:aws:sts::123456789012:assumed-role/sample-awsops-dev-ci-deployer/test'}; break;
case 'batch-get-image':
 response = {images:[{registryId:'123456789012',repositoryName:'awsops-v2-dev-web',
 imageId:{imageDigest:f.context.digest,imageTag:'migration-'+f.context.sha}}]}; break;
case 'describe-task-definition': response={taskDefinition:f.template}; break;
case 'register-task-definition': response={taskDefinition:{...args,taskDefinitionArn:f.task.taskDefinitionArn,status:'ACTIVE'}}; break;
case 'run-task':
 if (process.env.TEST_LOST_RESPONSE) process.exit(1);
 response={tasks:[{...f.task,lastStatus:'RUNNING'}]}; break;
case 'list-tasks':
 if (!a.includes('--no-paginate')) throw new Error('Controller must own pagination');
 if (args.startedBy && (args.desiredStatus || args.family)) throw new Error('Forbidden ListTasks filter combination');
 response=args.startedBy ? {taskArns:[]} : args.nextToken === 'opaque-page-two'
  ? {taskArns:[f.task.taskArn]} : {taskArns:[foreign.taskArn],nextToken:'opaque-page-two'}; break;
case 'describe-tasks':
 response={tasks:args.tasks.map(arn => arn === foreign.taskArn ? foreign :
  {...f.task,lastStatus:process.env.TEST_CANCEL && !fs.existsSync(stopped) ? 'RUNNING' : 'STOPPED'})}; break;
case 'stop-task': fs.writeFileSync(stopped,'yes'); response={task:f.task}; break;
case 'get-log-events': response={events:[{message:'Connect to Aurora failed: SQLSTATE=28P01'},
 {message:'password=SECRET ::error::injected'}]}; break;
default: throw new Error('Unexpected operation');
}
console.log(JSON.stringify(response));
`;
    for (const tool of ['aws', 'gh']) await writeFile(join(dir, 'bin', tool), fake, { mode: 0o755 });
    const env = {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: dir,
      GITHUB_REPOSITORY: 'aws-samples/sample-awsops', GITHUB_REF: 'refs/heads/dev',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: sha, GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1', MIGRATION_PROJECT: project, MIGRATION_DIGEST: digest,
      MIGRATION_DEPLOY_ROLE_ARN: fixture().context.deployRoleArn,
    };
    const args = [new URL('./run-migration.mjs', import.meta.url).pathname, 'run'];
    const result = spawnSync(process.execPath, args, {
      env, input: JSON.stringify(fixture().config), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /STOPPED.*exit code 0/);
    await assert.rejects(readFile(join(dir, 'migration-123-1.json')), { code: 'ENOENT' });
    await rm(join(dir, 'calls'));
    const child = spawn(process.execPath, args, { env: { ...env, TEST_CANCEL: '1' } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.stdin.end(JSON.stringify(fixture().config));
    try {
      let polling = false;
      for (let i = 0; i < 200; i++) {
        polling = (await readFile(join(dir, 'calls'), 'utf8').catch(() => '')).includes('describe-tasks');
        if (polling) break;
        await sleep(10);
      }
      assert.ok(polling, 'CLI must reach task polling');
      child.kill('SIGTERM');
      const end = await Promise.race([exited, sleep(3000).then(() => null)]);
      assert.equal(end?.code, 1, output);
      const journal = JSON.parse(await readFile(join(dir, 'migration-123-1.json'), 'utf8'));
      assert.equal(journal.taskArn, taskArn);
      const calls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
      const stops = calls.filter(c => c[1] === 'stop-task');
      assert.equal(stops.length, 1);
      assert.equal(stops[0][2].task, taskArn);
      assert.match(output, /categories: database authentication/);
      assert.ok(!output.includes('SECRET'));
      assert.ok(!output.includes('::error::injected'));
      const cleanup = spawnSync(process.execPath, [args[0], 'cleanup'], { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(cleanup.status, 0, cleanup.stderr);
      await assert.rejects(readFile(join(dir, 'migration-123-1.json')), { code: 'ENOENT' });
    } finally { child.kill('SIGKILL'); }
    await rm(join(dir, 'calls'));
    const lost = spawnSync(process.execPath, args, {
      env: { ...env, TEST_LOST_RESPONSE: '1' }, input: JSON.stringify(fixture().config),
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(lost.status, 1, lost.stderr);
    assert.match(lost.stderr, /launch failed or response was lost/);
    const recovered = JSON.parse(await readFile(join(dir, 'migration-123-1.json'), 'utf8'));
    assert.equal(recovered.taskArn, taskArn);
    const recoveryCalls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(recoveryCalls.some(c => c[1] === 'list-tasks' && c[2].nextToken === 'opaque-page-two'));
    assert.equal(recoveryCalls.some(c => c[1] === 'stop-task'), false);
    assert.match(lost.stdout, /categories: database authentication/);
    assert.ok(!`${lost.stdout}${lost.stderr}`.includes('SECRET'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
