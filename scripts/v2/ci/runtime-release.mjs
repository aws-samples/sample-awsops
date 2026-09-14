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
import { readRuntimeSmokeConfig, validateRuntimeSmokeConfig } from '../runtime-smoke.mjs';

const execute = promisify(execFile);
const REGION = 'ap-northeast-2', REPO = 'aws-samples/sample-awsops';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const VERBS = new Set(['sts get-caller-identity', 'ecr batch-get-image',
  'ecs describe-services', 'ecs describe-task-definition', 'ecs list-tasks', 'ecs describe-tasks',
  'lambda get-function-configuration', 'lambda invoke']);
export class ReleaseError extends Error {}
export function classifyAwsError(error) {
  const code = /An error occurred \((TooManyRequestsException|AccessDeniedException|AccessDenied)\)/.exec(error?.stderr || '')?.[1];
  return new ReleaseError(code === 'TooManyRequestsException' ? 'aws_throttled'
    : code ? 'aws_access_denied' : 'aws_request_failed');
}
const need = (condition, code) => { if (!condition) throw new ReleaseError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = value => value === undefined || (Array.isArray(value) && value.length === 0);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function json(text) {
  try { return JSON.parse(text); } catch { throw new ReleaseError('invalid_response'); }
}

export function validateContext(env) {
  const mode = env.RUNTIME_MODE;
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
  return { mode, account, roleName: role[3], imageTag: mode === 'prepare' ? 'web-latest' : `web-${env.PIN_SHA}` };
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
  need(value.status === 'catalog' && Array.isArray(types) && types.length >= 1 && types.length <= 128 &&
    new Set(types).size === types.length && types.includes('cloudfront') &&
    types.every(t => typeof t === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(t)), 'invalid_collection_catalog');
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
  need(empty(response?.failures) && Array.isArray(response?.images) && response.images.length === 1,
    'expected_web_image_missing');
  const image = response.images[0];
  need(image.registryId === context.account && image.repositoryName === `${deployment.project}-web` &&
    image.imageId?.imageTag === context.imageTag && DIGEST.test(image.imageId?.imageDigest || '') &&
    typeof image.imageManifest === 'string' && image.imageManifest.length <= 256_000, 'web_image_identity_mismatch');
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

async function verifyWeb(aws, deployment, context) {
  const { web, project } = deployment;
  const prefix = `arn:aws:ecs:${REGION}:${context.account}:`;
  const cluster = `${prefix}cluster/${web.cluster}`;
  const images = await aws(['ecr', 'batch-get-image', '--registry-id', context.account,
    '--repository-name', `${project}-web`, '--image-ids', `imageTag=${context.imageTag}`]);
  const digests = imageDigests(images, deployment, context);
  const services = await aws(['ecs', 'describe-services', '--cluster', cluster, '--services', web.service]);
  need(empty(services.failures) && Array.isArray(services.services) && services.services.length === 1,
    'web_service_unavailable');
  const service = services.services[0];
  need(service.serviceName === web.service && service.clusterArn === cluster &&
    service.serviceArn === `${prefix}service/${project}/${web.service}` && service.status === 'ACTIVE' &&
    integer(service.desiredCount) && service.desiredCount >= 1 && service.desiredCount <= 100 &&
    service.runningCount === service.desiredCount && service.pendingCount === 0 &&
    Array.isArray(service.deployments) && service.deployments.length === 1 &&
    service.deployments[0].status === 'PRIMARY' && service.deployments[0].rolloutState === 'COMPLETED' &&
    service.deployments[0].taskDefinition === service.taskDefinition &&
    new RegExp(`^${prefix}task-definition/${project}-web:[1-9][0-9]*$`).test(service.taskDefinition || ''),
  'web_service_not_stable');
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
  const listed = await aws(['ecs', 'list-tasks', '--cli-input-json', JSON.stringify({
    cluster, serviceName: web.service, desiredStatus: 'RUNNING', maxResults: 100,
  }), '--no-paginate']);
  const arns = listed.taskArns;
  need(!listed.nextToken && Array.isArray(arns) && arns.length === service.desiredCount &&
    new Set(arns).size === arns.length && arns.every(a => typeof a === 'string' &&
      new RegExp(`^${prefix}task/${project}/[a-f0-9]{32}$`).test(a)), 'web_task_list_incomplete');
  const running = await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...arns]);
  need(empty(running.failures) && Array.isArray(running.tasks) && running.tasks.length === arns.length &&
    new Set(running.tasks.map(t => t.taskArn)).size === arns.length, 'web_tasks_unavailable');
  for (const task of running.tasks) {
    const taskWeb = Array.isArray(task.containers) ? task.containers.filter(c => c.name === 'web') : [];
    need(arns.includes(task.taskArn) && task.clusterArn === cluster &&
      task.group === `service:${deployment.web.service}` && task.taskDefinitionArn === service.taskDefinition &&
      task.lastStatus === 'RUNNING' && task.desiredStatus === 'RUNNING' && task.healthStatus === 'HEALTHY' &&
      task.platformFamily === 'Linux' && taskWeb.length === 1 && taskWeb[0].lastStatus === 'RUNNING' &&
      taskWeb[0].healthStatus === 'HEALTHY' && digests.has(taskWeb[0].imageDigest), 'running_web_mismatch');
  }
  return running.tasks.length;
}

export async function release(deployment, {
  env = process.env, run = command, authenticate = authenticatedSmoke, now = Date.now, wait = delay,
} = {}) {
  let failed = false;
  try {
    const context = validateContext(env);
    validateDeployment(deployment, context);
    try { smokeConnectionArgs(env.PUBLIC_URL, env.CLOUDFRONT_DOMAIN); }
    catch { throw new ReleaseError('invalid_application_target'); }
    const directory = privateDirectory(env);
    const aws = async (args, outputFile, timeout = 150_000) => {
      need(VERBS.has(args.slice(0, 2).join(' ')), 'forbidden_aws_operation');
      const commandArgs = [...args, '--region', REGION, '--output', 'json', '--no-cli-pager',
        '--cli-connect-timeout', '5', '--cli-read-timeout',
        String(Math.min(timeout >= 450_000 ? 440 : 120, Math.floor((timeout - 10_000) / 1000)))];
      if (outputFile) commandArgs.push(outputFile);
      return json(await run('aws', commandArgs, {
        env: args[0] === 'lambda' && args[1] === 'invoke' ? { ...env, AWS_MAX_ATTEMPTS: '1' } : env, timeout,
      }));
    };
    verifyCaller(await aws(['sts', 'get-caller-identity']), context);
    const webTasks = await verifyWeb(aws, deployment, context);
    let config = { schemaVersion: 1, mode: 'prepare', hostOnly: true, expectedAccountId: context.account };
    if (context.mode === 'collect') {
      const expected = deployment.inventory;
      const lambdaConfig = await aws(['lambda', 'get-function-configuration', '--function-name', expected.sync_function_arn]);
      need(lambdaConfig.FunctionName === expected.sync_function_name && lambdaConfig.FunctionArn === expected.sync_function_arn &&
        lambdaConfig.CodeSha256 === expected.sync_code_sha256 && lambdaConfig.State === 'Active' &&
        lambdaConfig.LastUpdateStatus === 'Successful' && Array.isArray(lambdaConfig.Architectures) &&
        lambdaConfig.Architectures.length === 1 && lambdaConfig.Architectures[0] === 'arm64' &&
        Number.isInteger(lambdaConfig.Timeout) && lambdaConfig.Timeout > 0 && lambdaConfig.Timeout <= 420,
      'inventory_code_mismatch');
    }
    if (context.mode === 'collect') {
      let files = 0;
      const invoke = async (type, budget) => {
        const deadline = now() + budget;
        let last = 'throttled';
        for (;;) {
          const remaining = deadline - now();
          need(remaining >= (type === 'catalog' ? 15_000 : 450_000), `collection_probe_${last}`);
          const output = join(directory, `collection-probe-${++files}.json`);
          writePrivate(output, {});
          let response;
          try {
            response = await aws(['lambda', 'invoke', '--function-name', deployment.inventory.sync_function_arn,
              '--invocation-type', 'RequestResponse', '--cli-binary-format', 'raw-in-base64-out',
              '--payload', JSON.stringify({ type })], output, Math.min(type === 'catalog' ? 150_000 : 450_000, remaining));
          } catch (error) {
            if (!(error instanceof ReleaseError) || error.message !== 'aws_throttled')
              throw new ReleaseError(error instanceof ReleaseError && error.message === 'aws_access_denied'
                ? 'collection_probe_denied' : 'collection_probe_failed');
            last = 'throttled';
            await wait(10_000);
            continue;
          }
          need(response.StatusCode === 200 && !Object.hasOwn(response, 'FunctionError') &&
            response.ExecutedVersion === '$LATEST', 'collection_probe_failed');
          const result = readPrivate(output, directory);
          if (type === 'catalog') return result;
          need(result.type === type, 'collection_probe_protocol');
          if (result.status === 'busy' || (result.status === 'failed' && result.error === 'inventory sync superseded')) {
            last = 'busy';
            await wait(10_000);
            continue;
          }
          if (['failed', 'partial'].includes(result.status)) throw new ReleaseError(`collection_${result.status}`);
          need(result.status === 'succeeded', 'collection_probe_protocol');
          need(integer(result.row_count) && result.unknown_attribute_count === 0, 'collection_probe_incomplete');
          return result;
        }
      };
      const types = validateCatalog(await invoke('catalog', 450_000));
      const collectionStartedAt = new Date(now()).toISOString();
      await invoke('cloudfront', 900_000);
      config = { schemaVersion: 1, mode: 'verify', hostOnly: true, expectedAccountId: context.account,
        expectedCloudfrontId: deployment.known.cloudfront_distribution_id,
        expectedQueuedTypes: types, collectionStartedAt, collectionMode: 'release' };
    }
    validateRuntimeSmokeConfig(config, now());
    const configFile = join(directory, 'runtime-smoke.json');
    writePrivate(configFile, config);
    const credentials = readSmokeCredentials(env.SMOKE_CREDENTIAL_FILE);
    let result;
    try {
      result = await authenticate({
        publicUrl: env.PUBLIC_URL, cloudfrontDomain: env.CLOUDFRONT_DOMAIN,
        email: credentials?.email, password: credentials?.password,
        runtimeConfig: readRuntimeSmokeConfig(configFile, env.SMOKE_CREDENTIAL_FILE),
      }, { tempRoot: directory });
    } catch (error) {
      throw new ReleaseError(error instanceof SmokeError ? error.message : 'authenticated_runtime_proof_failed');
    }
    need(result?.status === 'ok' && result.mode === config.mode, 'full_runtime_proof_required');
    if (config.mode === 'verify') {
      need(result.catalog_types === config.expectedQueuedTypes.length && result.workers === 2,
        'complete_runtime_proof_required');
      const collection = result.collection;
      need(object(collection) && Object.keys(collection).sort().join(',') ===
        'completeness,degraded_types,freshness_minutes,status' &&
        collection.completeness === 'unknown' && collection.freshness_minutes === 30 &&
        Array.isArray(collection.degraded_types) &&
        collection.degraded_types.length <= config.expectedQueuedTypes.length &&
        collection.status === (collection.degraded_types.length ? 'degraded' : 'current') &&
        new Set(collection.degraded_types.map(row => row?.type)).size === collection.degraded_types.length &&
        collection.degraded_types.every(row => object(row) &&
          Object.keys(row).sort().join(',') === 'status,type,unknown_attributes' &&
          config.expectedQueuedTypes.includes(row.type) &&
          ['running', 'succeeded', 'partial', 'failed'].includes(row.status) &&
          (row.unknown_attributes === null || typeof row.unknown_attributes === 'boolean') &&
          (row.status !== 'succeeded' || row.unknown_attributes !== false)), 'collection_proof_required');
    }
    return config.mode === 'verify'
      ? { status: 'ready', mode: 'verify', catalog_types: result.catalog_types,
        collection: result.collection, web_tasks: webTasks }
      : { status: 'prepared', mode: 'prepare', web_tasks: webTasks };
  } catch (error) {
    failed = true;
    throw error instanceof ReleaseError ? error : new ReleaseError('runtime_release_failed');
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
    console.error(`Runtime release: ${error instanceof ReleaseError ? error.message : 'failed'}`);
    process.exitCode = 1;
  }
}
