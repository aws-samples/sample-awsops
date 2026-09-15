#!/usr/bin/env node
// Development collection release: bounded metadata checks, one owned dispatcher,
// then the existing authenticated application/worker proof. Never a DB-only gate.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { authenticatedSmoke, SmokeError } from '../authenticated-smoke.mjs';
import { smokeConnectionArgs } from '../deployment-smoke.mjs';
import { readSmokeCredentials, cleanupSmokeCredentials } from '../prepare-smoke-credentials.mjs';
import { readRuntimeSmokeConfig, validateRuntimeSmokeConfig, validateMemberTargets, runtimeSmokeDeadline } from '../runtime-smoke.mjs';

const execute = promisify(execFile);
const REGION = 'ap-northeast-2', REPO = 'aws-samples/sample-awsops';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
// Current owner-required membership; the source-AST test keeps this contract in sync.
export const REQUIRED_CATALOG_TYPES = Object.freeze([
  'ec2', 'lambda', 'rds', 'ebs_volume', 'vpc', 'subnet', 'security_group',
  'iam_role', 'iam_user', 'dynamodb', 'ecs_cluster', 'ecs_service', 'ecr',
  'cloudfront', 'alb', 'nlb', 'target_group', 'route53', 'ecs_task', 'elasticache',
  'opensearch', 'route_table', 'nat_gateway', 'internet_gateway', 'transit_gateway',
  'elasticache_replication_group', 'iam_policy', 'neptune_cluster', 'msk', 'waf',
  'waf_rule_group', 'waf_ip_set', 'cloudwatch_alarm', 'cloudtrail', 'apigatewayv2_api',
  'apigatewayv2_integration', 'apigatewayv2_route', 'ebs_snapshot', 's3',
  'opensearch_serverless', 'cloudfront_vpc_origin', 'alb_listener_rule', 's3_public_access',
]);
export const MIN_CATALOG_TYPES = REQUIRED_CATALOG_TYPES.length;
// Verified source membership, not an exemption granted by a collector response.
export const HOST_ONLY_SDK_TYPES = Object.freeze([
  's3', 'opensearch_serverless', 'cloudfront_vpc_origin', 'alb_listener_rule', 's3_public_access',
]);
const REACHABILITY_SCOPES = new Set(['enabled_scan_accounts', 'host_only', 'unmeasured']);
// Five 35s HTTP calls, an 80s probe and two 370s worker paths need 995s.
// The 15s collector and 50s final web rechecks bring this to 1060s; reserve 18m with 20s margin.
// This reserves only the single-pass proof; no extra pages, polls or retries are allocated.
// Extras require earlier calls to finish below their allowances, otherwise the gate fails.
const REQUIRED_PROOF_MS = 18 * 60_000;
const POST_WEB_RECHECK_MS = 50_000;
const VERBS = new Set(['sts get-caller-identity', 'ecr batch-get-image',
  'ecs describe-services', 'ecs describe-task-definition', 'ecs list-tasks', 'ecs describe-tasks',
  'lambda get-function-configuration', 'lambda invoke']);
export class ReleaseError extends Error {}
export function classifyAwsError(error) {
  if (error?.killed === true || error?.code === 'ETIMEDOUT'
      || /^(Read|Connect) timeout on endpoint URL:/m.test(error?.stderr || '')) return new ReleaseError('aws_timeout');
  const code = /An error occurred \((TooManyRequestsException|AccessDeniedException|AccessDenied)\)/.exec(error?.stderr || '')?.[1];
  return new ReleaseError(code === 'TooManyRequestsException' ? 'aws_throttled'
    : code ? 'aws_access_denied' : 'aws_request_failed');
}
const need = (condition, code) => { if (!condition) throw new ReleaseError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = value => value === undefined || (Array.isArray(value) && value.length === 0);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function awsChildEnvironment(env) {
  const keys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
  need(keys.every(key => typeof env[key] === 'string' && env[key].trim()), 'aws_credentials_required');
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    ...Object.fromEntries(keys.map(key => [key, env[key]])),
    AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', BOTO_CONFIG: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
    AWS_MAX_ATTEMPTS: '1', AWS_PAGER: '',
  };
}
function smokeFailure(error) {
  return new ReleaseError(error instanceof SmokeError
    ? error.message === 'Runtime smoke: host_registry' ? 'host_only_registry_required' : error.message
    : 'authenticated_runtime_proof_failed');
}
function json(text) {
  try { return JSON.parse(text); } catch { throw new ReleaseError('invalid_response'); }
}

export function validateContext(env) {
  const mode = env.RUNTIME_MODE;
  const inventoryPolicy = env.INVENTORY_POLICY ?? 'full';
  need(inventoryPolicy === 'full', 'invalid_inventory_policy');
  const workflow = `${REPO}/.github/workflows/`;
  need(env.TARGET === 'dev' && env.GITHUB_REPOSITORY === REPO && env.GITHUB_REF === 'refs/heads/dev' &&
    env.AWS_REGION === REGION && SHA.test(env.GITHUB_SHA || ''), 'invalid_dev_source');
  need(['prepare', 'collect'].includes(mode), 'invalid_runtime_mode');
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const web = env.GITHUB_WORKFLOW_REF === `${workflow}deploy-web.yml@refs/heads/dev`;
  const collection = env.GITHUB_WORKFLOW_REF === `${workflow}collect-runtime.yml@refs/heads/dev`;
  need((collection && manual) || (web && mode === 'collect' &&
    (manual || env.GITHUB_EVENT_NAME === 'push')), 'invalid_release_workflow');
  need(mode === 'prepare' ? !env.PIN_SHA : SHA.test(env.PIN_SHA || ''), 'expected_image_sha_required');
  const account = env.AWS_ACCOUNT_ID_DEV;
  need(typeof account === 'string' && /^[0-9]{12}$/.test(account), 'expected_account_required');
  const role = /^arn:aws:iam::([0-9]{12}):role\/((?:[\x21-\x7e]+\/)?)([A-Za-z0-9+=,.@_-]{1,64})$/
    .exec((env.CI_ROLE_ARN || '').trim());
  need(role && role[1] === account && role[2].length <= 511, 'configured_role_mismatch');
  return { mode, account, inventoryPolicy, promoting: web, roleName: role[3],
    imageTag: mode === 'prepare' ? 'web-latest' : `web-${env.PIN_SHA}` };
}

export function validateDeployment(value, context) {
  need(object(value) && value.schema_version === 1 && value.account_id === context.account &&
    value.region === REGION && typeof value.project === 'string' &&
    /^[a-z][a-z0-9-]{1,39}$/.test(value.project), 'deployment_identity_mismatch');
  const { project } = value;
  need(object(value.web) && value.web.cluster === project && value.web.service === `${project}-web` &&
    value.web.task_role_arn === `arn:aws:iam::${context.account}:role/${project}-task`,
  'web_deployment_mismatch');
  need(object(value.features) && ['inventory', 'agentcore', 'workers'].every(k =>
    typeof value.features[k] === 'boolean'), 'invalid_feature_state');
  try { validateMemberTargets(value.inventory?.verification_targets === undefined ? [] : value.inventory.verification_targets, context.account); }
  catch { throw new ReleaseError('inventory_deployment_mismatch'); }
  if (context.mode === 'collect') {
    need(['inventory', 'agentcore', 'workers'].every(k => value.features[k] === true), 'runtime_not_enabled');
    const config = value.inventory;
    need(object(config) && config.sync_function_name === `${project}-inv-sync` &&
      config.sync_function_arn === `arn:aws:lambda:${REGION}:${context.account}:function:${project}-inv-sync` &&
      typeof config.sync_code_sha256 === 'string' &&
      /^[A-Za-z0-9+/]{43}=$/.test(config.sync_code_sha256) &&
      Buffer.from(config.sync_code_sha256, 'base64').toString('base64') === config.sync_code_sha256,
    'inventory_deployment_mismatch');
    need(object(value.known) && /^[A-Z0-9]{5,32}$/.test(value.known.cloudfront_distribution_id || ''),
      'known_resource_required');
  }
  return value;
}

function privateDirectory(env) {
  readSmokeCredentials(env.SMOKE_CREDENTIAL_FILE); // Enforce the producer's path/mode contract.
  return dirname(env.SMOKE_CREDENTIAL_FILE);
}
function writePrivate(file, value) {
  const text = JSON.stringify(value);
  need(Buffer.byteLength(text) <= 16_384, 'configuration_too_large');
  writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
}
function readPrivate(file, directory) {
  need(typeof file === 'string' && resolve(file) === file && dirname(file) === directory,
    'invalid_private_path');
  let fd;
  try {
    need(lstatSync(directory).isDirectory() && (lstatSync(directory).mode & 0o777) === 0o700,
      'invalid_private_directory');
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    need(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.size <= 16_384, 'invalid_private_file');
    const buffer = Buffer.alloc(16_385);
    let length = 0, count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    need(length <= 16_384, 'private_response_too_large');
    return json(buffer.subarray(0, length).toString('utf8'));
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function captureDeployment(value, env = process.env) {
  const context = validateContext(env);
  validateDeployment(value, context);
  const file = join(privateDirectory(env), 'runtime-deployment.json');
  writePrivate(file, value);
  return file;
}

export function validateCatalog(value) {
  need(object(value) && Object.keys(value).sort().join(',') === 'status,types', 'invalid_collection_catalog');
  const types = value.types;
  need(value.status === 'catalog' && Array.isArray(types) && types.length >= MIN_CATALOG_TYPES && types.length <= 128 &&
    new Set(types).size === types.length && types.includes('cloudfront') &&
    REQUIRED_CATALOG_TYPES.every(type => types.includes(type)) &&
    types.every(t => typeof t === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(t)
      && !['all', 'catalog'].includes(t)), 'invalid_collection_catalog');
  return types;
}

async function command(name, args, options) {
  try {
    const { stdout } = await execute(name, args, {
      encoding: 'utf8', timeout: 150_000, maxBuffer: 8 * 1024 * 1024, ...options,
    });
    return stdout;
  } catch (error) {
    // Classify only AWS CLI's fixed exception field; never expose remote text.
    throw classifyAwsError(error);
  }
}

function verifyCaller(caller, context) {
  const prefix = `arn:aws:sts::${context.account}:assumed-role/${context.roleName}/`;
  need(caller?.Account === context.account && typeof caller.Arn === 'string' &&
    caller.Arn.startsWith(prefix) && /^[A-Za-z0-9+=,.@_-]{2,64}$/.test(caller.Arn.slice(prefix.length)),
  'actual_ci_caller_mismatch');
}

function imageDigests(response, deployment, context) {
  need(empty(response?.failures) && Array.isArray(response?.images) && response.images.length > 0,
    'expected_web_image_missing');
  const image = response.images[0];
  // Digest queries can return the same manifest once per tag. Validate every alias
  // before collapsing to one identity and hashing/parsing the canonical manifest.
  need(response.images.every(entry => object(entry) &&
    entry.registryId === context.account && entry.repositoryName === `${deployment.project}-web` &&
    (context.expectedWebDigest ? entry.imageId?.imageDigest === context.expectedWebDigest
      : entry.imageId?.imageTag === context.imageTag) && DIGEST.test(entry.imageId?.imageDigest || '') &&
    typeof entry.imageManifest === 'string' && entry.imageManifest.length <= 256_000 &&
    entry.imageId.imageDigest === image?.imageId?.imageDigest && entry.imageManifest === image?.imageManifest),
  'web_image_identity_mismatch');
  const digest = `sha256:${createHash('sha256').update(image.imageManifest).digest('hex')}`;
  need(digest === image.imageId.imageDigest, 'web_manifest_digest_mismatch');
  const manifest = json(image.imageManifest);
  need(manifest?.schemaVersion === 2, 'invalid_web_manifest');
  const allowed = new Set([digest]);
  if (['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']
    .includes(manifest.mediaType)) {
    need(Array.isArray(manifest.manifests) && manifest.manifests.length <= 8, 'invalid_web_index');
    const arm = manifest.manifests.filter(m => m?.platform?.architecture === 'arm64' && m.platform.os === 'linux');
    need(arm.length === 1 && DIGEST.test(arm[0].digest || ''), 'web_arm64_image_missing');
    allowed.add(arm[0].digest);
  } else {
    need(['application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json'].includes(manifest.mediaType) &&
      DIGEST.test(manifest.config?.digest || '') && Array.isArray(manifest.layers), 'invalid_web_manifest');
  }
  return allowed;
}

async function verifyWeb(aws, deployment, context, baseline) {
  const { web, project } = deployment;
  const prefix = `arn:aws:ecs:${REGION}:${context.account}:`;
  const cluster = `${prefix}cluster/${web.cluster}`;
  const check = (condition, code) => need(condition, baseline ? 'web_identity_changed' : code);
  let digests = baseline?.digests;
  if (!baseline) {
    const images = await aws(['ecr', 'batch-get-image', '--registry-id', context.account,
      '--repository-name', `${project}-web`, '--image-ids', context.expectedWebDigest
        ? `imageDigest=${context.expectedWebDigest}` : `imageTag=${context.imageTag}`]);
    digests = imageDigests(images, deployment, context);
  }
  const services = await aws(['ecs', 'describe-services', '--cluster', cluster, '--services', web.service]);
  check(empty(services.failures) && Array.isArray(services.services) && services.services.length === 1,
    'web_service_unavailable');
  const service = services.services[0];
  check(service.serviceName === web.service && service.clusterArn === cluster &&
    service.serviceArn === `${prefix}service/${project}/${web.service}` && service.status === 'ACTIVE' &&
    integer(service.desiredCount) && service.desiredCount >= 1 && service.desiredCount <= 100 &&
    service.runningCount === service.desiredCount && service.pendingCount === 0 &&
    Array.isArray(service.deployments) && service.deployments.length === 1 &&
    service.deployments[0].status === 'PRIMARY' && service.deployments[0].rolloutState === 'COMPLETED' &&
    service.deployments[0].taskDefinition === service.taskDefinition &&
    (context.mode !== 'collect' || (typeof service.deployments[0].id === 'string' &&
      service.deployments[0].id.trim().length > 0)) &&
    new RegExp(`^${prefix}task-definition/${project}-web:[1-9][0-9]*$`).test(service.taskDefinition || ''),
  'web_service_not_stable');
  check(!baseline || (service.taskDefinition === baseline.taskDefinition &&
    service.deployments[0].id === baseline.deploymentId && service.desiredCount === baseline.count),
  'web_identity_changed');
  // Reuse the immutable task-definition proof and initial ECR digest set on the final read.
  if (!baseline) {
    const definition = (await aws(['ecs', 'describe-task-definition', '--task-definition', service.taskDefinition])).taskDefinition;
    const containers = definition?.containerDefinitions;
    need(definition?.taskDefinitionArn === service.taskDefinition && definition.taskRoleArn === web.task_role_arn &&
      definition.runtimePlatform?.cpuArchitecture === 'ARM64' &&
      definition.runtimePlatform.operatingSystemFamily === 'LINUX' && Array.isArray(containers),
    'web_task_definition_mismatch');
    const webContainers = containers.filter(c => c.name === 'web');
    const repository = `${context.account}.dkr.ecr.${REGION}.amazonaws.com/${project}-web`;
    need(webContainers.length === 1 && webContainers[0].essential === true &&
      ([`${repository}:web-latest`, `${repository}:${context.imageTag}`].includes(webContainers[0].image) ||
        [...digests].some(d => webContainers[0].image === `${repository}@${d}`)), 'web_container_mismatch');
  }
  const listed = await aws(['ecs', 'list-tasks', '--cli-input-json', JSON.stringify({
    cluster, serviceName: web.service, desiredStatus: 'RUNNING', maxResults: 100,
  }), '--no-paginate']);
  const arns = listed.taskArns;
  check(!listed.nextToken && Array.isArray(arns) && arns.length === service.desiredCount &&
    new Set(arns).size === arns.length && arns.every(a => typeof a === 'string' &&
      new RegExp(`^${prefix}task/${project}/[a-f0-9]{32}$`).test(a)), 'web_task_list_incomplete');
  const running = await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...arns]);
  check(empty(running.failures) && Array.isArray(running.tasks) && running.tasks.length === arns.length &&
    new Set(running.tasks.map(t => t.taskArn)).size === arns.length, 'web_tasks_unavailable');
  for (const task of running.tasks) {
    const taskWeb = Array.isArray(task.containers) ? task.containers.filter(c => c.name === 'web') : [];
    check(arns.includes(task.taskArn) && task.clusterArn === cluster &&
      task.group === `service:${deployment.web.service}` && task.taskDefinitionArn === service.taskDefinition &&
      task.lastStatus === 'RUNNING' && task.desiredStatus === 'RUNNING' && task.healthStatus === 'HEALTHY' &&
      task.platformFamily === 'Linux' && taskWeb.length === 1 && taskWeb[0].lastStatus === 'RUNNING' &&
      taskWeb[0].healthStatus === 'HEALTHY' && digests.has(taskWeb[0].imageDigest), 'running_web_mismatch');
  }
  return { count: running.tasks.length, taskDefinition: service.taskDefinition,
    deploymentId: service.deployments[0].id, digests };
}

export async function release(deployment, {
  env = process.env, run = command, authenticate = authenticatedSmoke, now = Date.now, wait = delay,
} = {}) {
  let failed = false;
  let collectionAttempts;
  const rawNow = now;
  let deadline = now() + 50 * 60_000;
  try {
    const context = validateContext(env);
    context.expectedWebDigest = env.EXPECTED_WEB_DIGEST || undefined;
    need(!context.promoting || context.expectedWebDigest, 'expected_web_digest_required');
    need(!context.expectedWebDigest || DIGEST.test(context.expectedWebDigest), 'invalid_expected_web_digest');
    validateDeployment(deployment, context);
    try { smokeConnectionArgs(env.PUBLIC_URL, env.CLOUDFRONT_DOMAIN); }
    catch { throw new ReleaseError('invalid_application_target'); }
    const directory = privateDirectory(env);
    const aws = async (args, outputFile, timeout = 150_000) => {
      need(VERBS.has(args.slice(0, 2).join(' ')), 'forbidden_aws_operation');
      need(deadline - now() >= 15_000, 'release_timeout');
      timeout = Math.min(timeout, deadline - now());
      const commandArgs = [...args, '--region', REGION, '--output', 'json', '--no-cli-pager',
        '--cli-connect-timeout', '5', '--cli-read-timeout',
        String(Math.min(timeout >= 450_000 ? 440 : 120, Math.floor((timeout - 10_000) / 1000)))];
      if (outputFile) commandArgs.push(outputFile);
      let raw;
      try {
        raw = await run('aws', commandArgs, {
          env: awsChildEnvironment(env), timeout,
        });
      } finally { need(now() < deadline, 'release_timeout'); }
      return json(raw);
    };
    verifyCaller(await aws(['sts', 'get-caller-identity']), context);
    const webIdentity = await verifyWeb(aws, deployment, context);
    const targets = deployment.inventory?.verification_targets === undefined ? [] : deployment.inventory.verification_targets;
    const scope = targets.length ? { expectedMemberTargets: targets } : { hostOnly: true };
    let config = { schemaVersion: 1, mode: 'prepare', ...scope, expectedAccountId: context.account };
    if (context.mode === 'collect') {
      const expected = deployment.inventory;
      const lambdaConfig = await aws(['lambda', 'get-function-configuration', '--function-name', expected.sync_function_arn]);
      need(lambdaConfig.FunctionName === expected.sync_function_name && lambdaConfig.FunctionArn === expected.sync_function_arn &&
        lambdaConfig.CodeSha256 === expected.sync_code_sha256 && lambdaConfig.State === 'Active' &&
        typeof lambdaConfig.RevisionId === 'string' && lambdaConfig.RevisionId.trim().length > 0 &&
        lambdaConfig.LastUpdateStatus === 'Successful' && Array.isArray(lambdaConfig.Architectures) &&
        lambdaConfig.Architectures.length === 1 && lambdaConfig.Architectures[0] === 'arm64' &&
        Number.isInteger(lambdaConfig.Timeout) && lambdaConfig.Timeout > 0 && lambdaConfig.Timeout <= 420,
      'inventory_code_mismatch');
      let files = 0;
      const invoke = async (type, budget, state) => {
        const end = Math.min(deadline, now() + budget);
        let last = 'timeout';
        for (;;) {
          need(now() < deadline, 'release_timeout');
          const remaining = end - now();
          if (state && remaining < 450_000) state.status = 'deadline';
          need(remaining >= (type === 'catalog' ? 15_000 : 450_000), `collection_probe_${last}`);
          const output = join(directory, `collection-probe-${++files}.json`);
          writePrivate(output, {});
          let response;
          try {
            if (state) { state.attempts++; state.last_outcome = 'running'; }
            response = await aws(['lambda', 'invoke', '--function-name', deployment.inventory.sync_function_arn,
              '--invocation-type', 'RequestResponse', '--cli-binary-format', 'raw-in-base64-out',
              '--payload', JSON.stringify({ type })], output, Math.min(type === 'catalog' ? 150_000 : 450_000, remaining));
          } catch (error) {
            if (error instanceof ReleaseError && error.message === 'release_timeout') throw error;
            if (!(error instanceof ReleaseError) || error.message !== 'aws_throttled')
              throw new ReleaseError(error instanceof ReleaseError && error.message === 'aws_access_denied'
                ? 'collection_probe_denied' : error?.message === 'aws_timeout' ? 'collection_probe_timeout' : 'collection_probe_failed');
            last = 'throttled';
            if (state) state.last_outcome = last;
            await wait(10_000);
            continue;
          }
          need(response.StatusCode === 200 && !Object.hasOwn(response, 'FunctionError') &&
            response.ExecutedVersion === '$LATEST', 'collection_probe_failed');
          const result = readPrivate(output, directory);
          if (type === 'catalog') return result;
          need(object(result) && result.type === type, 'collection_probe_protocol');
          if (state) for (const field of ['row_count', 'unknown_attribute_count', 'unreachable_account_count'])
            state[field] = integer(result[field]) ? result[field] : null;
          if (state) state.account_reachability_scope = REACHABILITY_SCOPES.has(result.account_reachability_scope)
            ? result.account_reachability_scope : null;
          if (result.status === 'busy' || (result.status === 'failed' && result.error === 'inventory sync superseded')) {
            last = 'busy';
            if (state) state.last_outcome = result.status === 'busy' ? 'busy' : 'superseded';
            await wait(10_000);
            continue;
          }
          if (['failed', 'partial'].includes(result.status)) {
            if (state) state.status = result.status;
            throw new ReleaseError(`collection_${result.status}`);
          }
          need(result.status === 'succeeded', 'collection_probe_protocol');
          const hostOnlySdk = HOST_ONLY_SDK_TYPES.includes(type);
          const reachabilityValid = hostOnlySdk
            ? result.account_reachability_scope === 'host_only' && result.unreachable_account_count === null
            : result.account_reachability_scope === 'enabled_scan_accounts' && integer(result.unreachable_account_count);
          if (!integer(result.row_count) || !integer(result.unknown_attribute_count)
              || (targets.length && !reachabilityValid)) {
            if (state) state.status = 'unknown';
            throw new ReleaseError('collection_probe_incomplete');
          }
          if (result.unknown_attribute_count > 0
              || (targets.length && !hostOnlySdk && result.unreachable_account_count !== 0)) {
            if (state) state.status = 'unknown';
            throw new ReleaseError('inventory_incomplete');
          }
          if (state) state.status = state.last_outcome = 'succeeded';
          return result;
        }
      };
      const types = validateCatalog(await invoke('catalog', 450_000));
      const prepareStarted = now();
      const credentials = readSmokeCredentials(env.SMOKE_CREDENTIAL_FILE);
      let prepared;
      try {
        prepared = await authenticate({
          publicUrl: env.PUBLIC_URL, cloudfrontDomain: env.CLOUDFRONT_DOMAIN,
          email: credentials?.email, password: credentials?.password, runtimeConfig: config,
        }, { tempRoot: directory, includeDatabaseClock: true, now, deadline });
      } catch (error) {
        need(now() < deadline, 'release_timeout');
        throw smokeFailure(error);
      }
      const prepareFinished = now(), clock = prepared?.database_clock;
      need(prepareFinished < deadline, 'release_timeout');
      const databaseTime = Date.parse(clock?.server_time);
      need(prepared?.status === 'ok' && prepared.mode === 'prepare' &&
        Number.isSafeInteger(prepared.public_tables) && prepared.public_tables > 0 &&
        typeof clock?.server_time === 'string' && Number.isFinite(databaseTime) &&
        new Date(databaseTime).toISOString() === clock.server_time &&
        Number.isSafeInteger(clock.request_started_at_ms) && Number.isSafeInteger(clock.response_observed_at_ms) &&
        clock.request_started_at_ms >= prepareStarted && clock.response_observed_at_ms <= prepareFinished &&
        clock.response_observed_at_ms >= clock.request_started_at_ms &&
        clock.response_observed_at_ms - clock.request_started_at_ms <= 35_000,
      'database_clock_invalid');
      // Request-start anchoring includes response/host-proof time in the evidence budget.
      const offset = databaseTime - clock.request_started_at_ms;
      now = () => rawNow() + offset;
      deadline += offset;
      const collectionStartedAt = clock.server_time;
      config = { schemaVersion: 1, mode: 'verify', ...scope, expectedAccountId: context.account,
        expectedCloudfrontId: deployment.known.cloudfront_distribution_id,
        expectedQueuedTypes: types, collectionStartedAt, collectionMode: 'release',
        inventoryPolicy: context.inventoryPolicy };
      validateRuntimeSmokeConfig(config, now());
      // One bounded exact inventory proof per member; no member pagination.
      const collectionDeadline = runtimeSmokeDeadline(config, now(), deadline) - REQUIRED_PROOF_MS - targets.length * 35_000;
      const states = Object.fromEntries(types.map(type => [type, {
        status: 'not_started', attempts: 0, last_outcome: 'not_started',
        row_count: null, unknown_attribute_count: null, unreachable_account_count: null,
        account_reachability_scope: null,
      }]));
      let cursor = 0, firstFailure;
      await Promise.all(Array.from({ length: Math.min(4, types.length) }, async () => {
        while (!firstFailure && cursor < types.length) {
          const type = types[cursor++], state = states[type];
          try { await invoke(type, collectionDeadline - now(), state); }
          catch (error) {
            state.reason = error instanceof ReleaseError ? error.message : 'collection_probe_failed';
            if (state.status === 'not_started')
              state.status = state.reason === 'release_timeout' ? 'deadline' : 'failed';
            if (state.last_outcome === 'running') state.last_outcome = state.status;
            firstFailure ??= new ReleaseError(state.reason);
          }
        }
      }));
      collectionAttempts = { source: 'collector_rpc', types: states, counts: {
        expected: types.length,
        ...Object.fromEntries(['succeeded', 'partial', 'failed', 'unknown', 'deadline']
          .map(status => [status, types.filter(type => states[type].status === status).length])),
        not_started: types.filter(type => states[type].status === 'not_started').length,
      } };
      if (firstFailure) {
        firstFailure.collection_attempts = collectionAttempts;
        firstFailure.inventory_quality = { status: 'not_verified', catalog_types: types, counts: null, types: null };
        throw firstFailure;
      }
      const collectedConfig = await aws(['lambda', 'get-function-configuration',
        '--function-name', expected.sync_function_arn], undefined, 15_000);
      need(collectedConfig.FunctionName === expected.sync_function_name &&
        collectedConfig.FunctionArn === expected.sync_function_arn &&
        collectedConfig.CodeSha256 === lambdaConfig.CodeSha256 &&
        collectedConfig.RevisionId === lambdaConfig.RevisionId &&
        collectedConfig.State === 'Active' && collectedConfig.LastUpdateStatus === 'Successful',
      'inventory_code_mismatch');
    }
    validateRuntimeSmokeConfig(config, now());
    const verificationDeadline = runtimeSmokeDeadline(config, now(), deadline);
    const authDeadline = verificationDeadline - (config.mode === 'verify' ? POST_WEB_RECHECK_MS : 0);
    need(now() < authDeadline, 'release_timeout');
    const configFile = join(directory, 'runtime-smoke.json');
    writePrivate(configFile, config);
    const credentials = readSmokeCredentials(env.SMOKE_CREDENTIAL_FILE);
    let result;
    try {
      result = await authenticate({
        publicUrl: env.PUBLIC_URL, cloudfrontDomain: env.CLOUDFRONT_DOMAIN,
        email: credentials?.email, password: credentials?.password,
        runtimeConfig: readRuntimeSmokeConfig(configFile, env.SMOKE_CREDENTIAL_FILE, now()),
      }, { tempRoot: directory, now, deadline: authDeadline });
    } catch (error) {
      need(now() < authDeadline, 'release_timeout');
      const failure = smokeFailure(error);
      if (error instanceof SmokeError) failure.inventory_quality = error.inventory_quality;
      failure.collection_attempts = collectionAttempts;
      throw failure;
    }
    need(now() < authDeadline, 'release_timeout');
    need(result?.status === 'ok' && result.mode === config.mode, 'runtime_proof_required');
    // Authenticate performs the actual checks; reject incomplete adapter results as well.
    if (config.mode === 'verify') {
      need(!targets.length || result.member_targets_verified === targets.length, 'complete_runtime_proof_required');
      const quality = result.inventory_quality, verified = quality?.types?.verified;
      need(result.inventory_policy === config.inventoryPolicy &&
        Array.isArray(quality?.catalog_types) && quality.catalog_types.join(',') === config.expectedQueuedTypes.join(',') &&
        quality.counts?.expected === config.expectedQueuedTypes.length &&
        quality.counts.verified === config.expectedQueuedTypes.length &&
        Array.isArray(verified) && verified.length === config.expectedQueuedTypes.length &&
        new Set(verified).size === verified.length && config.expectedQueuedTypes.every(type => verified.includes(type)) &&
        ['partial', 'failed', 'stale', 'missing', 'unknown', 'pending', 'invalid'].every(key =>
          quality.counts[key] === 0 && Array.isArray(quality.types?.[key]) && quality.types[key].length === 0) &&
        quality.status === 'complete' && result.workers === 2, 'complete_runtime_proof_required');
      const recheckDeadline = Math.min(verificationDeadline, now() + POST_WEB_RECHECK_MS);
      await verifyWeb(async args => {
        need(recheckDeadline - now() >= 15_000, 'web_recheck_timeout');
        const started = now();
        let response;
        try { response = await aws(args, undefined, 15_000); }
        catch (error) {
          need(now() < recheckDeadline && now() - started < 15_000 &&
            !(error instanceof ReleaseError && ['aws_timeout', 'release_timeout'].includes(error.message)),
          'web_recheck_timeout');
          throw error;
        }
        need(now() < recheckDeadline && now() - started < 15_000, 'web_recheck_timeout');
        return response;
      }, deployment, context, webIdentity);
      need(now() < recheckDeadline, 'web_recheck_timeout');
    }
    return config.mode === 'verify'
      ? { status: 'full_verified', mode: 'verify',
        inventory_policy: config.inventoryPolicy, inventory_quality: result.inventory_quality,
        collection_attempts: collectionAttempts, web_tasks: webIdentity.count, workers: 2, remaining_prerequisites: 'not_assessed' }
      : { status: 'prepared', mode: 'prepare', web_tasks: webIdentity.count };
  } catch (error) {
    failed = true;
    const failure = error instanceof ReleaseError ? error : new ReleaseError('runtime_release_failed');
    if (collectionAttempts) failure.collection_attempts = collectionAttempts;
    throw failure;
  } finally {
    try { cleanupSmokeCredentials(env.SMOKE_CREDENTIAL_FILE); }
    catch { if (!failed) throw new ReleaseError('private_cleanup_failed'); }
  }
}

async function main() {
  const mode = process.argv[2];
  need(process.argv.length === 3 && ['capture', 'run'].includes(mode), 'invalid_command');
  if (mode === 'capture') {
    need(Boolean(process.env.GITHUB_OUTPUT), 'output_path_required');
    const input = Buffer.alloc(16_385);
    let length = 0, count;
    while (length < input.length && (count = readSync(0, input, length, input.length - length, null)) > 0) length += count;
    need(length <= 16_384, 'deployment_input_too_large');
    const file = captureDeployment(json(input.subarray(0, length).toString('utf8')));
    appendFileSync(process.env.GITHUB_OUTPUT, `deployment_file=${file}\n`);
    console.log('Runtime deployment contract captured.');
  } else {
    validateContext(process.env);
    const deployment = readPrivate(process.env.RUNTIME_DEPLOYMENT_FILE, privateDirectory(process.env));
    console.log(JSON.stringify(await release(deployment)));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) {
    // Run preflight can fail before release() owns cleanup; capture must retain its files.
    if (process.argv[2] === 'run') {
      try { cleanupSmokeCredentials(process.env.SMOKE_CREDENTIAL_FILE); }
      catch { /* Preserve the primary diagnostic when cleanup refuses or fails. */ }
    }
    console.error(`Runtime release: ${error instanceof ReleaseError ? error.message : 'failed'}`);
    if (error instanceof ReleaseError && error.inventory_quality)
      console.error(JSON.stringify({ status: 'not_verified', inventory_quality: error.inventory_quality }));
    if (error instanceof ReleaseError && error.collection_attempts)
      console.error(JSON.stringify({ status: 'not_verified', collection_attempts: error.collection_attempts }));
    process.exitCode = 1;
  }
}
