#!/usr/bin/env node
// AWSops v2 deploy: build arm64 -> push ECR -> ECS force-new-deployment -> wait stable -> smoke.
import { execFileSync, execSync } from 'node:child_process';
import { smokeArgs } from './deployment-smoke.mjs';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const CHDIR = 'terraform/foundation';
const TAG = process.env.IMAGE_TAG || 'web-latest';
const DOCKER = process.env.DOCKER || 'sudo docker';

const tf = (out) => execSync(`terraform -chdir=${CHDIR} output -raw ${out}`, { encoding: 'utf8' }).trim();
const sh = (cmd) => execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });

const repo = tf('ecr_web_uri');
const registry = repo.split('/')[0];
const cluster = tf('ecs_cluster_name');
const service = tf('ecs_service_name');
const url = tf('public_url');
const cloudfront = tf('cloudfront_domain');
const smoke = smokeArgs(url, cloudfront); // Validate the destination before deployment.

console.log(`\n[1/5] ECR login -> ${registry}`);
sh(`aws ecr get-login-password --region ${REGION} | ${DOCKER} login --username AWS --password-stdin ${registry}`);

console.log(`\n[2/5] build + push arm64 -> ${repo}:${TAG}`);
// CHANGELOG.md는 저장소 루트가 원본이지만 빌드 컨텍스트가 web/ 뿐이라 빌드 직전 복사한다
// (web/CHANGELOG.md는 gitignore — 사이드바 버전/변경내역이 배포 커밋과 항상 일치).
sh('cp CHANGELOG.md web/CHANGELOG.md');
sh(`${DOCKER} buildx build --platform linux/arm64 -t ${repo}:${TAG} --push web/`);

console.log(`\n[3/5] ECS force-new-deployment -> ${cluster}/${service}`);
sh(`aws ecs update-service --cluster ${cluster} --service ${service} --force-new-deployment --region ${REGION} >/dev/null`);

console.log(`\n[4/5] wait services-stable (may take a few minutes)`);
sh(`aws ecs wait services-stable --cluster ${cluster} --services ${service} --region ${REGION}`);

console.log(`\n[5/5] smoke -> ${url}/api/health`);
execFileSync('curl', smoke, { stdio: 'inherit' });

console.log('\n✅ deploy complete');
