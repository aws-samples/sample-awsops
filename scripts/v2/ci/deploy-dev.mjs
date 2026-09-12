#!/usr/bin/env node
// Dev-only controller. Commands are argument arrays; Terraform output is private.
// phases: core (deployer), images (build role), release + edge (deployer).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, appendFileSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { guardPlan, stageVariables, verifyService, aliasesRegistered, assertDeploymentAccount } from './guards.mjs';
const TF = 'terraform/foundation';
const PRIVATE = `${TF}/.build/ci`;
const REGION = 'ap-northeast-2';
const sha = process.env.GITHUB_SHA;
let deploymentAccount;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
process.umask(0o077);
mkdirSync(PRIVATE, { recursive: true, mode: 0o700 }); chmodSync(PRIVATE, 0o700);
function save(name, value) { writeFileSync(`${PRIVATE}/${name}`, JSON.stringify(value), { mode: 0o600 }); }
function load(name) { return JSON.parse(readFileSync(`${PRIVATE}/${name}`)); }
function run(command, args, { input, visible = false } = {}) {
  return new Promise((resolve, reject) => {
    const terraformLog = command === 'terraform' && ['plan', 'apply'].includes(args[1]) ? `${TF}/tfplan.log` : null;
    if (terraformLog) writeFileSync(terraformLog, '', { mode: 0o600 });
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; if (terraformLog) appendFileSync(terraformLog, data); if (visible) process.stdout.write(data); });
    child.stderr.on('data', data => { stderr += data; if (terraformLog) appendFileSync(terraformLog, data); if (visible) process.stderr.write(data); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else {
        // Never echo Terraform values or AWS request/response contents in public CI.
        writeFileSync(`${PRIVATE}/last-error.log`, stdout + stderr, { mode: 0o600 });
        const error = new Error(`${command} ${args[0]} failed (${code}); inspect the encrypted failure-diagnostics artifact`);
        error.stderr = stderr; reject(error);
      }
    });
    child.stdin.end(input);
  });
}
const tf = (...args) => run('terraform', [`-chdir=${TF}`, ...args]);
const aws = async (service, action, args = [], region = REGION) => JSON.parse(await run('aws', [service, action, ...args, '--region', region, '--output', 'json', '--no-cli-pager']));
const outputs = async () => Object.fromEntries(Object.entries(JSON.parse(await tf('output', '-json'))).map(([key, value]) => [key, value.value]));
const summary = text => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`); };
const jobOutput = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};
const status = value => { summary(`Deployment status: **${value}**`); console.log(`deployment_status=${value}`); jobOutput('deployment_status', value); };

async function assertContext({ planning = false } = {}) {
  const devRef = process.env.GITHUB_REF === 'refs/heads/dev' ||
    (planning && process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_BASE_REF === 'dev');
  if (!devRef || !/^[a-f0-9]{40}$/.test(sha ?? '') ||
      !(planning ? ['push', 'pull_request'] : ['push', 'workflow_dispatch']).includes(process.env.GITHUB_EVENT_NAME) ||
      await run('git', ['rev-parse', 'HEAD']) !== sha) throw new Error('Dev deployment requires the exact dev push/dispatch SHA');
  if (process.env.IMAGE_SHA && process.env.IMAGE_SHA !== sha) throw new Error('Staged dev deployment uses this commit only; use a revert commit on dev for rollback');
  const { Account } = await aws('sts', 'get-caller-identity');
  assertDeploymentAccount(Account, process.env.AWS_DEV_ACCOUNT_ID);
  deploymentAccount = Account;
}
function flatten(module) { return [...(module?.resources ?? []), ...(module?.child_modules ?? []).flatMap(flatten)]; }
async function stateResources() { return flatten(JSON.parse(await tf('show', '-json')).values?.root_module); }

async function planPhase(phase, variables) {
  await assertContext();
  const metadata = { sha, ref: process.env.GITHUB_REF, target: 'dev', run: process.env.GITHUB_RUN_ID,
    backend: hash(readFileSync(`${TF}/backend.hcl`)), config: hash(readFileSync(`${TF}/terraform.tfvars`)) };
  save('variables.tfvars.json', variables);
  console.log(`Planning ${phase}`);
  await tf('plan', '-input=false', '-lock-timeout=5m', '-out=.build/ci/tfplan', '-var-file=.build/ci/variables.tfvars.json');
  const plan = JSON.parse(await tf('show', '-json', '.build/ci/tfplan'));
  if (plan.variables?.project?.value !== 'awsops-dev' || plan.variables?.region?.value !== REGION ||
      plan.variables?.ci_deployment_enabled?.value !== true) throw new Error('Refusing a plan outside the samples dev stack');
  guardPlan(plan, { bootstrapOrigin: phase === 'edge', enforceDeploymentPosture: true,
    taskRevisionScope: { project: 'awsops-dev', region: REGION, account: deploymentAccount } });
  save('plan-provenance.json', { ...metadata, phase, digest: hash(readFileSync(`${PRIVATE}/tfplan`)),
    variables: hash(readFileSync(`${PRIVATE}/variables.tfvars.json`)),
    providers: hash(readFileSync(`${TF}/.terraform.lock.hcl`)) });
}

async function applyPreparedPlan(phase) {
  // Service migration runs between planning and this check. Never re-plan afterward.
  const pinned = load('plan-provenance.json');
  if (pinned.phase !== phase || pinned.sha !== sha || pinned.ref !== process.env.GITHUB_REF ||
      pinned.digest !== hash(readFileSync(`${PRIVATE}/tfplan`)) ||
      pinned.backend !== hash(readFileSync(`${TF}/backend.hcl`)) ||
      pinned.config !== hash(readFileSync(`${TF}/terraform.tfvars`)) ||
      pinned.variables !== hash(readFileSync(`${PRIVATE}/variables.tfvars.json`)) ||
      pinned.providers !== hash(readFileSync(`${TF}/.terraform.lock.hcl`))) throw new Error('Saved plan/config changed');
  await assertContext();
  console.log(`Applying guarded saved ${phase} plan (only scoped retained task revisions may be replaced)`);
  await tf('apply', '-input=false', '-lock-timeout=5m', '.build/ci/tfplan');
  rmSync(`${PRIVATE}/tfplan`, { force: true });
  return outputs();
}

async function applyPhase(phase, variables) {
  await planPhase(phase, variables);
  return applyPreparedPlan(phase);
}

async function prepare() {
  const variables = stageVariables(await stateResources());
  save('variables.tfvars.json', variables);
  return variables;
}
async function core() {
  const resources = await stateResources();
  const variables = stageVariables(resources);
  save('variables.tfvars.json', variables);
  if (resources.some(resource => resource.mode !== 'data')) {
    // No whole-root update before migration on a running/previously bootstrapped stack:
    // Terraform may package database-dependent Lambdas as well as the web task.
    const migration = resources.find(resource => resource.type === 'aws_ecs_task_definition' && resource.name === 'migration');
    if (!migration) throw new Error('Existing-stack migration prerequisite missing: provision the reviewed migration role/template before staged CI; refusing a pre-migration root apply');
    const out = await outputs();
    const config = out.deployment_config;
    const expectedUri = `${deploymentAccount}.dkr.ecr.${REGION}.amazonaws.com/awsops-dev-web`;
    if (config?.project !== 'awsops-dev' || config?.region !== REGION ||
        !config.migration_task_definition || out.ecr_web_uri !== expectedUri ||
        out.ecs_cluster_name !== 'awsops-dev' || out.ecs_service_name !== 'awsops-dev-web') {
      throw new Error('Existing-stack deployment output prerequisites are missing or outside the pinned dev stack');
    }
    const { repositories } = await aws('ecr', 'describe-repositories', ['--repository-names', 'awsops-dev-web']);
    if (repositories?.length !== 1 || repositories[0].repositoryUri !== expectedUri) throw new Error('Existing dev ECR prerequisite mismatch');
    summary('Existing core/output/ECR prerequisites verified. No root plan/apply ran before migration.');
    return;
  }
  await applyPhase('core', variables);
  summary('Fresh empty-state bootstrap complete with web desired count zero. Existing stacks are never updated here; migration precedes their full foundation apply.');
}
async function imageDigest(repo, tag) {
  const response = await aws('ecr', 'batch-get-image', ['--repository-name', repo, '--image-ids', `imageTag=${tag}`]);
  if (response.failures?.some(f => f.failureCode !== 'ImageNotFound')) throw new Error('ECR image lookup failed');
  const digest = response.images?.[0]?.imageId?.imageDigest;
  if (digest && !digestPattern.test(digest)) throw new Error('Invalid ECR image digest');
  return digest;
}
async function images() {
  // Build job has branch OIDC, ECR-only credentials and no Terraform state access.
  const repo = 'awsops-dev-web', uri = `${deploymentAccount}.dkr.ecr.${REGION}.amazonaws.com/${repo}`;
  const password = await run('aws', ['ecr', 'get-login-password', '--region', REGION]);
  await run('docker', ['login', '--username', 'AWS', '--password-stdin', uri.split('/')[0]], { input: password });
  const built = {};
  for (const kind of ['web', 'migration']) {
    const tag = imageTag(kind);
    const metadataFile = `${PRIVATE}/build-${kind}.json`;
    rmSync(metadataFile, { force: true });
    if (kind === 'web') copyFileSync('CHANGELOG.md', 'web/CHANGELOG.md');
    const args = ['buildx', 'build', '--platform', 'linux/arm64', '--provenance=false', '--sbom=false',
      '--metadata-file', metadataFile, '--push', '--tag', `${uri}:${tag}`];
    if (kind === 'migration') args.push('--file', 'scripts/v2/ci/Dockerfile.migration', '.'); else args.push('web');
    await run('docker', args, { visible: true });
    const produced = JSON.parse(readFileSync(metadataFile))['containerimage.digest'];
    if (!digestPattern.test(produced ?? '')) throw new Error(`BuildKit did not produce a valid ${kind} digest`);
    if (await imageDigest(repo, tag) !== produced) throw new Error(`Locally built ${kind} digest does not match ECR`);
    built[kind] = produced;
  }
  save('images.json', { ...built, sha });
  for (const [kind, digest] of Object.entries(built)) jobOutput(`${kind}_digest`, digest);
}
function imageTag(kind) {
  const runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!/^\d+$/.test(runId ?? '') || !/^\d+$/.test(attempt ?? '')) throw new Error('Image provenance requires this run ID and attempt');
  return `${kind}-${sha}-${runId}-${attempt}`;
}
async function registerRevision(template, containerName, image, environment = {}) {
  const { taskDefinition } = await aws('ecs', 'describe-task-definition', ['--task-definition', template]);
  // Copy only RegisterTaskDefinition fields, never describe-only properties.
  const allowed = ['family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions','volumes','placementConstraints','requiresCompatibilities','cpu','memory','runtimePlatform','ephemeralStorage'];
  const definition = Object.fromEntries(allowed.filter(key => taskDefinition[key] !== undefined).map(key => [key, taskDefinition[key]]));
  const container = definition.containerDefinitions.find(c => c.name === containerName);
  if (!container || definition.runtimePlatform?.cpuArchitecture !== 'ARM64') throw new Error('Expected arm64 task template');
  container.image = image;
  container.environment = [
    ...(container.environment ?? []).filter(entry => !(entry.name in environment)),
    ...Object.entries(environment).map(([name, value]) => ({ name, value })),
  ];
  save('task-definition.json', definition);
  const result = await aws('ecs', 'register-task-definition', ['--cli-input-json', `file://${PRIVATE}/task-definition.json`]);
  return result.taskDefinition.taskDefinitionArn;
}
async function migrate(out, digest, phase = 'pre-apply') {
  const config = out.deployment_config;
  const readerSecret = out.agent_sql_reader_secret_arn;
  if (typeof readerSecret !== 'string') throw new Error('SQL-reader Terraform output missing; refresh the reviewed deployment outputs before migration');
  const revision = await registerRevision(config.migration_task_definition, 'migration', `${out.ecr_web_uri}@${digest}`, {
    SQL_READER_SYNC_MODE: readerSecret ? 'secret' : 'disabled',
    SQL_READER_SECRET_ARN: readerSecret,
  });
  let taskArn, stopped = false;
  try {
    save('run-task.json', { cluster: out.ecs_cluster_name, taskDefinition: revision,
      launchType: 'FARGATE', count: 1, networkConfiguration: config.network,
      clientToken: `migration-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${phase}`,
      startedBy: `ci-${process.env.GITHUB_RUN_ID}` });
    const result = await aws('ecs', 'run-task', ['--cli-input-json', `file://${PRIVATE}/run-task.json`]);
    taskArn = result.tasks?.[0]?.taskArn;
    if (result.failures?.length || !taskArn) throw new Error('Migration task failed to start');
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await aws('ecs', 'describe-tasks', ['--cluster', out.ecs_cluster_name, '--tasks', taskArn]);
      const task = response.tasks?.[0];
      if (task?.lastStatus === 'STOPPED') {
        stopped = true;
        const container = task.containers?.find(c => c.name === 'migration');
        if (task.stopCode !== 'EssentialContainerExited' || container?.exitCode !== 0 || container?.imageDigest !== digest) throw new Error('Migration failed: inspect its restricted CloudWatch logs');
        return;
      }
      await pause(15000);
    }
    throw new Error('Migration exceeded 30 minutes');
  } finally {
    if (taskArn && !stopped) await aws('ecs', 'stop-task', ['--cluster', out.ecs_cluster_name, '--task', taskArn, '--reason', 'CI migration did not complete']).catch(() => {});
    await aws('ecs', 'deregister-task-definition', ['--task-definition', revision]).catch(() => {});
  }
}
async function verify(out, digest) {
  let lastReason = 'rollout not ready';
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const { services, failures } = await aws('ecs', 'describe-services', ['--cluster', out.ecs_cluster_name, '--services', out.ecs_service_name]);
      if (failures?.length || !services?.length) throw new Error('ECS service lookup failed');
      const { taskArns } = await aws('ecs', 'list-tasks', ['--cluster', out.ecs_cluster_name, '--service-name', out.ecs_service_name, '--desired-status', 'RUNNING']);
      const response = taskArns?.length ? await aws('ecs', 'describe-tasks', ['--cluster', out.ecs_cluster_name, '--tasks', ...taskArns]) : { tasks: [] };
      if (response.failures?.length) throw new Error('Task lookup incomplete');
      try {
        verifyService(services[0], response.tasks, digest, out.deployment_config.task_definition);
        return;
      } catch (error) { lastReason = error.message; }
    } catch (error) {
      if (!/Throttl|TooManyRequests|RequestLimitExceeded|ServiceUnavailable|InternalFailure|InternalServerError|RequestTimeout|timed out|ECONNRESET|\b50[234]\b/i.test(error.stderr ?? '')) throw error;
      lastReason = 'Transient AWS read failure';
    }
    await pause(15000);
  }
  throw new Error(`Service verification timed out: ${lastReason}`);
}
async function release() {
  const phase = { variables: await prepare(), sha };
  const built = { web: process.env.WEB_DIGEST, migration: process.env.MIGRATION_DIGEST, sha };
  if (![built.web, built.migration].every(digest => digestPattern.test(digest ?? ''))) throw new Error('Missing immutable image digests from this run');
  const out = await outputs();
  await proveSmokeIdentity(out);
  const repo = out.ecr_web_uri.split('/').slice(1).join('/');
  for (const kind of ['web', 'migration']) {
    if (await imageDigest(repo, imageTag(kind)) !== built[kind]) throw new Error('This run’s image digest mismatch; rerun all jobs to rebuild this attempt');
  }
  save('images.json', built);
  phase.variables.web_task_definition_arn = '';
  phase.variables.web_image_digest = built.web;
  phase.variables.web_desired_count = Math.max(1, phase.variables.web_desired_count);
  await planPhase('service', phase.variables);
  console.log('Service plan guarded; running private migration before applying that exact plan');
  await migrate(out, built.migration);
  const rolled = await applyPreparedPlan('service');
  await migrate(rolled, built.migration, 'post-apply');
  save('phase.json', phase);
  await verify(rolled, built.web);
  summary(`Migration completed; service is running the expected image with healthy containers (commit ${sha}).`);
}
function reportDns(config) {
  const dns = config.dns;
  // DNS records are deliberately public; no other Terraform outputs are published.
  summary('Manual DNS registration (no DNS records were written by this pipeline):');
  summary(`\n\`\`\`text\n${dns.zone} NS ${dns.nameservers.join(' ')}\n${[...new Set(dns.validation.map(r => `${r.name} ${r.type} ${r.value}`))].join('\n')}\n${dns.target ? dns.aliases.map(name => `${name} A ALIAS ${dns.target} (target zone ${dns.target_zone})`).join('\n') : 'CloudFront alias target will be reported after certificate issuance.'}\n\`\`\``);
}
async function request(url, options = {}) { return fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
async function smokeCredentials(out) {
  const arn = process.env.SMOKE_SECRET_ARN;
  let credentials;
  try {
    credentials = arn
      ? JSON.parse((await aws('secretsmanager', 'get-secret-value', ['--secret-id', arn])).SecretString)
      : { username: out.deployment_config.smoke_email, password: process.env.TF_VAR_demo_password };
  } catch {
    throw new Error('Smoke identity credentials could not be read; check the configured secret and its access');
  }
  if (typeof credentials?.username !== 'string' || !credentials.username.trim() ||
      typeof credentials?.password !== 'string' || !credentials.password) {
    throw new Error('Smoke identity missing: configure a usable demo identity with TF_VAR_DEMO_PASSWORD or DEV_SMOKE_SECRET_ARN before DNS readiness');
  }
  return credentials;
}
async function proveSmokeIdentity(out) {
  const credentials = await smokeCredentials(out);
  if (typeof out.cognito_client_id !== 'string' || !/^[a-zA-Z0-9]+$/.test(out.cognito_client_id)) {
    throw new Error('Smoke identity preflight requires this stack’s Cognito client ID');
  }
  let response, body;
  try {
    // Public USER_PASSWORD_AUTH is unsigned and needs no Cognito IAM grant.
    // Its HTTPS endpoint works before our application's DNS or edge exists.
    response = await request(`https://cognito-idp.${REGION}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH', ClientId: out.cognito_client_id,
        AuthParameters: { USERNAME: credentials.username, PASSWORD: credentials.password },
      }),
    });
    body = await response.json();
  } catch {
    throw new Error('Smoke identity preflight could not complete Cognito sign-in; DNS is not the only remaining prerequisite');
  }
  if (!response.ok || body?.ChallengeName ||
      typeof body?.AuthenticationResult?.IdToken !== 'string' || !body.AuthenticationResult.IdToken ||
      typeof body?.AuthenticationResult?.AccessToken !== 'string' || !body.AuthenticationResult.AccessToken) {
    throw new Error('Smoke identity sign-in rejected or requires a challenge; resolve it before DNS readiness');
  }
  // Discard the tokens; final HTTPS smoke still signs in through the real BFF.
  return credentials;
}
async function smoke(out) {
  const url = out.public_url;
  const health = await request(`${url}/api/health`);
  if (health.status !== 200 || (await health.json()).status !== 'ok') throw new Error('Public health smoke failed');
  const denied = await request(`${url}/api/accounts`);
  if (denied.status !== 302 || !denied.headers.get('location')?.startsWith('/login')) throw new Error('Unauthenticated edge request was not redirected to login');
  // Dedicated smoke credentials are fetched at runtime, or use the existing
  // masked demo secret. Neither response body nor cookie is logged.
  const { username, password } = await smokeCredentials(out);
  const login = await request(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ email: username, password }) });
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('awsops_token='))?.split(';')[0];
  if (login.status !== 200 || !cookie) throw new Error('Smoke identity could not sign in');
  try {
    const authorized = await request(`${url}/api/accounts`, { headers: { cookie } });
    if (authorized.status !== 200) throw new Error('Authenticated edge/BFF smoke failed');
    await authorized.json();
  } finally { await request(`${url}/api/auth/signout`, { method: 'POST', headers: { cookie, origin: url } }); }
}
async function edge() {
  let out = await outputs();
  await proveSmokeIdentity(out);
  const certificates = await Promise.all(out.deployment_config.certificates.map(async certificate => {
    const result = await aws('acm', 'describe-certificate', ['--certificate-arn', certificate.arn], certificate.region);
    return result.Certificate.Status;
  }));
  reportDns(out.deployment_config);
  if (!certificates.every(state => state === 'ISSUED')) {
    if (certificates.some(state => state !== 'PENDING_VALIDATION' && state !== 'ISSUED')) throw new Error('Certificate is neither issued nor pending validation');
    status('awaiting_dns'); return;
  }
  const phase = load('phase.json'); phase.variables.defer_edge_until_dns = false;
  out = await applyPhase('edge', phase.variables);
  // The CloudFront-managed SG only exists AFTER the first VPC origin. A second
  // guarded plan converges the existing ALB ingress in place, with no CIDR fallback.
  out = await applyPhase('edge-ingress', phase.variables);
  await migrate(out, load('images.json').migration, 'post-edge');
  save('phase.json', phase);
  reportDns(out.deployment_config);
  await verify(out, load('images.json').web);
  const { ResourceRecordSets } = await aws('route53', 'list-resource-record-sets', ['--hosted-zone-id', out.deployment_config.dns.zone_id]);
  if (!aliasesRegistered(out.deployment_config.dns, ResourceRecordSets ?? [])) { status('awaiting_dns'); return; }
  // A failed DNS lookup is a pending manual alias, not a successful public deploy.
  const { resolveNs, resolve4 } = await import('node:dns/promises');
  try {
    const delegated = (await resolveNs(out.deployment_config.dns.zone)).map(name => name.replace(/\.$/, '').toLowerCase()).sort();
    const expected = out.deployment_config.dns.nameservers.map(name => name.replace(/\.$/, '').toLowerCase()).sort();
    if (JSON.stringify(delegated) !== JSON.stringify(expected)) { status('awaiting_dns'); return; }
    await resolve4(new URL(out.public_url).hostname);
  }
  catch (error) {
    if (['ENOTFOUND', 'ENODATA', 'ESERVFAIL'].includes(error.code)) { status('awaiting_dns'); return; }
    throw error;
  }
  await smoke(out);
  status('deployed');
}
try {
  await assertContext({ planning: process.argv[2] === 'prepare' });
  const phases = { prepare, core, images, release, edge };
  if (!phases[process.argv[2]]) throw new Error('Expected prepare, core, images, release or edge');
  await phases[process.argv[2]]();
} catch (error) { console.error(error.message); process.exitCode = 1; }
