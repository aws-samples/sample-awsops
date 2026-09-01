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

### 2. Extend the CI roles' GitHub OIDC trust / OIDC 신뢰 정책 확장

The four CI roles (`sample-awsops-ci-{build,deployer,terraform-plan,review}`,
in the samples deployment account) trust the GitHub OIDC provider with a
`sub` condition that matches only the public repo today. Add the private dev
repo's sub pattern to each role's trust policy condition:

```json
"Condition": {
  "StringLike": {
    "token.actions.githubusercontent.com:sub": [
      "repo:<PUBLIC_ORG>/<PUBLIC_REPO>:*",
      "repo:<PRIVATE_OWNER>/<PRIVATE_DEV_REPO>:*"
    ]
  }
}
```

The `AWS_CI_*_ROLE_ARN` repo variables are already present in the dev repo.
If the dev stack should live in a **different account** than production,
create equivalent roles there and point the dev repo's variables at those
instead — that also isolates dev/prod blast radius.
(CI 역할 4종의 신뢰 정책 `sub` 조건에 비공개 dev 리포 패턴을 추가합니다. 역할
ARN 변수는 dev 리포에 이미 복사돼 있습니다. dev 스택을 별도 계정에 둘 경우 그
계정에 동일 역할을 만들고 변수를 교체하면 되며, dev/prod 폭발반경 분리 효과도
있습니다.)

### 3. Provision the dev stack + set its TF secrets / dev 스택과 시크릿

Run `make configure` once FOR THE DEV STACK (its own state key and its own
dev domain/cert inputs), apply it, then store the generated files as the dev
repo's secrets:

```bash
gh secret set TF_BACKEND_HCL -R <PRIVATE_OWNER>/<PRIVATE_DEV_REPO> \
  --body "$(base64 -w0 terraform/foundation/backend.hcl)"
gh secret set TF_TFVARS -R <PRIVATE_OWNER>/<PRIVATE_DEV_REPO> \
  --body "$(base64 -w0 terraform/foundation/terraform.tfvars)"
```

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
gh pr create -R <PUBLIC_ORG>/<PUBLIC_REPO> --base main --head release/<date>
# merge → delete the release branch → dispatch Deploy Web on main (approval)
```
