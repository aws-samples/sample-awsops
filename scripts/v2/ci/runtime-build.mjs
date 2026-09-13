#!/usr/bin/env node
// Dev-only image transport. Infrastructure and repository creation belong to Terraform.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectProject } from './run-migration.mjs';

const REGION = 'ap-northeast-2';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export class RuntimeBuildError extends Error {}
function requireValue(ok, code) { if (!ok) throw new RuntimeBuildError(code); }

export function checkRole(env) {
  requireValue(env.GITHUB_REPOSITORY === 'aws-samples/sample-awsops' &&
    env.GITHUB_REF === 'refs/heads/dev' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    /^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '') && env.AWS_REGION === REGION, 'invalid_dev_context');
  requireValue(/^[0-9]{12}$/.test(env.AWS_ACCOUNT_ID_DEV || ''), 'expected_account_required');
  // Same role/path and assumed-role identity contract as run-migration.mjs.
  const arn = (env.RUNTIME_ROLE_ARN || '').trim();
  const role = /^arn:aws:iam::([0-9]{12}):role\/((?:[\x21-\x7e]+\/)?)([A-Za-z0-9+=,.@_-]{1,64})$/.exec(arn);
  requireValue(role && role[2].length <= 511 && role[1] === env.AWS_ACCOUNT_ID_DEV,
    'configured_role_account_mismatch');
  return { account: role[1], name: role[3], arn };
}

export function verifyCaller(env, caller) {
  const role = checkRole(env);
  const prefix = `arn:aws:sts::${role.account}:assumed-role/${role.name}/`;
  requireValue(caller?.Account === role.account && typeof caller.Arn === 'string' &&
    caller.Arn.startsWith(prefix) && /^[A-Za-z0-9+=,.@_-]{2,64}$/.test(caller.Arn.slice(prefix.length)),
  'actual_caller_mismatch');
}

export function imagePlan(env, project, component) {
  const { account } = checkRole(env);
  requireValue(/^[a-z][a-z0-9-]{1,39}$/.test(project || ''), 'invalid_project');
  requireValue(['steampipe', 'worker', 'agent'].includes(component), 'invalid_component');
  const repository = `${project}-${component === 'agent' ? 'agentcore' : component}`;
  const registry = `${account}.dkr.ecr.${REGION}.amazonaws.com`;
  return { account, project, component, repository, registry,
    uri: `${registry}/${repository}`, tag: `${component}-${env.GITHUB_SHA}` };
}

function json(text) {
  try { return JSON.parse(text); } catch { throw new RuntimeBuildError('invalid_response_json'); }
}

export function verifyManifest(plan, response, configDigest) {
  requireValue(Array.isArray(response?.images) && response.images.length === 1 &&
    (!response.failures || (Array.isArray(response.failures) && response.failures.length === 0)),
  'uploaded_image_unavailable');
  const image = response.images[0];
  requireValue(image?.registryId === plan.account && image.repositoryName === plan.repository &&
    image.imageId?.imageTag === plan.tag && DIGEST.test(image.imageId?.imageDigest || '') &&
    typeof image.imageManifest === 'string', 'uploaded_image_identity_mismatch');
  const manifest = json(image.imageManifest);
  requireValue(manifest.schemaVersion === 2 && [
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].includes(manifest.mediaType) && !manifest.manifests && Array.isArray(manifest.layers) &&
    DIGEST.test(configDigest) && manifest.config?.digest === configDigest,
  'uploaded_image_not_verified_single_manifest');
  const digest = `sha256:${createHash('sha256').update(image.imageManifest).digest('hex')}`;
  requireValue(digest === image.imageId.imageDigest, 'uploaded_digest_mismatch');
  return digest;
}

export function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
  // Tool stdout/stderr can contain tokens, repository identities or arbitrary build output.
  requireValue(!result.error && result.status === 0, 'tool_execution_failed');
  return result.stdout;
}

export function buildImage({ env = process.env, project, component, root = ROOT, run = command }) {
  const plan = imagePlan(env, project, component); // No tools before these guards.
  const aws = args => run('aws', [...args, '--region', REGION, '--output', 'json', '--no-cli-pager'], { env });
  verifyCaller(env, json(aws(['sts', 'get-caller-identity'])));
  let scratch;
  let localImage = false;
  const reference = `${plan.uri}:${plan.tag}`;
  let docker;
  try {
    const repos = json(aws(['ecr', 'describe-repositories', '--registry-id', plan.account,
      '--repository-names', plan.repository]));
    requireValue(repos.repositories?.length === 1 && repos.repositories[0].registryId === plan.account &&
      repos.repositories[0].repositoryName === plan.repository && repos.repositories[0].repositoryUri === plan.uri,
    'expected_repository_missing');
    scratch = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'runtime-image-'));
    const dockerEnv = { ...env, DOCKER_CONFIG: join(scratch, 'docker') };
    docker = (args, options = {}) => run('docker', args, { env: dockerEnv, ...options });
    // get-login-password emits text, not JSON. Keep it only in memory/stdin.
    const password = run('aws', ['ecr', 'get-login-password', '--region', REGION, '--no-cli-pager'], { env });
    docker(['login', '--username', 'AWS', '--password-stdin', plan.registry], { input: password });
    let context = join(root, component === 'agent' ? 'agent' : `scripts/v2/${component === 'worker' ? 'workers' : 'steampipe'}`);
    if (component === 'worker') {
      // Existing worker Dockerfile stages these retained dark modules; no flag is enabled.
      const staged = join(scratch, 'workers');
      cpSync(context, staged, { recursive: true });
      for (const name of ['action_catalog.py', 'remediation_executor.py', 'remediation_executor_cli.py']) {
        cpSync(join(root, 'scripts/v2/remediation', name), join(staged, name));
      }
      context = staged;
    }
    localImage = true;
    docker(['buildx', 'build', '--platform', 'linux/arm64', '--provenance=false', '--sbom=false',
      '--load', '-t', reference, context]);
    const images = json(docker(['image', 'inspect', reference]));
    requireValue(Array.isArray(images) && images.length === 1 && images[0].Architecture === 'arm64' &&
      images[0].Os === 'linux' && DIGEST.test(images[0].Id || ''), 'built_image_not_arm64');
    docker(['push', reference]);
    const response = json(aws(['ecr', 'batch-get-image', '--registry-id', plan.account,
      '--repository-name', plan.repository, '--image-ids', `imageTag=${plan.tag}`,
      '--accepted-media-types', 'application/vnd.docker.distribution.manifest.v2+json',
      'application/vnd.oci.image.manifest.v1+json']));
    const digest = verifyManifest(plan, response, images[0].Id);
    return { project: plan.project, digest, architecture: 'arm64' };
  } catch (error) {
    throw error instanceof RuntimeBuildError ? error : new RuntimeBuildError('image_build_failed');
  } finally {
    if (localImage) {
      try { docker(['image', 'rm', reference]); } catch { /* No broad daemon prune. */ }
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const mode = process.argv[2];
  if (mode === 'check-role') checkRole(process.env);
  else if (mode === 'verify-role') verifyCaller(process.env, json(readFileSync(0, 'utf8')));
  else if (mode === 'build') {
    requireValue(['steampipe', 'worker'].includes(process.env.RUNTIME_COMPONENT), 'invalid_component');
    const project = selectProject(readFileSync(0, 'utf8'));
    const result = buildImage({ project, component: process.env.RUNTIME_COMPONENT });
    requireValue(Boolean(process.env.GITHUB_OUTPUT), 'output_path_required');
    appendFileSync(process.env.GITHUB_OUTPUT, `project=${result.project}\ndigest=${result.digest}\n`);
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Verified ${process.env.RUNTIME_COMPONENT}: project \`${result.project}\`, ARM64, digest \`${result.digest}\`.\n`);
  } else throw new RuntimeBuildError('invalid_mode');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(`::error::${error instanceof RuntimeBuildError ? error.message : 'runtime_build_failed'}`);
    process.exitCode = 1;
  }
}
