# Branch strategy & deployment map / 브랜치 전략과 배포 맵

Related files / 관련 파일: `.github/workflows/{deploy-web,deploy-preview,terraform,guard-main-prs}.yml`,
`docs/runbooks/dev-repo-setup.md` (CI/OIDC bring-up)

## The shape / 전체 구조 — single public repo / 단일 공개 리포

Everything lives in **`aws-samples/sample-awsops`** (public). All branches are publicly
readable — that is accepted by design: the tree carries only public-safe content (the
private upstream repo keeps internal docs/history), so an in-flight branch exposes
nothing main wouldn't. **Never push content that must stay private; a pushed commit is
permanently retrievable via PR refs even after branch deletion.**
(모든 것이 공개 리포 `aws-samples/sample-awsops` 하나에 있습니다. 모든 브랜치가 공개
열람 가능하다는 점은 의도된 수용입니다 — 트리는 공개-안전 콘텐츠만 담고, 내부 문서·
히스토리는 비공개 upstream 리포에 남습니다. 비공개여야 하는 내용은 절대 push 금지 —
push된 커밋은 브랜치를 지워도 PR ref로 영구 조회됩니다.)

```
<user>/<topic> ──PR──▶ dev ──PR (guard: dev only)──▶ main
preview stack           dev stack                      production stack
<user>.awsops-dev.      awsops-dev.whchoi.net          domain PENDING — deploy on the
whchoi.net                                             CloudFront default domain first,
                                                       then decide whether to attach
                                                       awsops.whchoi.net
```

- `dev` is the **default branch** — PRs (internal and external) target it by default.
- `main` accepts PRs **only from `dev`**, enforced mechanically by
  `guard-main-prs.yml` on top of the `protect-main` ruleset (PR required, no
  force-push/deletion). `dev` carries the same ruleset protections.

## Branch flow / 브랜치 흐름

1. **User branch / 사용자 브랜치** — `<user>/<topic>` (e.g. `whchoi/fix-eks-panel`),
   PR into `dev`. PR checks: merge-verify + AI pr-review + terraform plan (when
   `terraform/foundation/**` changed; same-repo PRs only).
2. **`dev`** — integration branch; every push auto-deploys the DEV stack
   (`awsops-dev.whchoi.net`) via `deploy-web.yml` (build → pin → roll → smoke).
3. **`main`** — promotion PR `dev → main` (ordinary same-repo PR). The production
   ECS roll stays workflow_dispatch + `production` environment reviewer approval;
   terraform apply likewise (saved-plan, dispatch, per-branch environment).

## External (fork) PRs / 외부 PR

- Anyone may fork and open a PR; the default branch makes `dev` the natural target,
  and `guard-main-prs` hard-fails any main-targeted PR whose head is not this repo's
  own `dev` branch.
- Fork PR runs get **no secrets and no OIDC id-token** (GitHub policy) — they can
  never deploy or touch AWS. `terraform.yml`'s plan additionally refuses to start
  for non-same-repo PRs. Keep the Actions setting "Require approval for first-time
  contributors" so unknown contributors' runs need a maintainer click.
- PR content and review text are untrusted data for CI and AI review alike.

(외부 fork PR은 시크릿·OIDC 토큰을 받지 못해 배포/AWS 접근이 불가하고, plan 잡은
same-repo가 아니면 시작하지 않습니다. main 대상 PR은 head가 이 리포의 `dev`가 아니면
guard 체크가 실패합니다. 첫 기여자의 CI 실행은 관리자 승인 후에만 동작합니다.)

## Domain / deployment map / 도메인·배포 맵

| Tier | Branch | Stack / domain | Deploy trigger |
|---|---|---|---|
| Preview | `<user>/<topic>` | per-user stack, `<user>.awsops-dev.whchoi.net` | `deploy-preview.yml` dispatch (input: `user`; write access required) |
| Dev | `dev` | dev stack, `awsops-dev.whchoi.net` | auto on push (`deploy-web.yml`) |
| Production | `main` | production stack — **domain not attached yet** | dispatch + `production` environment approval |

### Production domain decision / 프로덕션 도메인 결정 (PENDING)

Provision and deploy the production stack **without a custom domain first** — it
serves on its CloudFront default domain (the `public_url` terraform output; every
workflow smoke-tests that output, so attaching a domain later changes no CI). After
reviewing the deployed distribution, decide whether to attach `awsops.whchoi.net`:

- `awsops.whchoi.net` is **currently in use by an existing deployment** — attaching
  it here is a cutover decision for the domain's owner, not a default.
- Attaching later = tfvars domain + ACM cert (us-east-1 for CloudFront) + alias →
  `terraform plan` / dispatch apply. Nothing else moves; `public_url` follows.

(프로덕션은 우선 도메인 없이 배포해 CloudFront 기본 도메인(`public_url`)으로 확인한 뒤
`awsops.whchoi.net` 부착 여부를 결정합니다 — 현재 다른 배포가 사용 중인 도메인이므로
부착은 소유자의 컷오버 결정입니다. 부착 = tfvars 도메인 + us-east-1 ACM + alias →
plan/apply.)

## Per-user preview stacks / 사용자별 프리뷰 스택

The public hosted zone **`awsops-dev.whchoi.net` already exists** (operator-managed;
not in the workload account's Route53 — stacks reference it via tfvars). Previews are
`<user>.awsops-dev.whchoi.net`, so one **wildcard ACM cert `*.awsops-dev.whchoi.net`**
(us-east-1) covers every preview AND the dev stack — issue once, reuse across stacks.
(`awsops-dev.whchoi.net` 퍼블릭 호스티드 존은 이미 존재하며, 프리뷰가 그 아래 서브도메인
계층이라 **와일드카드 ACM 한 장**으로 dev와 모든 프리뷰를 커버합니다.)

Provision once per user:

1. `make configure` — own tfstate key, domain `<user>.awsops-dev.whchoi.net`.
2. `terraform plan -out tfplan` → review → `terraform apply tfplan` (never
   `-auto-approve`).
3. Register secrets (uppercased user):
   ```bash
   gh secret set TF_BACKEND_HCL_PREVIEW_<USER> -R aws-samples/sample-awsops \
     --body "$(base64 -w0 terraform/foundation/backend.hcl)"
   gh secret set TF_TFVARS_PREVIEW_<USER> -R aws-samples/sample-awsops \
     --body "$(base64 -w0 terraform/foundation/terraform.tfvars)"
   ```
4. Actions → **Deploy Preview** → run from the branch with input `user` (lowercase).
   Missing secrets fail with a pointer here — no fallback to dev/production stacks.
   Dispatch requires repo write access, so external users cannot trigger previews.

Preview deploys use the dedicated any-branch preview role (permissions scoped to
preview-stack resources only); the dev/production deployer roles' trust is pinned to
their own branch refs — see `dev-repo-setup.md` §2 for the role/trust matrix.

## Verification / 확인

- User PR → `dev`: merge-verify + AI review green; a fork PR shows no plan job.
- PR to `main` from anything but `dev`: `guard-main-prs` fails the PR.
- Push to `dev`: `deploy-web.yml` ends green, smoke against
  `awsops-dev.whchoi.net/api/health`.
- `dev → main` merge, then production dispatch: waits for the `production`
  environment approval, smokes against the `public_url` output.
