# CI/OIDC bring-up (single repo) / CI·OIDC 활성화 (단일 리포)

Related files / 관련 파일: `.github/workflows/{deploy-web,deploy-preview,terraform,deploy-agentcore}.yml`,
`docs/runbooks/branch-strategy.md`

> Historical note: this file previously described the two-repo split
> (`Atom-oh/sample-awsops-dev`). The project consolidated into the single public
> repo `aws-samples/sample-awsops` (all branches public by design — see
> branch-strategy.md); the private repo is retired/archived.
> (과거 2-리포 분리 시절의 문서였으며, 단일 공개 리포로 통합되었습니다. 비공개 dev
> 리포는 은퇴/아카이브 대상입니다.)

## Symptoms / 증상

- A `dev` push run fails at *Configure AWS credentials* with
  `Not authorized to perform sts:AssumeRoleWithWebIdentity`, or
- it fails at *Restore terraform.foundation backend* with
  `this branch's TF backend secrets are not set`, or
- a preview dispatch fails the same way for `TF_*_PREVIEW_<USER>`, or
- the deploy job's *Pin web-latest* step fails with an ECR `AccessDenied`.

(dev push 런이 자격증명/시크릿/ECR pin 단계에서 실패하는 경우 — 아래 1회성 작업이
아직 안 된 것입니다.)

## Cause / 원인

The pipeline definitions are complete; four one-time account/infra steps remain
outside what repo automation can do for itself.
(파이프라인 정의는 완성돼 있고, 리포 자동화가 스스로 할 수 없는 1회성 계정/인프라
작업 4개가 남아 있습니다.)

## Action / 조치

### 1. Runner / 러너

The `sample-awsops` self-hosted runner is already registered to this repo (it has
been running the main-branch pipelines). Nothing to do unless runs queue forever.
(러너는 이미 이 리포에 등록돼 있습니다 — 런이 무한 대기할 때만 재확인.)

### 2. CI roles + GitHub OIDC trust matrix / CI 역할·신뢰 매트릭스

All roles live in the samples deployment account and trust the GitHub OIDC
provider with a `sub` condition — never the repo-wide `:*` wildcard, which would
let ANY branch (including an experiment branch with an edited workflow) assume the
mutation roles. Role-to-sub matrix:

| Role | Used by | Trust `sub` | Permissions scope |
|---|---|---|---|
| `sample-awsops-ci-build` | main build (no environment) | StringEquals `repo:aws-samples/sample-awsops:ref:refs/heads/main` | prod ECR push |
| `sample-awsops-ci-deployer` | main roll / apply / agentcore (jobs carry `environment: production`) | StringEquals `repo:aws-samples/sample-awsops:environment:production` | prod ECS/ECR-pin/apply |
| `sample-awsops-dev-ci-build` | dev + user-branch builds (no environment) | StringLike, one entry per branch: `...:ref:refs/heads/dev`, `...:ref:refs/heads/atomoh`, `...:ref:refs/heads/ssminji`, `...:ref:refs/heads/whchoi` | dev + user stacks' ECR push |
| `sample-awsops-dev-ci-deployer` | dev + user-branch rolls, dev apply/agentcore (jobs carry `environment: development`) | StringEquals `repo:aws-samples/sample-awsops:environment:development` | dev + user stacks' ECS/ECR-pin/apply — **never production** |
| `sample-awsops-ci-terraform-plan` | plan (PR/push incl. user-branch own-stack plans, read-only) | StringLike: `...:pull_request` + refs `main`, `dev`, `atomoh`, `ssminji`, `whchoi` | ReadOnlyAccess |
| `sample-awsops-ci-review` | AI pr-review | StringLike: `...:pull_request` + refs `main`, `dev` | Bedrock invoke |

CRITICAL sub rule: **a job that declares `environment:` presents the
`repo:<owner>/<repo>:environment:<name>` sub — NOT its branch ref.** Deployer
roles must therefore trust the environment sub (pinning them to a branch ref
makes every deploy fail AssumeRoleWithWebIdentity). Which branches can reach an
environment is enforced by the environment's own deployment branch policy
(`production` → main only; `development` → dev, atomoh, ssminji, whchoi).
Build/plan jobs carry no environment and present branch-ref subs. Fork PRs can
never mint tokens (GitHub withholds id-token from forks) and `terraform.yml`
skips non-same-repo PRs outright.
(`environment:`가 선언된 잡의 OIDC sub는 브랜치 ref가 아니라 `environment:<이름>`
입니다 — deployer 역할 신뢰는 environment sub로, 브랜치 제한은 environment의
deployment branch policy로 거는 것이 올바른 구성입니다.)

The former `sample-awsops-dev-ci-preview` role and `deploy-preview.yml` are
RETIRED — user branches are standing branches with continuous deploy, covered by
the dev-tier roles above. (구 preview 역할·워크플로는 은퇴 — 사용자 브랜치가 상시
브랜치가 되면서 dev-tier 역할이 담당합니다.)

### Recovery of review CI / 리뷰 CI 복구

**Verified operational facts (2026-09-11):** a read-only `iam:GetRole` inspection in the
samples account confirmed that the live review role already trusted the `pull_request`
subject before this recovery. The table above corrects stale documentation; this change
does not create or update any IAM trust policy. The review role is managed outside this
repository. The existing subject is coarse: another permitted same-repository PR workflow
can also request it. A recovery label gates this workflow's execution and publication,
not IAM authorization; do not treat the label as an IAM security boundary.

Automatic `pull_request_target` review runs CI code from the immutable default-branch
`github.sha`, which may differ from the PR target's base SHA. The panel and chair read
application context from a separate worktree at the target base.
This follows GitHub's change effective **2025-12-08**, which moved `GITHUB_REF` and
`GITHUB_SHA` to the default branch regardless of the PR target:
[GitHub Actions platform announcement](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/).
Older descriptions of the target-base branch as the workflow execution context describe
the previous behavior.

When the trusted review workflow itself needs repair, explicitly approve its current
same-repository PR commit with a `ci-review:<full HEAD SHA>` label. Review the CI changes
before labeling: this authorizes execution of that commit's CI scripts with the review
role and PR-comment write permission. Such a recovery run cannot independently certify
the integrity of the scripts it executes: separate review of the exact commit and explicit
operator approval are prerequisites. The operator authorized this recovery on 2026-09-11;
execution remains conditional on verifying the exact commit before labeling.
That authorization is scoped to restoring this pipeline and
does not authorize unrelated future recovery commits. The remaining credential exposure
is model invocation cost/quota and review-comment integrity, not infrastructure mutation.
The `pull_request`/`labeled` recovery route uses the review role's existing
`pull_request` trust; it does not require broadening branch trust or changing IAM.
The workflow rejects forks, mismatched/stale labels, changed live HEADs and non-`dev`/`main`
targets. Both vendors must complete all four lenses; the normal merge checks still apply.

```bash
read -r -p "Recovery PR number: " REVIEW_PR
read -r -p "Full commit SHA you independently reviewed: " REVIEW_HEAD
[[ "$REVIEW_HEAD" =~ ^[0-9a-f]{40}$ ]] || exit 1
LIVE_HEAD=$(gh pr view "$REVIEW_PR" -R aws-samples/sample-awsops --json headRefOid --jq '.headRefOid')
[ "$LIVE_HEAD" = "$REVIEW_HEAD" ] || { echo "HEAD changed; review the new commit first"; exit 1; }
printf 'Execute reviewed CI code at %s for PR %s\n' "$REVIEW_HEAD" "$REVIEW_PR"
read -r -p "Type approve to authorize this exact commit: " REVIEW_APPROVAL
[ "$REVIEW_APPROVAL" = approve ] || exit 1
gh label create "ci-review:$REVIEW_HEAD" -R aws-samples/sample-awsops --color 1D76DB --description 'Explicit approval of this CI recovery commit'
gh pr edit "$REVIEW_PR" -R aws-samples/sample-awsops --add-label "ci-review:$REVIEW_HEAD"
```

A new commit needs a new matching label; a previous approval never follows a branch tip.
If the label already exists, reuse it. To retry the identical commit, rerun the failed
recovery workflow. After merging the repair, update dependent PRs against `dev` so the
restored automatic review runs normally.

Claude review cells have a 600-second attempt budget after observed 300-second L2
timeouts; Codex retains 300 seconds. Both are bounded by a hard-kill grace and two attempts.
An exhausted attempt is recorded with its exit code and elapsed time and cannot count
as completed coverage.

(자동 리뷰 코드는 PR 대상 브랜치가 아닌 기본 브랜치의 불변 커밋에서 실행합니다.
복구 PR의 CI 변경을 검토한 뒤 전체 HEAD SHA가 포함된 라벨을 명시적으로 붙이면
기존 `pull_request` 신뢰 경로로 복구 리뷰를 실행합니다. 새 커밋은 새 라벨 승인이
필요하며, 모델·검토 항목 누락과 필수 검사 실패는 계속 머지를 차단합니다.)

### 3. Per-stack terraform secrets / 스택별 TF 시크릿

Each stack pair is provisioned under the repo's terraform discipline — a saved plan
applied verbatim, never `-auto-approve`:

```bash
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation plan -out tfplan   # review the plan
terraform -chdir=terraform/foundation apply tfplan       # apply EXACTLY that plan
```

Sensitive-value policy (public repo — Actions LOGS are public): role ARNs and
anything carrying the account id live in repo **secrets** (auto-masked in
logs), never variables; every credentials step sets `mask-aws-account-id`.
Cognito users: dev/preview stacks get the shared regular **demo user**
(`demo_email` defaults to `demo@awsops.local`; its password rides as the
`TF_VAR_DEMO_PASSWORD` repo secret, exported by terraform.yml as
`TF_VAR_demo_password` on the plan step only). `create_demo_user` defaults to
**false** (fail-closed): a dev-tier stack opts in with `create_demo_user =
true` in its tfvars blob, so the shared credential can never reach a stack —
production foremost — by omission. A stack may instead override
`demo_password` in its own blob (the blob is itself a secret; tfvars outranks
env, so the override is the sanctioned per-stack path). **Admin users are not
Terraform-managed at all** (a TF-managed admin would need a password channel
through CI plans, and a locally-applied one would ping-pong into a destroy on
the next CI plan via the shared remote state). Provision an admin per stack
out-of-band, with per-stack credentials — never a repo-wide shared pair:

```bash
aws cognito-idp admin-create-user --user-pool-id <pool-id> \
  --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=true \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id <pool-id> \
  --username <email> --password '<per-stack password>' --permanent
aws cognito-idp admin-add-user-to-group --user-pool-id <pool-id> \
  --username <email> --group-name admins
```

Only admins (the Cognito `admins` group, or the SSM email allowlist) see
IAM-related views. `admin_password` must NOT sit in any registered tfvars
blob — the restore step hard-fails on it (`admin_email` alone is fine: it is
not a secret, and `k8sgpt_enabled` stacks need it in tfvars for the budget
alarm subscriber). Stacks provisioned before this policy carried a TF-managed
admin user: the first post-merge plan proposes destroying it — that removal
is intentional (recreate via the CLI above when the stack actually needs an
admin).

⚠️ Identity caveat: app ownership (reports, chat threads, …) is keyed by the
Cognito `sub`, which is minted per user object — deleting and recreating a
user yields a NEW `sub`, so rows owned by the old identity do not follow it.
Only the legacy verified-email read path bridges some tables. Two distinct
situations:

- **TF-managed admin about to be destroyed by the config removal above**: the
  apply WILL delete the user object; disabling cannot stop a planned destroy.
  To keep the identity (and its `sub`) alive on a stack with real user-owned
  data, detach it from state BEFORE the first post-merge apply:
  `terraform -chdir=terraform/foundation state rm 'aws_cognito_user.admin'` —
  Terraform then forgets the
  resource without touching the live user. Skip this on stacks with nothing
  to preserve and let the apply delete it.
- **Manually-provisioned users** (the CLI flow above): to revoke access,
  prefer `admin-disable-user` over delete/recreate — deletion is identity
  loss.

(TF-관리 admin은 다음 apply가 반드시 삭제합니다 — 보존하려면 apply 전에
`terraform -chdir=terraform/foundation state rm 'aws_cognito_user.admin'`으로
상태에서만 떼어냅니다.
disable은 삭제를 막지 못하며, 수동 생성 사용자에 대한 접근 차단 수단입니다.)
The plan artifact is a covered channel too: a tfplan embeds every variable
value in plaintext and public-repo artifacts are downloadable by anyone, so
the plan job encrypts it with the `TF_PLAN_ENC_KEY` secret (fail-closed) and
the apply job decrypts before applying.
(공개 리포는 Actions 로그도 공개 — 역할 ARN 등 계정 ID 포함 값은 변수 금지·시크릿
전용. demo 사용자 비밀번호는 `TF_VAR_DEMO_PASSWORD` 시크릿으로 공급하되 production은
`create_demo_user=false` 또는 자체 tfvars 블롭의 `demo_password` override로 공유
자격을 거부합니다. admin 사용자는 Terraform 관리 밖입니다 — 스택별로 위
`admin-create-user` CLI 3종으로 만들고 `admins` 그룹에 넣습니다. 기존 스택의
TF-관리 admin은 머지 후 첫 plan에서 삭제로 표시되며, 이는 의도된 제거입니다.)

Then register the generated files (base64) as repo secrets:

| Stack | Secrets |
|---|---|
| all stacks (repo-wide) | `TF_PLAN_ENC_KEY` (plan-artifact encryption) / `TF_VAR_DEMO_PASSWORD` (demo user) / role-ARN secrets `AWS_CI_BUILD_ROLE_ARN` · `AWS_CI_BUILD_DEV_ROLE_ARN` · `AWS_CI_DEPLOYER_ROLE_ARN` · `AWS_CI_DEPLOYER_DEV_ROLE_ARN` · `AWS_CI_TERRAFORM_PLAN_ROLE_ARN` · `AWS_CI_REVIEW_ROLE_ARN` (moved from repo variables — public-repo logs never mask variables) |
| production (`main`) | `TF_BACKEND_HCL` / `TF_TFVARS` |
| dev (`awsops-dev.whchoi.net`) | `TF_BACKEND_HCL_DEV` / `TF_TFVARS_DEV` |
| user branch `atomoh`/`ssminji`/`whchoi` (`<user>.awsops-dev.whchoi.net`) | `TF_BACKEND_HCL_PREVIEW_<USER>` / `TF_TFVARS_PREVIEW_<USER>` (uppercased branch name) |

```bash
gh secret set TF_BACKEND_HCL_DEV -R aws-samples/sample-awsops \
  --body "$(base64 -w0 terraform/foundation/backend.hcl)"
gh secret set TF_TFVARS_DEV -R aws-samples/sample-awsops \
  --body "$(base64 -w0 terraform/foundation/terraform.tfvars)"
```

The distinct NAMES are the isolation: a dev/preview job can never fall back to the
production pair. From then on, terraform changes flow through `terraform.yml`
(automatic plan on PR/push; saved-plan apply via dispatch, gated by the branch's
environment — `production` carries the reviewer approval).
(시크릿 이름 분리가 격리 그 자체입니다 — dev/preview 잡은 production 시크릿으로
폴백할 수 없습니다. 이후 변경은 terraform.yml로: PR/push 자동 plan, dispatch
저장-plan apply — main은 production environment 승인 게이트가 추가됩니다.)

### 4. ECR permissions for the pin step / ci-deployer ECR 권한

The deploy jobs re-point `:web-latest` at the approved `web-<sha>` before rolling,
so each deployer role needs `ecr:BatchGetImage` + `ecr:PutImage` scoped to its own
stack's web ECR repository (plus the auth-token action it already has).
(각 deployer 역할에 자기 스택 web ECR 스코프의 `ecr:BatchGetImage`·`ecr:PutImage`
권한이 필요합니다.)

## Verification / 확인

Push a trivial `web/**` change to `dev`: the run should build, pin, roll and pass
the smoke against `awsops-dev.whchoi.net/api/health` end-to-end. For production:
merge `dev → main`, dispatch Deploy Web from main, approve, and watch the smoke
against the `public_url` output.
