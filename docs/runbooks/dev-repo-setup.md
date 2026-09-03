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

| Role | Used by | Trust `sub` (StringEquals unless noted) | Permissions scope |
|---|---|---|---|
| `sample-awsops-ci-build` | main build | `repo:aws-samples/sample-awsops:ref:refs/heads/main` | prod ECR push |
| `sample-awsops-ci-deployer` | main roll / apply / agentcore (production env) | `repo:aws-samples/sample-awsops:environment:production` | prod ECS/ECR-pin/apply |
| `sample-awsops-dev-ci-build` | dev build | `...:ref:refs/heads/dev` | dev ECR push |
| `sample-awsops-dev-ci-deployer` | dev roll / apply / agentcore | `...:ref:refs/heads/dev` | dev ECS/ECR-pin/apply |
| `sample-awsops-dev-ci-preview` | preview deploys (any user branch) | StringLike `...:ref:refs/heads/*` | **preview-stack resources only** — the any-branch trust is safe only because the blast radius is preview-only |
| `sample-awsops-ci-terraform-plan` | plan (PR/push, read-only) | StringLike: `...:ref:refs/heads/main`, `...:ref:refs/heads/dev`, `...:pull_request` | ReadOnlyAccess |
| `sample-awsops-ci-review` | AI pr-review | StringLike: `...:ref:refs/heads/main`, `...:ref:refs/heads/dev` | Bedrock invoke |

Notes:
- Mutation roles pin to a single branch ref (or the `production` environment sub,
  which is even narrower — jobs with `environment: production` present
  `repo:...:environment:production`). Read-only roles may also accept the
  `pull_request` sub; fork PRs can never mint tokens anyway (GitHub withholds
  id-token from forks), and `terraform.yml` skips non-same-repo PRs outright.
- The `AWS_CI_*_ROLE_ARN` / `AWS_CI_*_DEV_ROLE_ARN` / `AWS_CI_PREVIEW_ROLE_ARN`
  repo variables must point at these roles.

(mutation 역할은 단일 브랜치 ref 또는 `environment:production` sub로 고정, read-only
역할만 `pull_request` sub를 추가 허용합니다. fork PR은 GitHub이 id-token 자체를 주지
않아 어떤 역할도 assume할 수 없습니다.)

### 3. Per-stack terraform secrets / 스택별 TF 시크릿

Each stack pair is provisioned under the repo's terraform discipline — a saved plan
applied verbatim, never `-auto-approve`:

```bash
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation plan -out tfplan   # review the plan
terraform -chdir=terraform/foundation apply tfplan       # apply EXACTLY that plan
```

Then register the generated files (base64) as repo secrets:

| Stack | Secrets |
|---|---|
| production (`main`) | `TF_BACKEND_HCL` / `TF_TFVARS` |
| dev (`awsops-dev.whchoi.net`) | `TF_BACKEND_HCL_DEV` / `TF_TFVARS_DEV` |
| preview (`<user>.awsops-dev.whchoi.net`) | `TF_BACKEND_HCL_PREVIEW_<USER>` / `TF_TFVARS_PREVIEW_<USER>` |

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
