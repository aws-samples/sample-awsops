#!/usr/bin/env node
// AWSops v2 P2 — worker image: build arm64 -> push to the worker ECR repo.
// Run AFTER `terraform apply` with workers_enabled=true (which creates the ECR repo + task def).
// The Fargate worker is launched ON DEMAND by Step Functions (it is NOT an ECS service), so this
// target only builds+pushes the image; SFN RunTask pulls :worker-latest at job time. The short
// (<15min) jobs run on the worker Lambda and need no image — its code ships in the Lambda zip.
import { execSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const CHDIR = 'terraform/foundation';
const TAG = process.env.WORKER_IMAGE_TAG || 'worker-latest';
const DOCKER = process.env.DOCKER || 'sudo docker';

const tf = (out) => execSync(`terraform -chdir=${CHDIR} output -raw ${out}`, { encoding: 'utf8' }).trim();
const sh = (cmd) => execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });

let repo = '';
try {
  repo = tf('worker_ecr_uri');
} catch {
  repo = '';
}
if (!repo || repo === 'null') {
  console.error('✗ worker_ecr_uri is empty — run `terraform apply` with workers_enabled=true first (P2 W9).');
  process.exit(1);
}
const registry = repo.split('/')[0];

// ADR-029+036 remediation P2-code executor (Fargate path): Docker COPY cannot reach a parent of the
// build context (scripts/v2/workers/), so pre-build copy the 3 remediation modules into the build
// context (approach (b) — chosen over relocating the context to keep the GREEN P2 worker path intact).
// Gated on the files existing; if remediation hasn't landed, this is a no-op and the Dockerfile COPY
// must not reference them. They ship in the same image; the SFN command selects the executor module.
const REMEDIATION_MODULES = ['action_catalog.py', 'remediation_executor.py', 'remediation_executor_cli.py'];
for (const m of REMEDIATION_MODULES) {
  const src = `scripts/v2/remediation/${m}`;
  if (existsSync(src)) {
    copyFileSync(src, `scripts/v2/workers/${m}`);
    console.log(`  + staged ${m} into worker build context`);
  }
}

console.log(`\n[1/2] ECR login -> ${registry}`);
sh(`aws ecr get-login-password --region ${REGION} | ${DOCKER} login --username AWS --password-stdin ${registry}`);

console.log(`\n[2/2] build + push arm64 -> ${repo}:${TAG}`);
sh(`${DOCKER} buildx build --platform linux/arm64 -t ${repo}:${TAG} --push scripts/v2/workers/`);

console.log('\n✅ worker image pushed. Step Functions RunTask will use it on the next fargate job.');
