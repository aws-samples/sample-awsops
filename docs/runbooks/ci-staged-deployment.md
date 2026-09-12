# Staged dev deployment / dev 단계별 배포

## Symptoms / 증상

A new samples `dev` deployment can fail because ECR does not exist yet, or wait for ACM while the child zone's parent delegation is pending. The dev pipeline now provisions core infrastructure before building. DNS registration remains manual. Main still builds on push and rolls only through a dispatch protected by the `production` environment.

새 samples `dev` 환경은 ECR 생성 전 이미지 push 또는 부모 NS 위임 전 ACM 검증에서 멈출 수 있습니다. dev CI는 core 인프라를 먼저 생성하고 이미지를 빌드합니다. DNS 등록은 수동이며, main 배포는 기존 production 보호 환경의 수동 dispatch를 유지합니다.

## Prerequisites / 사전 조건

Use the existing backend and child hosted zone; this workflow does not create the backend or register DNS. Repository secrets are `TF_BACKEND_HCL_DEV`,
`TF_TFVARS_DEV`, `AWS_CI_BUILD_DEV_ROLE_ARN`, `AWS_CI_DEPLOYER_DEV_ROLE_ARN`,
the protected `AWS_DEV_ACCOUNT_ID`, and `TF_VAR_DEMO_PASSWORD` if the demo account is enabled. The dev tfvars must select project `awsops-dev` and region `ap-northeast-2`. No production fallback is permitted. The public HTTPS smoke uses the existing demo identity, or a dedicated standard identity in Secrets Manager selected by `DEV_SMOKE_SECRET_ARN` (JSON fields `username`, `password`; an already provisioned, usable account). Use the dedicated secret when the stack overrides the shared demo password. Exactly one usable identity path is required: a provisioned demo user with the matching shared password, or the dedicated secret. A password alone is not an identity. Every dev phase compares its STS caller account to `AWS_DEV_ACCOUNT_ID`; an absent or mismatched pin fails before deployment operations. Keep the actual account ID in the protected secret, never in committed configuration.

기존 backend와 child hosted zone이 필요합니다. 위 secret을 사용하고 dev tfvars의 project/region을 일치시킵니다. backend 생성과 DNS 등록은 이 workflow의 작업이 아닙니다. HTTPS 인증 검증에는 demo 계정 또는 `DEV_SMOKE_SECRET_ARN`의 사전 생성된 일반 계정을 사용합니다. stack별 demo 비밀번호를 따로 쓰면 전용 smoke secret을 지정합니다. 사용 가능한 demo 사용자와 일치하는 비밀번호 또는 전용 secret 중 하나가 반드시 필요합니다. 비밀번호만으로는 충분하지 않습니다. 모든 dev 단계는 STS 계정을 보호된
`AWS_DEV_ACCOUNT_ID` secret과 비교하며 누락·불일치 시 배포 전에 실패합니다.
실제 계정 ID는 코드에 기록하지 않습니다.

The build job has **no GitHub environment**, preserving its `refs/heads/dev` OIDC subject and existing ECR-only role. Core/release use `development` and its environment OIDC subject. Keep that environment's deployment branch restriction. The deployer needs the stack's existing Terraform permissions plus ECS register/describe/deregister task definition, run/describe/stop task, service/task reads, ECR image reads, ACM certificate reads, Route53 record reads, and PassRole for this stack's web execution/task and migration roles. An optional smoke secret requires read/decrypt permission for that secret. No Route53 write permission is needed by staged CI. Sessions request 3,600 seconds and refresh before edge work.

build job은 environment 없이 기존 dev 브랜치 OIDC를 유지합니다. core/release는 development 환경 OIDC를 사용합니다. deployer에는 기존 Terraform 권한 외에 해당 stack의 ECS task 실행·조회·정리, 제한된 PassRole, ECR/ACM/DNS 조회가 필요합니다. 전용 smoke secret을 사용하면 해당 secret 읽기·복호화 권한도 필요합니다. DNS 쓰기 권한은 필요하지 않습니다. 세션은 3,600초이며 edge 직전에 갱신합니다.

Before migration and again before any `awaiting_dns` handoff, CI proves that the configured identity can sign in through the stack's public Cognito client with unsigned `InitiateAuth` (`USER_PASSWORD_AUTH`). This needs neither application DNS nor Cognito IAM permission. Missing credentials, rejected sign-in, an MFA or password-change challenge, or an incomplete token response fails explicitly. Tokens are discarded and never published. This preflight does not replace the final authenticated HTTPS smoke through the application.

migration 전과 `awaiting_dns` 안내 전에 Cognito public client의 서명 없는
`InitiateAuth`로 실제 로그인을 검증합니다. 애플리케이션 DNS나 Cognito IAM 권한이
필요하지 않습니다. 자격증명 누락·로그인 거부·MFA/비밀번호 변경 challenge·불완전한 토큰 응답은 명시적으로 실패하며 토큰은 출력하지 않고 폐기합니다. 최종 애플리케이션 HTTPS 인증 검증은 그대로 수행합니다.

## Flow and manual DNS / 흐름과 수동 DNS

1. `dev-core` reads state. Only an empty state receives a fresh bootstrap saved
   plan, with web desired count zero and edge/DNS deferred. An existing stack
   must already expose its migration task, deployment outputs and ECR repository;
   core verifies those prerequisites without a root plan/apply. A legacy or
   partially bootstrapped stack missing the migration template fails explicitly:
   provision that reviewed prerequisite separately, without deploying new
   database-dependent application code.
2. `dev-images` builds `linux/arm64` web and migration images after ECR exists.
   The CI dev repository uses `IMMUTABLE`; a rerun reuses existing SHA-tag digests.
   Dev has no `web-latest` writer. Main/user stacks with CI mode off retain
   `MUTABLE` and their existing promotion procedure. Buildx setup and build share
   the job's `DOCKER_CONFIG`.
3. `dev-release` proves smoke-identity sign-in, verifies both SHA tags against this run's digests, runs migration
   in private subnets, then applies the full saved foundation plan and deploys a
   digest-pinned web task revision. Thus existing database-dependent Lambdas are
   updated only after migration. A rollback,
   unexpected revision/digest, zero desired count, or non-HEALTHY web container
   cannot pass. Migration failure prevents service rollout.
4. After smoke-identity preflight and the private rollout succeed, pending ACM reports `awaiting_dns`
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

1. 빈 state만 web count 0과 edge/DNS 유예 상태로 bootstrap합니다. 기존 stack은
   migration task·배포 output·ECR을 검증만 하고 전체 plan/apply를 실행하지 않습니다.
   migration template이 없는 기존/부분 생성 stack은 명시적으로 실패하므로 검토된
   선행 리소스를 먼저 준비해야 합니다.
2. ECR 생성 후 arm64 web/migration 이미지를 빌드합니다. SHA 태그는 불변이고 재실행 시
   기존 digest를 재사용합니다. dev ECR은 예외 없는 `IMMUTABLE`이며 Buildx와 빌드는
   job의 `DOCKER_CONFIG`를 공유합니다.
3. smoke 로그인과 private migration 성공 후 전체 저장 plan과 digest 고정 web revision을 적용합니다.
   실제 revision·digest·컨테이너 HEALTHY까지 확인합니다.
4. 인증서가 대기 중이면 `awaiting_dns`와 등록할 NS/CNAME을 출력합니다. 직접 등록합니다.
5. 인증서 발급 후 dev의 Deploy Web을 다시 dispatch하면 HTTPS edge를 완성하고 ALIAS
   대상을 출력합니다. 새 CloudFront 대상이 확정된 뒤 ALIAS도 직접 등록합니다.
6. DNS 전파 후 재실행하면 alias·위임·서비스 digest·HTTPS·로그인을 확인합니다.
   모든 검증을 통과해야 `deployed`입니다.

The entire dev workflow shares the `deployment-dev` concurrency group with manual Terraform apply and does not cancel a running apply. No public ALB, HTTP origin fallback, broad ingress, SG-description replacement, or frozen product feature activation is introduced. Terraform's `deployment_stage` output is only infrastructure readiness (`awaiting_dns` or
`awaiting_verification`); the release job output is the verified deployment status.

dev 전체 workflow와 수동 Terraform apply는 같은 잠금을 사용하며 실행 중 apply를 취소하지 않습니다. public ALB, HTTP origin 우회, 광범위 ingress, SG description 변경, 동결 기능 활성화는 하지 않습니다. Terraform output과 최종 배포 성공 상태는 구분합니다.

## Saved plan and failure handling / 저장 plan과 실패 처리

Automatic dev plans reject all DNS writes and every delete/replacement. A resource replacement that is actually needed must go through the separately reviewed manual Terraform plan/apply path (`reviewed_deletes`); it is not silently approved by dev CI. `terraform.yml` derives the current dev stage from state so its plan cannot reset the live service to the template image or default stage. Do not manually enable `defer_edge_until_dns` on an existing edge stack. Both automatic and manual saved-plan guards require `remediation_enabled=false`. The full foundation remains deployable from reviewed protected commits and protected configuration; this is not a second per-resource IAM policy engine.

자동 dev는 DNS 쓰기 및 삭제/교체 plan을 거부합니다. 필요한 교체는 별도 검토한 수동 Terraform plan/apply의 `reviewed_deletes`로 처리합니다. 수동 plan도 현재 dev 단계와 revision을 보존합니다. 기존 edge의 `defer_edge_until_dns`를 true로 바꾸지 않습니다. 자동·수동 저장 plan 모두 `remediation_enabled=false`를 확인합니다. 검토된 보호 브랜치 커밋과 보호된 설정의 전체 foundation 배포는 허용하며,
리소스별 IAM 정책을 별도의 엔진에서 다시 정의하지 않습니다.

For a reviewed manual first-origin bootstrap, `reviewed_origin_bootstrap=true`
exempts only `check.cf_vpc_origin_sg_present`; it never permits another failed
check or a replacement. The next saved plan must establish managed-SG ingress.
검토된 수동 최초 origin 생성은 해당 입력으로 지정한 SG check만 예외 처리합니다.
다른 check나 교체는 허용하지 않으며 다음 plan에서 managed-SG ingress를 완성합니다.

The required **Plan** check remains a real `terraform plan`. PR-authored guard
tests and backend-free `terraform validate` run on a hosted runner without deployment secrets or OIDC. The credentialed
PR Plan checks out the immutable **base SHA**, using only that revision's
Terraform configuration and helpers; the job summary names both base and
candidate SHAs. It validates the trusted base against the target state, not the
candidate Terraform changes. The first bootstrap base may not contain the new
staging helpers: it still runs a normal plan of its existing configuration.
Missing backend/tfvars or a failed plan is a failure, never a successful skip.
After merge, a protected push plans the reviewed candidate and is the only
source of an apply-eligible encrypted artifact. No new manual approval step is
introduced.

This fixes direct PR-script execution in the credentialed job. The `pull_request`
workflow definition itself remains PR-controlled; that pre-existing trust risk
is not solved by checking out the base.

필수 **Plan** 검사는 실제 `terraform plan`을 실행합니다. PR의 guard 테스트와
backend를 연결하지 않는 `terraform validate`는
배포 secret/OIDC가 없는 hosted runner에서 실행합니다. 자격증명을 사용하는 PR
Plan은 변경 불가능한 **base SHA**의 Terraform 설정과 helper만 실행하고 base/candidate
SHA를 요약에 표시합니다. PR 변경 자체가 아니라 신뢰된 base와 대상 state를 점검합니다.
최초 base에 새 helper가 없어도 기존 설정의 실제 plan을 실행하며 설정 누락이나
plan 실패를 성공으로 처리하지 않습니다. 머지 후 보호 브랜치 push가 검토된 코드를
plan하고, 이 결과만 apply 가능한 암호화 artifact가 됩니다. 새 수동 승인 단계는 없습니다.
이 수정은 PR 스크립트 직접 실행을 격리하며 PR이 workflow YAML 자체를 통제하는
기존 신뢰 경계까지 해결하는 것은 아닙니다.

The manual plan artifact is authenticated AES-256-GCM encrypted, including
generated Lambda ZIPs needed by apply. Apply requires a successful
`terraform.yml` **push** run in the same repository at the dispatch's exact
SHA/ref/target, matching backend, tfvars and provider lockfile. PR plans and
old CBC artifacts are not apply candidates. If provenance or state is stale,
rerun the qualifying Terraform push run for the exact current SHA, or create a
new trusted push matching the workflow's path filters. After that plan succeeds,
dispatch apply at the same SHA/ref with its run ID; dispatch itself never creates
a plan. Never re-plan inside apply or use
`-auto-approve`. `TF_PLAN_ENC_KEY` must be configured for both jobs.

수동 artifact는 Lambda ZIP까지 인증 암호화합니다. 동일 repository·SHA·ref·target의
성공한 push plan과 backend/tfvars/provider lockfile이 일치해야 apply할 수 있습니다.
PR plan과 예전 CBC artifact는 사용할 수 없습니다. 상태나 출처가 오래됐으면 현재 SHA의
Terraform push 실행을 다시 실행하거나 경로 필터에 맞는 새 보호 브랜치 push로 plan을
생성합니다. 성공한 plan의 SHA/ref에서 해당 run ID로 apply를 dispatch합니다.
dispatch 자체는 plan을 만들지 않으며 apply 중 재계획이나 `-auto-approve`는 사용하지 않습니다.

Plan values, database credentials and smoke cookies are not published. Before
cleanup, failure logs are AES-256-GCM encrypted and uploaded as `ci-failure-*`
artifacts (five-day retention). If encryption/upload fails, diagnostics remain
under the runner work area's private `.awsops-private-diagnostics` directory,
outside checkout and runner-temp cleanup; recover them with restricted host access.
Never upload the retained plaintext. Migration failures also have the task's
restricted CloudWatch logs. Partial bootstrap without a migration template
requires the explicit prerequisite repair above; a ready stack can be rerun.
Immutable image digests are rechecked before rollout. Use a revert commit on dev
for code rollback; staged dev rejects an unrelated `image_sha` override.

정리 전에 실패 로그를 인증 암호화해 `ci-failure-*` artifact로 5일간 보존합니다.
암호화/업로드 실패 시 checkout·runner temp 밖의 접근 제한 디렉터리에 남기며
평문은 업로드하지 않습니다. migration 오류는 전용 CloudWatch 로그도 확인합니다.
template이 없는 부분 bootstrap은 선행 조건 복구가 필요합니다. 코드 롤백은 revert 커밋으로
진행합니다. 별도 SHA 이미지를 강제 지정하는 방식은 거부합니다.

With `TF_PLAN_ENC_KEY` supplied securely, decrypt a downloaded artifact locally:

```bash
node scripts/v2/ci/failure-logs.mjs open diagnostics.enc /path/to/private-diagnostics
```

키는 안전하게 주입하고 다운로드한 로그를 접근 제한 디렉터리로 복호화합니다.
조사 후 runner의 보존 사본과 로컬 복호화 파일을 정리합니다.

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

An offline Terraform AWS provider **6.47.0** fixture using synthetic ECS state,
`-refresh=false` and mock credentials planned adding `load_balancer` as
`actions=["update"]`, with no replacement or AWS request. This supports the
in-place transition contract; it is not a live dev plan or deployment proof.
오프라인 synthetic-state fixture는 LB 연결 추가가 update임을 확인했으며
실제 dev plan/배포 증거는 아닙니다. 삭제·교체 guard는 완화하지 않습니다.

Related / 관련: `dev-repo-setup.md`, `branch-strategy.md`,
`.github/workflows/deploy-web.yml`, `.github/workflows/terraform.yml`,
`scripts/v2/ci/`, `terraform/foundation/deployment.tf`. ADR-001, ADR-002, ADR-005, ADR-021.
