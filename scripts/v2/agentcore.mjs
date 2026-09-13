#!/usr/bin/env node
// Build/provision only after migrations: private reusable task on dev, make migrate elsewhere.
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildImage, checkRole, command, imagePlan, RuntimeBuildError } from './ci/runtime-build.mjs';

export function deployAgent({ env = process.env, run = command, build = buildImage, smoke = false } = {}) {
  const dev = env.TARGET === 'dev' || env.GITHUB_REF === 'refs/heads/dev';
  if (dev) {
    checkRole(env);
    if (env.DOCKER !== 'docker' || env.AGENT_IMAGE_TAG !== `agent-${env.GITHUB_SHA}`) {
      throw new RuntimeBuildError('invalid_dev_image_build_configuration');
    }
  }
  const ac = JSON.parse(run('terraform', [
    '-chdir=terraform/foundation', 'output', '-json', 'agentcore',
  ], { env }));
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
    // Captured tool output never enters public CI logs; failure exposes a fixed code.
    run('python3', ['scripts/v2/agentcore/provision.py', ...(smoke ? ['--smoke'] : [])], {
      env: { ...env, AGENT_IMAGE_DIGEST: image.digest },
    });
    return { project: ac.project, digest: image.digest, architecture: 'arm64' };
  }
  // Existing main/preview deployment behavior and tags stay intact.
  const region = ac.region || env.AWS_REGION || 'ap-northeast-2';
  const tag = env.AGENT_IMAGE_TAG || 'agent-latest';
  const docker = env.DOCKER || 'sudo docker';
  const sh = cmd => execSync(cmd, { stdio: 'inherit', shell: '/bin/bash', env });
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
    console.error(`::error::${error instanceof RuntimeBuildError ? error.message : 'agentcore_deployment_failed'}`);
    process.exitCode = 1;
  }
}
