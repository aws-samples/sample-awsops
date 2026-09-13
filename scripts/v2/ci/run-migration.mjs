#!/usr/bin/env node
// Development-only migration controller. AWS CLI calls are argv-only and bounded;
// raw CLI errors, task definitions, Terraform config and log messages never print.
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const REGION = 'ap-northeast-2';
const REPOSITORY = 'aws-samples/sample-awsops';
const DEPLOY_ROLE = 'sample-awsops-dev-ci-deployer';
const PROJECT = /^[a-z][a-z0-9-]{1,39}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const numericId = /^[1-9][0-9]{0,14}$/;
class MigrationError extends Error {}
const fail = message => { throw new MigrationError(message); };
const requireThat = (condition, message) => { if (!condition) fail(message); };
const same = isDeepStrictEqual;
const nonemptyArray = (a, max) => Array.isArray(a) && a.length > 0 && a.length <= max;
const hasFailures = response => (response?.failures?.length ?? 0) !== 0;
const allowedKeys = (obj, keys) => obj && Object.keys(obj).every(k => keys.includes(k));
const empty = value => value === undefined || (Array.isArray(value) && value.length === 0);

export function selectProject(text) {
  // Deliberately accept only literal, single-line assignments. The trusted dev
  // secret is never evaluated as shell or printed (even on malformed input).
  requireThat(typeof text === 'string' && !/\/\*|<<|\r/.test(text), 'Unsupported dev tfvars syntax');
  const assignments = text.split('\n').filter(line => /^\s*project\s*=/.test(line));
  requireThat(assignments.length === 1, 'Dev tfvars must contain one explicit project');
  const match = assignments[0].match(/^\s*project\s*=\s*"([a-z][a-z0-9-]{1,39})"\s*(?:#.*|\/\/.*)?$/);
  requireThat(match, 'Dev tfvars project must be a literal project name');
  const regions = text.split('\n').filter(line => /^\s*region\s*=/.test(line));
  requireThat(regions.length <= 1 && regions.every(line =>
    /^\s*region\s*=\s*"ap-northeast-2"\s*(?:#.*|\/\/.*)?$/.test(line)), 'Unexpected dev tfvars region');
  return match[1];
}

export function validateContext(c) {
  requireThat(c?.repository === REPOSITORY && c.ref === 'refs/heads/dev' &&
    c.event === 'workflow_dispatch', 'Only the samples repository dev dispatch is allowed');
  requireThat(SHA.test(c.sha) && PROJECT.test(c.project) && c.region === REGION &&
    numericId.test(c.runId) && numericId.test(c.attempt), 'Invalid migration run context');
  const role = c.deployRoleArn?.match(new RegExp(`^arn:aws:iam::([0-9]{12}):role/${DEPLOY_ROLE}$`));
  requireThat(role, 'Unexpected development deploy role');
  const account = role[1];
  const repositoryUrl = `${account}.dkr.ecr.${REGION}.amazonaws.com/${c.project}-web`;
  requireThat(DIGEST.test(c.digest) && c.image === `${repositoryUrl}@${c.digest}`,
    'Expected the immutable digest from this run build');
  requireThat(`migration-${c.runId}-${c.attempt}`.length <= 36, 'Migration run identity is too long');
  return {
    account, repositoryUrl, family: `${c.project}-migration`,
    cluster: `arn:aws:ecs:${REGION}:${account}:cluster/${c.project}`,
    arnPrefix: `arn:aws:ecs:${REGION}:${account}:`,
    startedBy: `migration-${c.runId}-${c.attempt}`,
    logGroup: `/ecs/${c.project}-migration`,
  };
}

function validateConfig(config, c, expected) {
  requireThat(config && allowedKeys(config, ['project', 'region', 'cluster', 'task_template_arn',
    'repository_url', 'subnets', 'security_groups', 'log_group']), 'Missing or invalid migration_job output');
  requireThat(config.project === c.project && config.region === REGION &&
    config.cluster === expected.cluster && config.repository_url === expected.repositoryUrl &&
    config.log_group === expected.logGroup, 'Migration output does not match the development stack');
  requireThat(isDefinition(config.task_template_arn, expected), 'Unexpected migration task template');
  requireThat(nonemptyArray(config.subnets, 16) &&
    config.subnets.every(s => /^subnet-[a-f0-9]{17}$/.test(s)) &&
    new Set(config.subnets).size === config.subnets.length &&
    config.security_groups?.length === 1 && /^sg-[a-f0-9]{17}$/.test(config.security_groups[0]),
  'Invalid migration private network');
}

function isDefinition(arn, e) {
  return typeof arn === 'string' &&
    new RegExp(`^${e.arnPrefix}task-definition/${e.family}:[1-9][0-9]*$`).test(arn);
}

function isTask(arn, e, project) {
  return typeof arn === 'string' &&
    new RegExp(`^${e.arnPrefix}task/${project}/[a-f0-9]{32}$`).test(arn);
}

function registration(t, config, c, e, expectedArn = config.task_template_arn, sourceImage = `${e.repositoryUrl}:migration-unbuilt`) {
  requireThat(t?.taskDefinitionArn === expectedArn && t.status === 'ACTIVE' &&
    t.family === e.family, 'Unexpected task definition identity');
  requireThat(t.taskRoleArn === `arn:aws:iam::${e.account}:role/${c.project}-migration-task` &&
    t.executionRoleArn === `arn:aws:iam::${e.account}:role/${c.project}-task-execution`,
  'Unexpected migration task or execution role');
  requireThat(t.networkMode === 'awsvpc' && same(t.requiresCompatibilities, ['FARGATE']) &&
    t.runtimePlatform?.cpuArchitecture === 'ARM64' && t.runtimePlatform?.operatingSystemFamily === 'LINUX' &&
    t.cpu === '256' && t.memory === '512' && empty(t.volumes) && !t.pidMode && !t.ipcMode &&
    !t.proxyConfiguration && !t.inferenceAccelerators?.length,
  'Unexpected migration task runtime');
  requireThat(t.containerDefinitions?.length === 1, 'Expected exactly one migration container');
  const container = t.containerDefinitions[0];
  requireThat(allowedKeys(container, ['name', 'image', 'essential', 'user', 'readonlyRootFilesystem',
    'stopTimeout', 'environment', 'logConfiguration', 'cpu', 'mountPoints', 'portMappings',
    'volumesFrom', 'systemControls', 'dependsOn']), 'Unsupported migration container field');
  requireThat(container.name === 'migration' && container.essential === true &&
    container.image === sourceImage && container.user === '1000:1000' &&
    container.readonlyRootFilesystem === true && container.stopTimeout === 30 &&
    empty(container.mountPoints) && empty(container.portMappings) && empty(container.volumesFrom) &&
    empty(container.systemControls) && empty(container.dependsOn) && (container.cpu ?? 0) === 0,
  'Unexpected migration container configuration');
  const names = ['AWS_REGION', 'AURORA_ENDPOINT', 'AURORA_DATABASE', 'AURORA_SECRET_ARN',
    'SQL_READER_SECRET_ARN', 'SQL_READER_SYNC_MODE', 'INITIALIZE_EMPTY_DB'];
  requireThat(Array.isArray(container.environment) && container.environment.length === names.length &&
    container.environment.every(v => allowedKeys(v, ['name', 'value']) &&
      names.includes(v.name) && typeof v.value === 'string') &&
    new Set(container.environment.map(v => v.name)).size === names.length,
  'Only the nonsecret migration environment is permitted');
  const env = Object.fromEntries(container.environment.map(v => [v.name, v.value]));
  const secretPrefix = `arn:aws:secretsmanager:${REGION}:${e.account}:secret:`;
  requireThat(env.AWS_REGION === REGION && env.AURORA_DATABASE === 'awsops' &&
    env.INITIALIZE_EMPTY_DB === '1' &&
    new RegExp(`^[a-z0-9-]+\\.cluster-[a-z0-9]+\\.${REGION}\\.rds\\.amazonaws\\.com$`).test(env.AURORA_ENDPOINT) &&
    new RegExp(`^${secretPrefix}rds!cluster-[a-zA-Z0-9-]+$`).test(env.AURORA_SECRET_ARN),
  'Invalid Aurora migration environment');
  requireThat((env.SQL_READER_SYNC_MODE === 'disabled' && env.SQL_READER_SECRET_ARN === '') ||
    (env.SQL_READER_SYNC_MODE === 'secret' &&
     new RegExp(`^${secretPrefix}ops/${c.project}/agent/sql-reader-[a-zA-Z0-9]{6}$`).test(env.SQL_READER_SECRET_ARN)),
  'Invalid SQL reader secret mode');
  requireThat(allowedKeys(container.logConfiguration, ['logDriver', 'options']) &&
    container.logConfiguration.logDriver === 'awslogs' &&
    same(container.logConfiguration.options, {
      'awslogs-group': e.logGroup, 'awslogs-region': REGION, 'awslogs-stream-prefix': 'migration',
    }), 'Unexpected migration log destination');
  // Explicit registration allowlist. ECS response metadata and optional runtime
  // features never get carried over from DescribeTaskDefinition.
  return {
    family: e.family, taskRoleArn: t.taskRoleArn, executionRoleArn: t.executionRoleArn,
    networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '512',
    runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
    containerDefinitions: [{
      name: 'migration', image: c.image, essential: true, user: '1000:1000',
      readonlyRootFilesystem: true, stopTimeout: 30, environment: container.environment,
      logConfiguration: container.logConfiguration,
    }],
  };
}

async function verifyCaller(c, e, deps) {
  const caller = await deps.aws('sts', 'get-caller-identity', {});
  requireThat(caller?.Account === e.account && typeof caller.Arn === 'string' &&
    caller.Arn.startsWith(`arn:aws:sts::${e.account}:assumed-role/${DEPLOY_ROLE}/`),
  'Unexpected AWS caller for development migration');
}

function ownedTask(t, r, e) {
  return t && isTask(t.taskArn, e, r.project) && (!r.taskArn || t.taskArn === r.taskArn) &&
    t.clusterArn === e.cluster && t.taskDefinitionArn === r.taskDefinitionArn &&
    t.startedBy === e.startedBy && t.launchType === 'FARGATE';
}

// Retry only read transports, never registration/launch/stop mutations. A read
// cannot extend the enclosing polling window or retry an ownership failure.
async function readAws(service, operation, args, deps, deadline, signal) {
  const { poll } = limits(deps);
  for (let attempt = 0; ; attempt++) {
    requireThat(!signal?.aborted, 'Migration cancelled');
    requireThat(deps.now() < deadline, 'Migration polling timeout');
    try { return await deps.aws(service, operation, args); }
    catch (error) {
      if (attempt === 2 || signal?.aborted || deps.now() + poll >= deadline) throw error;
      await deps.sleep(poll, signal);
    }
  }
}

async function describeOwned(r, e, deps, deadline, signal) {
  const response = await readAws('ecs', 'describe-tasks',
    { cluster: e.cluster, tasks: [r.taskArn] }, deps, deadline, signal);
  if (response?.tasks?.length === 0 &&
    (response.failures ?? []).every(f => f.reason === 'MISSING' && f.arn === r.taskArn)) return null;
  requireThat(!hasFailures(response) && response?.tasks?.length === 1 &&
    ownedTask(response.tasks[0], r, e), 'Could not verify migration task ownership/status');
  requireThat(['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING', 'DEACTIVATING',
    'STOPPING', 'DEPROVISIONING', 'STOPPED'].includes(response.tasks[0].lastStatus),
  'Invalid migration task status');
  return response.tasks[0];
}

function limits(deps) {
  const bound = (value, fallback, maximum) =>
    Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
  return {
    timeout: bound(deps.timeoutMs, 20 * 60_000, 20 * 60_000),
    cleanup: bound(deps.cleanupTimeoutMs, 2 * 60_000, 2 * 60_000),
    poll: bound(deps.pollMs, 10_000, 10_000),
  };
}

async function discoverTaskArn(record, e, deps, deadline) {
  const candidates = new Set();
  // ListTasks forbids combining startedBy with any other filter. Its default
  // desired status is RUNNING; STOPPED needs a separate family-scoped scan.
  for (const filter of [{ startedBy: e.startedBy }, { family: e.family, desiredStatus: 'STOPPED' }]) {
    let nextToken;
    const tokens = new Set();
    for (let page = 0; page < 5; page++) {
      const found = await readAws('ecs', 'list-tasks', {
        cluster: e.cluster, ...filter, maxResults: 100, ...(nextToken ? { nextToken } : {}),
      }, deps, deadline);
      requireThat(Array.isArray(found?.taskArns) && found.taskArns.length <= 100 &&
        found.taskArns.every(arn => isTask(arn, e, record.project)), 'Invalid migration cleanup discovery');
      const arns = [...new Set(found.taskArns)];
      if (arns.length) {
        const described = await readAws('ecs', 'describe-tasks',
          { cluster: e.cluster, tasks: arns }, deps, deadline);
        requireThat(Array.isArray(described?.tasks) && Array.isArray(described.failures ?? []) &&
          (described.failures ?? []).every(f => f?.reason === 'MISSING'),
        'Incomplete migration cleanup task descriptions');
        const returned = [...described.tasks.map(t => t?.taskArn), ...(described.failures ?? []).map(f => f.arn)];
        requireThat(returned.length === arns.length && new Set(returned).size === arns.length &&
          returned.every(arn => arns.includes(arn)), 'Incomplete migration cleanup task descriptions');
        // Other runs (including the same family or startedBy with another clone)
        // are normal discovery results, not ownership errors or stop targets.
        for (const t of described.tasks) if (ownedTask(t, record, e)) candidates.add(t.taskArn);
        requireThat(candidates.size <= 1, 'Ambiguous migration cleanup discovery');
      }
      nextToken = found.nextToken;
      if (nextToken == null) break;
      requireThat(typeof nextToken === 'string' && nextToken.length > 0 &&
        !tokens.has(nextToken) && page < 4, 'Incomplete migration cleanup pagination');
      tokens.add(nextToken);
    }
  }
  return [...candidates][0];
}

export async function cleanupMigration(record, context, deps) {
  if (!record) return;
  const e = validateContext(context);
  requireThat(record.project === context.project && record.sha === context.sha &&
    record.runId === context.runId && record.attempt === context.attempt &&
    record.startedBy === e.startedBy && record.cluster === e.cluster &&
    record.image === context.image && isDefinition(record.taskDefinitionArn, e) &&
    (!record.taskArn || isTask(record.taskArn, e, context.project)),
  'Cleanup journal does not belong to this migration run');
  if (!record.launchRequested) return;
  await verifyCaller(context, e, deps);
  const { cleanup, poll } = limits(deps);
  const deadline = deps.now() + cleanup;
  let stopped = false;
  // A lost RunTask response may leave only the prelaunch journal. Discovery
  // filters both running and stopped results by this run's identity and clone.
  while (deps.now() < deadline) {
    const candidateArn = record.taskArn ?? await discoverTaskArn(record, e, deps, deadline);
    if (!candidateArn) {
      await deps.sleep(poll);
      continue;
    }
    const current = await describeOwned({ ...record, taskArn: candidateArn }, e, deps, deadline);
    if (!current) {
      await deps.sleep(poll);
      continue;
    }
    if (!record.taskArn) {
      record.taskArn = candidateArn;
      await deps.save(record); // Preserve recovered, verified ownership for the always() step.
    }
    if (current.lastStatus === 'STOPPED') return;
    if (!stopped) {
      await deps.aws('ecs', 'stop-task', {
        cluster: e.cluster, task: record.taskArn, reason: 'Development migration run failed or was cancelled',
      });
      stopped = true;
      continue; // Observe an already-completed stop before sleeping.
    }
    await deps.sleep(poll);
  }
  fail('Migration cleanup timeout; verify this run task in ECS before retrying');
}

async function failureLogs(record, e, deps) {
  if (!record?.taskArn) return;
  let summary = 'Migration failure logs unavailable; primary failure retained';
  // CloudWatch may not have ingested the terminal error yet. Transport errors,
  // empty streams and progress-only logs share one finite three-read budget.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await deps.aws('logs', 'get-log-events', {
        logGroupName: e.logGroup, logStreamName: `migration/migration/${record.taskArn.split('/').at(-1)}`, limit: 50,
      });
      // Match migration-errors.mjs metadata, excluding notices and encoded SQL
      // audit text. Never echo raw application/SQL/log messages into Actions.
      const messages = (response.events ?? []).map(v => v.message).join('\n').split('\n')
        .filter(line => !/^\s*\[db\] notice /.test(line))
        .map(line => line.split('message=')[0].trimEnd()).join('\n');
      const codes = [...messages.matchAll(/(?:^|[:(,]\s*)([A-Za-z0-9_=]+)(?=[,)]|$)/gm)].map(m => m[1]);
      const has = pattern => codes.some(code => pattern.test(code));
      const categories = [
        [has(/^(SQLSTATE=08[0-9A-Z]{3}|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|NetworkingError|TimeoutError|RequestTimeout|AbortError)$/) ||
          /^Connect to Aurora failed: unclassified error$/m.test(messages), 'database connectivity'],
        [has(/^SQLSTATE=(28P01|28000)$/), 'database authentication'],
        [has(/^SQLSTATE=42501$/), 'database permission'],
        [has(/^SQLSTATE=(55P03|40P01)$/), 'migration lock'],
        [has(/^SQLSTATE=57014$/), 'database timeout'],
        [has(/^(CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|ERR_TLS_CERT_ALTNAME_INVALID)$/), 'database TLS'],
        [has(/^(AccessDeniedException|DecryptionFailure|EncryptionFailure|UnrecognizedClientException|ExpiredTokenException|InvalidSignatureException|CredentialsProviderError|TokenProviderError)$/), 'AWS access/decryption'],
        [/^(?:.*: )?(?:Aurora secret requires nonempty username and password strings|SQL-reader secret requires username awsops_sql_reader and a nonempty password string|Secret must contain a JSON object in SecretString)$/m.test(messages), 'secret configuration'],
        [/^checksum drift: applied (baseline|migration) /m.test(messages), 'migration checksum'],
        [/^Refusing initialization of a non-empty database without schema_migrations$/m.test(messages), 'bootstrap refused nonempty database'],
      ].filter(([matched]) => matched).map(([, label]) => label);
      summary = `Migration failure logs inspected; categories: ${categories.join(', ') || 'unclassified (inspect the private log stream)'}`;
      if (categories.length) break;
    } catch { /* Keep the primary failure and any already-inspected log summary. */ }
    if (attempt < 2) {
      try { await deps.sleep(limits(deps).poll); } catch { break; }
    }
  }
  deps.log(summary);
}

export async function runMigration({ context: c, config }, deps) {
  const e = validateContext(c);
  validateConfig(config, c, e);
  await verifyCaller(c, e, deps);
  const image = await deps.aws('ecr', 'batch-get-image', {
    registryId: e.account, repositoryName: `${c.project}-web`, imageIds: [{ imageTag: `migration-${c.sha}` }],
  });
  requireThat(!hasFailures(image) && image?.images?.length === 1 &&
    image.images[0].registryId === e.account && image.images[0].repositoryName === `${c.project}-web` &&
    image.images[0].imageId?.imageDigest === c.digest &&
    image.images[0].imageId?.imageTag === `migration-${c.sha}`,
  'ECR image does not match this build digest and commit tag');
  const template = await deps.aws('ecs', 'describe-task-definition', { taskDefinition: config.task_template_arn });
  const payload = registration(template.taskDefinition, config, c, e);
  requireThat(!deps.signal?.aborted, 'Migration cancelled');
  const registered = await deps.aws('ecs', 'register-task-definition', payload);
  const clone = registered?.taskDefinition;
  requireThat(isDefinition(clone?.taskDefinitionArn, e) &&
    clone.taskDefinitionArn !== config.task_template_arn && clone.status === 'ACTIVE',
  'Registered migration definition does not match the approved template and digest');
  requireThat(same(payload, registration(clone, config, c, e, clone.taskDefinitionArn, c.image)),
    'Registered migration definition changed the approved configuration');
  let record = {
    project: c.project, sha: c.sha, runId: c.runId, attempt: c.attempt, image: c.image,
    cluster: e.cluster, startedBy: e.startedBy, taskDefinitionArn: clone.taskDefinitionArn,
    launchRequested: false,
  };
  await deps.save(record);
  requireThat(await deps.currentSha() === c.sha, 'Development branch moved; dispatch the new HEAD');
  requireThat(!deps.signal?.aborted, 'Migration cancelled');
  record.launchRequested = true;
  // Atomic durable journal precedes RunTask, including ambiguous transport loss.
  await deps.save(record);
  try {
    let response;
    try {
      response = await deps.aws('ecs', 'run-task', {
        cluster: e.cluster, taskDefinition: clone.taskDefinitionArn,
        count: 1, launchType: 'FARGATE', platformVersion: '1.4.0', enableExecuteCommand: false,
        startedBy: e.startedBy, clientToken: e.startedBy,
        networkConfiguration: { awsvpcConfiguration: {
          subnets: config.subnets, securityGroups: config.security_groups, assignPublicIp: 'DISABLED',
        } },
      });
    } catch {
      fail('Migration launch failed or response was lost');
    }
    if (hasFailures(response) && Array.isArray(response.tasks) && response.tasks.length === 0) {
      record.launchRequested = false; // Definitive failure, not an ambiguous lost response.
      await deps.save(record);
    }
    if (response?.tasks?.length === 1 && ownedTask(response.tasks[0], record, e)) {
      record.taskArn = response.tasks[0].taskArn;
      await deps.save(record);
    }
    requireThat(!hasFailures(response) && response?.tasks?.length === 1 && record.taskArn,
      'Migration launch failed or returned unexpected tasks');
    const { timeout, poll } = limits(deps);
    const deadline = deps.now() + timeout;
    while (deps.now() < deadline) {
      requireThat(!deps.signal?.aborted, 'Migration cancelled');
      const current = await describeOwned(record, e, deps, deadline, deps.signal);
      requireThat(!deps.signal?.aborted, 'Migration cancelled');
      if (!current) {
        await deps.sleep(poll, deps.signal);
        continue;
      }
      if (current.lastStatus === 'STOPPED') {
        const containers = current.containers?.filter(v => v.name === 'migration');
        requireThat(containers?.length === 1 && containers[0].lastStatus === 'STOPPED' &&
          typeof containers[0].exitCode === 'number' && containers[0].exitCode === 0 &&
          current.stopCode !== 'TaskFailedToStart' && current.stopCode !== 'UserInitiated',
        'Migration container did not stop with numeric exit code zero');
        requireThat(containers[0].imageDigest === c.digest, 'Running migration image digest did not match this build');
        return { taskArn: record.taskArn, exitCode: 0 };
      }
      await deps.sleep(poll, deps.signal);
    }
    fail('Migration timeout');
  } catch (error) {
    try {
      await cleanupMigration(record, c, deps);
    } catch {
      deps.log('Migration cleanup could not confirm STOPPED; verify this run task before retrying');
    }
    await failureLogs(record, e, deps);
    throw error;
  }
}

async function command(binary, args) {
  try {
    return (await exec(binary, args, {
      timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1', GH_PROMPT_DISABLED: '1' },
    })).stdout;
  } catch {
    fail(`${binary} operation failed (output withheld)`);
  }
}

function contextFromEnv(env) {
  return {
    repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF, event: env.GITHUB_EVENT_NAME,
    sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
    project: env.MIGRATION_PROJECT, region: REGION, digest: env.MIGRATION_DIGEST,
    // Do not pass a masked registry/account in a GitHub job output. Derive the
    // expected registry from the fixed deploy role; validateContext checks it.
    image: `${env.MIGRATION_DEPLOY_ROLE_ARN?.split(':')[4]}.dkr.ecr.${REGION}.amazonaws.com/${env.MIGRATION_PROJECT}-web@${env.MIGRATION_DIGEST}`,
    deployRoleArn: env.MIGRATION_DEPLOY_ROLE_ARN,
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'project') {
    const text = await stdin();
    console.log(selectProject(text));
    return;
  }
  requireThat(['run', 'cleanup'].includes(mode), 'Expected run, cleanup or project');
  const c = contextFromEnv(process.env);
  validateContext(c);
  requireThat(process.env.RUNNER_TEMP?.startsWith('/'), 'Runner temporary directory is required');
  const journal = join(process.env.RUNNER_TEMP, `migration-${c.runId}-${c.attempt}.json`);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  const deps = {
    now: () => performance.now(), sleep: (ms, signal) => delay(ms, undefined, signal ? { signal } : {}),
    signal: abort.signal,
    log: message => console.log(message),
    save: async record => {
      await writeFile(`${journal}.tmp`, JSON.stringify(record), { mode: 0o600 });
      await rename(`${journal}.tmp`, journal);
    },
    currentSha: async () => (await command('gh', [
      'api', `repos/${REPOSITORY}/git/ref/heads/dev`, '--jq', '.object.sha',
    ])).trim(),
    aws: async (service, operation, args) => {
      const stdout = await command('aws', [service, operation, '--region', REGION,
        '--cli-input-json', JSON.stringify(args), '--output', 'json', '--no-cli-pager', '--no-paginate',
        '--cli-connect-timeout', '5', '--cli-read-timeout', '10']);
      try { return JSON.parse(stdout); } catch { fail('AWS returned invalid JSON (output withheld)'); }
    },
  };
  try {
    if (mode === 'cleanup') {
      let record;
      try { record = JSON.parse(await readFile(journal, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; fail('Invalid migration cleanup journal'); }
      await cleanupMigration(record, c, deps);
      await rm(journal, { force: true });
    } else {
      let config;
      try { config = JSON.parse(await stdin()); } catch { fail('Invalid migration_job output'); }
      await runMigration({ context: c, config }, deps);
      console.log('Migration task STOPPED with numeric exit code 0');
      await rm(journal, { force: true });
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await rm(`${journal}.tmp`, { force: true });
  }
}

async function stdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Errors can originate in parsers or transports; never print untrusted data.
    console.error(error instanceof MigrationError ? error.message :
      'Migration controller failed; inspect the fixed diagnostics and private task logs.');
    process.exitCode = 1;
  });
}
