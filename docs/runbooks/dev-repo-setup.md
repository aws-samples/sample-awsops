# Private dev repo bring-up / 비공개 dev 리포 활성화

Related files / 관련 파일: `.github/workflows/{deploy-web,terraform,deploy-agentcore}.yml`

## Symptoms / 증상

- A push to `dev` in the private dev repo starts a workflow run that **queues
  forever** (no runner picks it up), or
- the run starts but fails at *Configure AWS credentials* with
  `Not authorized to perform sts:AssumeRoleWithWebIdentity`, or
- it fails at *Restore terraform.foundation backend* with
  `TF_BACKEND_HCL repo secret not set`, or
- the deploy job's *Pin web-latest* step fails with an ECR `AccessDenied`.

(비공개 dev 리포에서 dev push 후 런이 영원히 대기하거나, 자격증명 단계에서
`AssumeRoleWithWebIdentity` 거부, backend 복원 단계에서 시크릿 미설정 에러,
pin 단계에서 ECR `AccessDenied`가 나는 경우.)

## Cause / 원인

The pipeline definitions are complete, but four one-time account/infra steps
sit outside what repo automation can do for itself. Each symptom above maps
1:1 to one missing step below.
(파이프라인 정의는 완성돼 있으나, 리포 자동화가 스스로 할 수 없는 1회성
계정/인프라 작업 4개가 남아 있기 때문입니다. 위 증상은 아래 항목과 1:1로
대응합니다.)

## Action / 조치

### 1. Register the self-hosted runner / 러너 등록

The workflows use `runs-on: sample-awsops`. That runner is registered to the
public repo only — register it (or its runner group) to the private dev repo
too, from the runner platform that hosts it.
(워크플로가 쓰는 `sample-awsops` 라벨 러너는 공개 리포에만 등록돼 있으므로 이
리포에도 등록해야 합니다. 미등록이 "영원히 대기" 증상의 원인.)

### 2. Create DEV-scoped CI roles + GitHub OIDC trust / dev 전용 CI 역할

Create four DEV-scoped roles — `sample-awsops-dev-ci-{build,deployer,
terraform-plan,review}` — mirroring the production roles' permission shapes
but **scoped to the dev stack's resources only** (its ECR repo, its ECS
cluster/service, its tfstate key), each trusting the GitHub OIDC provider
with a `sub` condition scoped **per role** — never the repo-wide
`repo:Atom-oh/sample-awsops-dev:*` wildcard, which would let ANY branch of
this repo (including an experiment branch with an edited workflow file)
assume the mutation roles:

```json
// dev-ci-deployer, dev-ci-terraform-plan(apply 사용 시): dev 브랜치 런만
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:sub": "repo:Atom-oh/sample-awsops-dev:ref:refs/heads/dev"
  }
}

// dev-ci-build: dev 브랜치 push 빌드만 — 위와 동일한 dev-branch sub
// dev-ci-terraform-plan(plan은 PR에서도 돌게 하려면), dev-ci-review:
"Condition": {
  "StringLike": {
    "token.actions.githubusercontent.com:sub": [
      "repo:Atom-oh/sample-awsops-dev:ref:refs/heads/dev",
      "repo:Atom-oh/sample-awsops-dev:pull_request"
    ]
  }
}
```

(mutation 능력이 있는 역할(deployer, apply에 쓰는 plan 역할)은
`ref:refs/heads/dev` 단일 sub로 고정 — 임의 브랜치의 수정된 워크플로가
역할을 assume하는 경로를 차단합니다. read-only 역할만 PR sub를 추가로
허용합니다.)

⚠️ Do **NOT** instead add the dev repo to the production roles' trust policy.
This repo's pipeline is deliberately ungated (no environment reviewer —
see below), so reusing the production roles here would open two unapproved
paths into production: an `ecs update-service` / `ecr put-image` against the
production service and `:web-latest` tag, and a `terraform apply` against
production state. Role separation closes both structurally — the production
roles never need to trust this repo at all.

This repo's `AWS_CI_*_ROLE_ARN` variables already point at the dev-scoped
role names above; creating the roles makes them live. If the dev stack lives
in a **different account**, create the roles there and update the variables'
account — that adds full blast-radius isolation on top.
(dev 전용 역할 4종을 dev 스택 리소스 스코프로 새로 만들고, 신뢰는 비공개 dev
리포 sub만 허용합니다. **production 역할 신뢰에 dev 리포를 추가하면 안 됩니다**
— 이 리포 파이프라인은 승인 게이트가 없어, prod 역할을 재사용하면 prod ECS
롤링/`web-latest` 재태깅과 prod terraform apply라는 무승인 경로 2개가 열립니다.
이 리포의 역할 ARN 변수는 이미 dev 전용 역할명을 가리키고 있으므로 역할 생성만
하면 됩니다.)

### 3. Provision the dev stack + set its TF secrets / dev 스택과 시크릿

Run `make configure` once FOR THE DEV STACK (its own state key and its own
dev domain/cert inputs), then provision it under the repo's terraform
discipline — a saved plan applied verbatim, never `-auto-approve`:

```bash
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation plan -out tfplan   # review the plan
terraform -chdir=terraform/foundation apply tfplan       # apply EXACTLY that plan
```

Then store the generated files as the dev repo's secrets:

```bash
gh secret set TF_BACKEND_HCL -R Atom-oh/sample-awsops-dev \
  --body "$(base64 -w0 terraform/foundation/backend.hcl)"
gh secret set TF_TFVARS -R Atom-oh/sample-awsops-dev \
  --body "$(base64 -w0 terraform/foundation/terraform.tfvars)"
```

(From then on, terraform changes for the dev stack go through this repo's
`terraform.yml` — automatic plan on PR/push, and apply only via a manual
workflow_dispatch that takes a `plan_run_id` and applies EXACTLY that saved
plan. Note the difference from production: this private repo has no
environment reviewer gate (GitHub environments aren't available on private
Free-plan repos), so the dev apply's controls are the saved-plan pinning plus
the deliberate dispatch itself — production additionally requires the
`production` environment's reviewer approval.)
(이후 dev 스택 변경은 이 리포의 `terraform.yml`로 — PR/push 시 자동 plan,
apply는 `plan_run_id`로 지정한 저장 plan만 dispatch로 실행. production과의
차이: 비공개 Free 플랜 리포는 environment를 쓸 수 없어 리뷰어 승인 게이트가
없고, dev apply의 통제는 저장-plan 고정 + 수동 dispatch 두 가지입니다.
production은 여기에 `production` environment 승인이 추가됩니다.)

These must be the DEV stack's files — never the production pair, which lives
only in the public repo's secrets.
(이 리포의 시크릿은 dev 스택 파일 전용 — production 것과 절대 섞지 않습니다.)

### 4. Grant the pin step's ECR permissions / ECR 권한

The deploy job re-points `:web-latest` at the approved `web-<sha>` before
rolling, so the deployer CI role needs `ecr:BatchGetImage` and
`ecr:PutImage`, scoped to the web ECR repository, in addition to the ECS/auth
permissions it already has.
(`ci-deployer` 역할에 web ECR 리포 스코프의 `ecr:BatchGetImage`·`ecr:PutImage`
권한을 추가합니다.)

## Verification / 확인

Push a trivial `web/**` change to `dev`: the run should build, pin, roll and
pass the smoke test end-to-end. (dev에 web 변경을 push해 빌드→pin→롤링→smoke가
끝까지 통과하는지 확인.)

## Promotion flow / 승격 흐름 (reference)

```bash
git push samples dev:release/$(date +%Y%m%d)   # short-lived public branch
gh pr create -R aws-samples/sample-awsops --base main --head "release/$(date +%Y%m%d)"
# merge → delete the release branch → dispatch Deploy Web on main
# (production-environment approval; the rollout pins the approved web-<sha>)
```
