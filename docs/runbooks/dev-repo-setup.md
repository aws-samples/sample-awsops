# Private dev repo bring-up / 비공개 dev 리포 활성화

> This repo (`Atom-oh/sample-awsops-dev`) is the private development home for
> the public `aws-samples/sample-awsops`. Its `dev` branch continuously
> deploys to the DEVELOPMENT stack (`awsops.dev.whchoi.net`). The pipeline is
> already wired; the four items below are one-time account/infra steps that
> CI cannot do for itself. Until they are done, dev CI runs will queue
> (no runner) or fail at the auth/restore steps.
>
> 이 리포는 공개 `aws-samples/sample-awsops`의 비공개 개발 본진입니다. `dev`
> 브랜치는 개발 스택(`awsops.dev.whchoi.net`)에 자동 배포됩니다. 파이프라인은
> 이미 구성돼 있고, 아래 4개 항목만 1회성 계정/인프라 작업으로 남아 있습니다.

## 1. Self-hosted runner / 러너 등록

The workflows use `runs-on: sample-awsops`. That runner is currently
registered to the public repo only — register it (or its runner group) to
this repo too, from the samples-account runner platform.
(워크플로가 `sample-awsops` 라벨 러너를 사용합니다. 현재 공개 리포에만 등록돼
있으므로 이 리포에도 등록해야 합니다.)

## 2. GitHub OIDC trust on the CI roles / OIDC 신뢰 정책

The four CI roles in account `061525506239`
(`sample-awsops-ci-{build,deployer,terraform-plan,review}`) trust the GitHub
OIDC provider with a `sub` condition that today only matches
`repo:aws-samples/sample-awsops:*`. Runs from THIS repo present
`repo:Atom-oh/sample-awsops-dev:*` and will fail `AssumeRoleWithWebIdentity`
until each role's trust policy condition also allows it, e.g.:

```json
"Condition": {
  "StringLike": {
    "token.actions.githubusercontent.com:sub": [
      "repo:aws-samples/sample-awsops:*",
      "repo:Atom-oh/sample-awsops-dev:*"
    ]
  }
}
```

(계정 `061525506239`의 CI 역할 4종 신뢰 정책 `sub` 조건에
`repo:Atom-oh/sample-awsops-dev:*`를 추가해야 이 리포의 런이
AssumeRoleWithWebIdentity를 통과합니다.)

The `AWS_CI_*_ROLE_ARN` repo variables are already copied to this repo.
(역할 ARN 변수 4종은 이 리포에 이미 복사돼 있습니다.)

If the dev stack should live in a DIFFERENT account than production, create
equivalent roles there instead and point this repo's variables at them —
that also gives dev/prod blast-radius isolation.
(dev 스택을 별도 계정에 둘 경우, 그 계정에 동일 역할을 만들고 이 리포의 변수를
그 ARN으로 바꾸면 됩니다 — dev/prod 폭발반경 분리 효과도 있습니다.)

## 3. Dev stack + TF secrets / dev 스택과 시크릿

Run `make configure` once FOR THE DEV STACK (its own state key, its own
`awsops.dev.whchoi.net` domain/cert inputs), `terraform plan`/`apply` it,
then store the generated files in THIS repo's secrets:

```bash
gh secret set TF_BACKEND_HCL -R Atom-oh/sample-awsops-dev \
  --body "$(base64 -w0 terraform/foundation/backend.hcl)"
gh secret set TF_TFVARS -R Atom-oh/sample-awsops-dev \
  --body "$(base64 -w0 terraform/foundation/terraform.tfvars)"
```

These are the DEV stack's files — never the production pair (which lives
only in the public repo's secrets).
(이 리포의 시크릿은 dev 스택 파일 전용입니다 — production 것과 절대 섞지 않음.)

## 4. ECR permissions for the pin step / ci-deployer ECR 권한

The deploy job re-points `:web-latest` at the approved `web-<sha>` before
rolling. `sample-awsops-ci-deployer` therefore needs, scoped to the web ECR
repository: `ecr:BatchGetImage`, `ecr:PutImage` (plus the auth-token action
it already has for login).
(`ci-deployer` 역할에 web ECR 리포 스코프의 `ecr:BatchGetImage`·`ecr:PutImage`
권한이 필요합니다.)

## Promotion flow / 승격 흐름 (reference)

```bash
git push samples dev:release/$(date +%Y%m%d)   # short-lived public branch
gh pr create -R aws-samples/sample-awsops --base main --head release/<date>
# merge → delete the release branch → dispatch Deploy Web on main (approval)
```
