# Branch strategy & deployment map / 브랜치 전략과 배포 맵

Related files / 관련 파일: `.github/workflows/{deploy-web,terraform,guard-main-prs}.yml`,
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
atomoh | ssminji | whchoi ──PR──▶ dev ──PR (guard: dev only)──▶ main
user stacks (standing)          dev stack               production stack
<user>.awsops-dev.whchoi.net    awsops-dev.whchoi.net   domain PENDING — deploy on the
(auto-deploy on push to                                 CloudFront default domain first,
 one's own branch)                                      then decide whether to attach
                                                        awsops.whchoi.net
```

**Five standing branches, five pipelines**: `main`, `dev`, and one branch per user
(`atomoh`, `ssminji`, `whchoi`). Each user's branch continuously deploys to that
user's own stack on push — a personal integration lane. Topic work happens on the
user's branch (or short-lived branches merged into it), then flows up via PR to
`dev` and on to `main`.
(상시 브랜치 5개 = 파이프라인 5개. 사용자 브랜치는 push 즉시 자기 스택으로 자동
배포되는 개인 통합 레인이며, 작업은 사용자 브랜치에서 → PR로 dev → main으로
승격됩니다.)

- `dev` is the **default branch** — PRs (internal and external) target it by default.
- `main` accepts PRs **only from `dev`**, enforced mechanically by
  `guard-main-prs.yml` on top of the `protect-main` ruleset (PR required, no
  force-push/deletion). `dev` carries the same ruleset protections.

## Branch flow / 브랜치 흐름

1. **User branch / 사용자 브랜치** — the standing branch named after the user
   (`atomoh`, `ssminji`, `whchoi`). Push = auto-deploy to
   `<user>.awsops-dev.whchoi.net`. When ready, PR into `dev`. PR checks:
   merge-verify + AI pr-review + terraform plan (when `terraform/foundation/**`
   changed; same-repo PRs only).
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

Fork PRs intentionally do **not** receive the canonical `AI Code Review` check; a
skipped job must not impersonate a completed review. A green test/CodeQL run alone
does not make a fork PR eligible to merge under the review policy.

Maintainer path:

1. Review the contributor's patch as data, especially workflow/build-hook changes,
   before putting it on a same-repository branch. Do not blindly mirror executable
   CI changes into a branch that can receive repository secrets.
2. Create a maintainer-owned topic branch and an internal PR targeting `dev`, linking
   the original fork PR. The trusted automatic review runs against the internal PR's
   exact HEAD; use the normal full AI/CI checks, not a recovery label.
3. Merge the internal PR only after those checks pass, then close the original fork
   PR with the integration link. A changed internal HEAD requires fresh review.

(외부 fork PR은 시크릿·OIDC 토큰을 받지 못해 배포/AWS 접근이 불가하고, plan 잡은
same-repo가 아니면 시작하지 않습니다. main 대상 PR은 head가 이 리포의 `dev`가 아니면
guard 체크가 실패합니다. 첫 기여자의 CI 실행은 관리자 승인 후에만 동작합니다.)

Fork PR에는 정식 `AI Code Review` 검사를 발행하지 않으므로 테스트·CodeQL 통과만으로
머지할 수 없습니다. 유지관리자는 패치, 특히 CI·빌드 훅 변경을 먼저 검토한 뒤 내부
토픽 브랜치와 `dev` 대상 PR을 만들고 원본 PR을 연결합니다. 내부 PR의 최신 HEAD가
전체 AI·CI 검사를 통과하면 그 PR을 머지하고 원본 fork PR에 통합 결과를 연결해
닫습니다. 이 경로에서 복구 라벨이나 검사 우회는 사용하지 않습니다.

## Domain / deployment map / 도메인·배포 맵

| Tier | Branch | Stack / domain | Deploy trigger |
|---|---|---|---|
| User | `atomoh` / `ssminji` / `whchoi` | that user's stack, `<user>.awsops-dev.whchoi.net` | auto on push (`deploy-web.yml`) |
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

The public hosted zone **`awsops-dev.whchoi.net` exists in the samples account**
(`Z05356393HGNKULJIZ69V`) — but ⚠️ **its NS delegation from the live `whchoi.net`
zone (owned by another account) is PENDING**. Until the domain owner adds this
record to the live parent zone, ACM validation for every stack under this zone
stalls and applies time out:

```
awsops-dev.whchoi.net  NS  ns-565.awsdns-06.net
                           ns-1465.awsdns-55.org
                           ns-12.awsdns-01.com
                           ns-1997.awsdns-57.co.uk
```
(라이브 whchoi.net 존 소유자가 위 NS 위임 레코드를 추가해야 이 존 아래 모든
스택의 ACM 검증이 통과합니다 — 1회성 공용 작업.) Previews are
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
4. Push to your branch — `deploy-web.yml` builds and rolls your stack
   automatically, and `terraform.yml` plans your stack on terraform-path pushes
   (apply = dispatch from your branch; `deploy-agentcore` likewise). Missing
   secrets fail with a pointer here — no fallback to the dev/production stacks,
   by design.

User-branch deploys run under the dev-tier roles (`environment: development`
gates which branches may deploy — its branch policy lists dev + the three user
branches); production stays behind the `production` environment approval. See
`dev-repo-setup.md` §2 for the role/trust matrix.

## Verification / 확인

- User PR → `dev`: merge-verify + AI review green; a fork PR shows no plan job.
- PR to `main` from anything but `dev`: `guard-main-prs` fails the PR.
- Push to `dev`: `deploy-web.yml` ends green, smoke against
  `awsops-dev.whchoi.net/api/health`.
- `dev → main` merge, then production dispatch: waits for the `production`
  environment approval, smokes against the `public_url` output.
