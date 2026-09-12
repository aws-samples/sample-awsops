# Staged dev deployment / dev 단계별 배포

## Symptoms / 증상

A new samples `dev` deployment can fail because ECR does not exist yet, or wait
for ACM while the child zone's parent delegation is pending. The dev pipeline
now provisions core infrastructure before building. DNS registration remains
manual. Main still builds on push and rolls only through a dispatch protected by
the `production` environment.

새 samples `dev` 환경은 ECR 생성 전 이미지 push 또는 부모 NS 위임 전 ACM 검증에서
멈출 수 있습니다. dev CI는 core 인프라를 먼저 생성하고 이미지를 빌드합니다.
DNS 등록은 수동이며, main 배포는 기존 production 보호 환경의 수동 dispatch를 유지합니다.

## Prerequisites / 사전 조건

Use the existing backend and child hosted zone; this workflow does not create
the backend or register DNS. Repository secrets are `TF_BACKEND_HCL_DEV`,
`TF_TFVARS_DEV`, `AWS_CI_BUILD_DEV_ROLE_ARN`, `AWS_CI_DEPLOYER_DEV_ROLE_ARN`,
and `TF_VAR_DEMO_PASSWORD` if the demo account is enabled. The dev tfvars must
select project `awsops-dev` and region `ap-northeast-2`. No production fallback
is permitted. The public HTTPS smoke uses the existing demo identity, or a
dedicated standard identity in Secrets Manager selected by `DEV_SMOKE_SECRET_ARN`
(JSON fields `username`, `password`; an already provisioned, usable account).
Use the dedicated secret when the stack overrides the shared demo password.

기존 backend와 child hosted zone이 필요합니다. 위 secret을 사용하고 dev tfvars의
project/region을 일치시킵니다. backend 생성과 DNS 등록은 이 workflow의 작업이 아닙니다.
HTTPS 인증 검증에는 demo 계정 또는 `DEV_SMOKE_SECRET_ARN`의 사전 생성된 일반 계정을
사용합니다. stack별 demo 비밀번호를 따로 쓰면 전용 smoke secret을 지정합니다.

The build job has **no GitHub environment**, preserving its `refs/heads/dev`
OIDC subject and existing ECR-only role. Core/release use `development` and its
environment OIDC subject. Keep that environment's deployment branch restriction.
The deployer needs the stack's existing Terraform permissions plus ECS
register/describe/deregister task definition, run/describe/stop task, service/task
reads, ECR image reads, ACM certificate reads, Route53 record reads, and PassRole
for this stack's web execution/task and migration roles. An optional smoke secret
requires read/decrypt permission for that secret. No Route53 write permission is
needed by staged CI. Sessions request 3,600 seconds and refresh before edge work.

build job은 environment 없이 기존 dev 브랜치 OIDC를 유지합니다. core/release는
development 환경 OIDC를 사용합니다. deployer에는 기존 Terraform 권한 외에 해당
stack의 ECS task 실행·조회·정리, 제한된 PassRole, ECR/ACM/DNS 조회가 필요합니다.
전용 smoke secret을 사용하면 해당 secret 읽기·복호화 권한도 필요합니다.
DNS 쓰기 권한은 필요하지 않습니다. 세션은 3,600초이며 edge 직전에 갱신합니다.

## Flow and manual DNS / 흐름과 수동 DNS

1. `dev-core` restores the dev configuration and applies an exact saved, checked
   plan. A new stack gets ECS, Aurora, ECR, and ACM requests, with desired count
   zero, no certificate-validation wait, no HTTPS listener or CloudFront yet.
   Existing edge resources, service count, pinned revision, and managed DNS
   records are preserved from state.
2. `dev-images` builds `linux/arm64` web and migration images after ECR exists.
   Per-commit tags are immutable; a rerun reuses the existing digest. The legacy
   `web-latest` exclusion remains available, but staged dev does not promote it.
3. `dev-release` verifies both SHA tags against this run's digests, runs migration
   in private subnets, then deploys a digest-pinned web task revision. A rollback,
   unexpected revision/digest, zero desired count, or non-HEALTHY web container
   cannot pass. Migration failure prevents service rollout.
4. While ACM is pending, the successful private rollout reports `awaiting_dns`
   with public DNS instructions in the job summary. Register the child zone's
   NS delegation at the parent and ACM validation CNAMEs manually.
5. Dispatch **Deploy Web on dev again** after certificates are issued. CI adds
   the HTTPS ALB listener and CloudFront VPC origin/distribution, then converges
   ALB ingress from the CloudFront-managed SG with a second saved plan. Register
   each reported A ALIAS manually, using the reported distribution and target
   hosted-zone ID. This may require a second DNS registration pass because a
   new distribution's name is unavailable before certificate issuance.
6. Dispatch again after DNS propagation. CI verifies all aliases, NS delegation,
   the exact healthy service digest, HTTPS `/api/health`, the unauthenticated
   login redirect, and authenticated `/api/accounts`; only then it reports
   `deployed`. It signs the smoke session out afterwards.

1. core는 저장된 plan으로 core/ACM 요청을 생성합니다. 신규 ECS desired count는 0이며,
   기존 edge·revision·DNS state는 보존합니다.
2. ECR 생성 후 arm64 web/migration 이미지를 빌드합니다. SHA 태그는 불변이고 재실행 시
   기존 digest를 재사용합니다.
3. private subnet의 migration 성공 후 digest가 고정된 web revision을 배포합니다.
   실제 revision·digest·컨테이너 HEALTHY까지 확인합니다.
4. 인증서가 대기 중이면 `awaiting_dns`와 등록할 NS/CNAME을 출력합니다. 직접 등록합니다.
5. 인증서 발급 후 dev의 Deploy Web을 다시 dispatch하면 HTTPS edge를 완성하고 ALIAS
   대상을 출력합니다. 새 CloudFront 대상이 확정된 뒤 ALIAS도 직접 등록합니다.
6. DNS 전파 후 재실행하면 alias·위임·서비스 digest·HTTPS·로그인을 확인합니다.
   모든 검증을 통과해야 `deployed`입니다.

The entire dev workflow shares the `deployment-dev` concurrency group with
manual Terraform apply and does not cancel a running apply. No public ALB,
HTTP origin fallback, broad ingress, SG-description replacement, or frozen
product feature activation is introduced. Terraform's `deployment_stage`
output is only infrastructure readiness (`awaiting_dns` or
`awaiting_verification`); the release job output is the verified deployment status.

dev 전체 workflow와 수동 Terraform apply는 같은 잠금을 사용하며 실행 중 apply를
취소하지 않습니다. public ALB, HTTP origin 우회, 광범위 ingress, SG description 변경,
동결 기능 활성화는 하지 않습니다. Terraform output과 최종 배포 성공 상태는 구분합니다.

## Saved plan and failure handling / 저장 plan과 실패 처리

Automatic dev plans reject all DNS writes and every delete/replacement. A
resource replacement that is actually needed must go through the separately
reviewed manual Terraform plan/apply path (`reviewed_deletes`); it is not silently
approved by dev CI. `terraform.yml` derives the current dev stage from state so
its plan cannot reset the live service to the template image or default stage.
Do not manually turn `edge_enabled` off on an existing edge stack.

자동 dev는 DNS 쓰기 및 삭제/교체 plan을 거부합니다. 필요한 교체는 별도 검토한 수동
Terraform plan/apply의 `reviewed_deletes`로 처리합니다. 수동 plan도 현재 dev 단계와
revision을 보존합니다. 기존 edge의 `edge_enabled`를 false로 바꾸지 않습니다.

The manual plan artifact is authenticated AES-256-GCM encrypted, including
generated Lambda ZIPs needed by apply. Apply requires a successful
`terraform.yml` **push** run in the same repository at the dispatch's exact
SHA/ref/target, matching backend, tfvars and provider lockfile. PR plans and
old CBC artifacts are not apply candidates. Dispatch a new matching push plan
if provenance or Terraform state is stale; never re-plan inside apply or use
`-auto-approve`. `TF_PLAN_ENC_KEY` must be configured for both jobs.

수동 artifact는 Lambda ZIP까지 인증 암호화합니다. 동일 repository·SHA·ref·target의
성공한 push plan과 backend/tfvars/provider lockfile이 일치해야 apply할 수 있습니다.
PR plan과 예전 CBC artifact는 사용할 수 없습니다. 상태나 출처가 오래됐으면 새 plan을
생성하며 apply 중 재계획이나 `-auto-approve`는 사용하지 않습니다.

Plan values, database credentials and smoke cookies are not published. Sensitive
local files are removed in `always()` cleanup. Migration failures are investigated
in the migration task's restricted CloudWatch log group. A failed apply may have
partially created resources; rerun the same dev commit to resume from state.
Immutable image digests are rechecked before rollout. Use a revert commit on dev
for code rollback; staged dev rejects an unrelated `image_sha` override.

plan 값·DB 자격증명·smoke cookie는 공개하지 않고 로컬 민감 파일은 항상 정리합니다.
migration 실패는 전용 CloudWatch 로그에서 조사합니다. apply 일부만 완료됐더라도
동일 dev 커밋을 재실행하면 state에서 재개합니다. 코드 롤백은 dev의 revert 커밋으로
진행합니다. 별도 SHA 이미지를 강제 지정하는 방식은 거부합니다.

## Local verification / 로컬 검증

```bash
node --test scripts/v2/ci/*.test.mjs
# Reuse existing scripts/v2 dependencies; otherwise: npm ci --prefix scripts/v2
# Requires a local postgres:17-alpine image; creates/removes one loopback-only container.
node scripts/v2/ci/migration.itest.mjs
terraform -chdir=terraform/foundation init -backend=false -input=false -lockfile=readonly
terraform -chdir=terraform/foundation validate
```

The integration test executes the real migration runner against PostgreSQL 17:
baseline only on an empty DB, all ULIDs/checksums, rerun, failed-baseline rollback,
occupied-DB rejection and advisory-lock serialization. This does not prove live
Aurora IAM, OIDC permissions, image build, or DNS propagation.

통합 테스트는 실제 runner로 PostgreSQL 17에서 빈 DB baseline, 전체 ULID/checksum,
재실행, 실패 롤백, 기존 DB 거부, lock 직렬화를 검증합니다. 실제 Aurora IAM/OIDC 권한,
이미지 빌드, DNS 전파는 CI 배포에서 별도 확인해야 합니다.

Related / 관련: `dev-repo-setup.md`, `branch-strategy.md`,
`.github/workflows/deploy-web.yml`, `.github/workflows/terraform.yml`,
`scripts/v2/ci/`, `terraform/foundation/deployment.tf`. ADR-002, ADR-005, ADR-016.
