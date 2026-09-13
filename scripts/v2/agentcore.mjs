#!/usr/bin/env node
// Migrations establish awsops_sql_reader + its secret before AgentCore's Data API tools.
// Dev uses the private reusable task; other stacks use make migrate (runbooks/agent-sql-reader.md).
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildImage, checkRole, command, imagePlan, RuntimeBuildError, TIMEOUTS } from './ci/runtime-build.mjs';

const STAGES = new Set(['configuration', 'identity', 'gateways', 'credentials', 'lambda_targets',
  'runtime', 'mcp_targets', 'prune', 'memory', 'interpreter', 'ssm', 'smoke', 'complete', 'unknown']);
const STATUSES = new Set(['CREATED', 'EXISTS', 'UPDATED', 'ERR', 'WARN', 'SKIP', 'WROTE',
  'DELETED', 'RETIRED', 'KEEP', 'OK']);
const KINDS = new Set(['gateway', 'target', 'provider', 'runtime', 'memory', 'interpreter',
  'ssm', 'credentials', 'operation', 'unknown']);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;

export function emitProvisionReport(text, {
  write = console.log, required = true, summaryFile = process.env.GITHUB_STEP_SUMMARY,
} = {}) {
  let summary;
  let emitted = 0;
  for (const line of String(text || '').slice(0, 128 * 1024).split('\n')) {
    if (emitted >= 260 || line.length > 4096) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || !STAGES.has(value.stage)) continue;
    const keys = Object.keys(value).sort().join(',');
    if (value.event === 'agentcore_provision_stage' && keys === 'event,stage') {
      // Fixed stage labels only.
    } else if (value.event === 'agentcore_provision_result' && keys === 'code,event,key,kind,stage,status' &&
        KINDS.has(value.kind) && STATUSES.has(value.status) &&
        (value.key === null || (typeof value.key === 'string' && /^[a-z][a-z0-9_-]{0,95}$/.test(value.key))) &&
        typeof value.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.code)) {
      // Python maps keys to catalog constants and codes to its fixed vocabulary.
    } else if (value.event === 'agentcore_provision_summary' && keys === 'counts,dropped,event,stage' &&
        count(value.dropped) && value.counts && !Array.isArray(value.counts) &&
        Object.entries(value.counts).every(([key, value]) => STATUSES.has(key) && count(value))) {
      summary = value;
    } else continue;
    write(JSON.stringify(value));
    emitted++;
  }
  if (summary && summaryFile) appendFileSync(summaryFile,
    `AgentCore provision status counts: \`${JSON.stringify(summary.counts)}\`; dropped events: ${summary.dropped}.\n`);
  if (required && !summary) throw new RuntimeBuildError('provision_report_missing');
}

export function deployAgent({ env = process.env, run = command, build = buildImage, smoke = false,
  report = emitProvisionReport, legacyRun } = {}) {
  const dev = env.TARGET === 'dev' || env.GITHUB_REF === 'refs/heads/dev';
  if (dev) {
    checkRole(env);
    if (env.DOCKER !== 'docker' || env.AGENT_IMAGE_TAG !== `agent-${env.GITHUB_SHA}`) {
      throw new RuntimeBuildError('invalid_dev_image_build_configuration');
    }
  }
  const ac = JSON.parse(run('terraform', [
    '-chdir=terraform/foundation', 'output', '-json', 'agentcore',
  ], { env, timeout: TIMEOUTS.read }));
  if (!ac) throw new RuntimeBuildError('agentcore_output_unavailable');
  if (dev) {
    const plan = imagePlan(env, ac.project, 'agent');
    if (ac.region !== env.AWS_REGION || ac.ecr_uri !== plan.uri ||
        !new RegExp(`^arn:aws:iam::${plan.account}:role/[A-Za-z0-9+=,.@_/-]+$`).test(ac.role_arn || '')) {
      throw new RuntimeBuildError('agentcore_output_identity_mismatch');
    }
    const image = build({ env, project: ac.project, component: 'agent' });
    if (!/^sha256:[0-9a-f]{64}$/.test(image.digest || '') || image.architecture !== 'arm64') {
      throw new RuntimeBuildError('agent_image_not_verified');
    }
    console.log(JSON.stringify({ event: 'agentcore_provision_stage', stage: 'configuration' }));
    try {
      const output = run('python3', ['scripts/v2/agentcore/provision.py', ...(smoke ? ['--smoke'] : [])], {
        env: { ...env, AGENT_IMAGE_DIGEST: image.digest }, timeout: TIMEOUTS.provision,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      report(output, { summaryFile: env.GITHUB_STEP_SUMMARY });
    } catch (error) {
      if (error instanceof RuntimeBuildError) {
        report(error.output, { required: false, summaryFile: env.GITHUB_STEP_SUMMARY });
        error.stage = 'provision';
      }
      throw error;
    }
    return { project: ac.project, digest: image.digest, architecture: 'arm64' };
  }
  // Existing main/preview deployment behavior and tags stay intact.
  const region = ac.region || env.AWS_REGION || 'ap-northeast-2';
  const tag = env.AGENT_IMAGE_TAG || 'agent-latest';
  const docker = env.DOCKER || 'sudo docker';
  const sh = legacyRun || (cmd => execSync(cmd, { stdio: 'inherit', shell: '/bin/bash', env }));
  sh(`aws ecr get-login-password --region ${region} | ${docker} login --username AWS --password-stdin ${ac.ecr_uri.split('/')[0]}`);
  sh(`${docker} buildx build --platform linux/arm64 -t ${ac.ecr_uri}:${tag} --push agent/`);
  sh(`python3 scripts/v2/agentcore/provision.py ${smoke ? '--smoke' : ''}`.trim());
  return { project: ac.project };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = deployAgent({ smoke: process.argv.includes('--smoke') });
    console.log(JSON.stringify({ status: 'provisioned', ...result }));
  } catch (error) {
    console.error(`::error::${error instanceof RuntimeBuildError ? `${error.stage || 'validation'}:${error.message}` : 'agentcore_deployment_failed'}`);
    process.exitCode = error instanceof RuntimeBuildError ? error.exitCode : 1;
  }
}
