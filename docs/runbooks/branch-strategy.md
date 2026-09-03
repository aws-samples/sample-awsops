# Branch strategy & deployment map / 브랜치 전략과 배포 맵

Related files / 관련 파일: `.github/workflows/{deploy-web,deploy-preview,terraform}.yml`,
`docs/runbooks/dev-repo-setup.md`

## The shape / 전체 구조

```
(private) Atom-oh/sample-awsops-dev            (public) aws-samples/sample-awsops
┌────────────────────────────────────┐         ┌──────────────────────────┐
│ <user>/<topic> ──PR──▶ dev         │──push──▶│ release/YYYYMMDD ──PR──▶ main │
└────────────────────────────────────┘         └──────────────────────────┘
  preview stack        dev stack                    production stack
  <user>-awsops.dev.   awsops.dev.whchoi.net        domain PENDING — deploy on the
  whchoi.net                                        CloudFront default domain first,
                                                    then decide whether to attach
                                                    awsops.whchoi.net
```

- **Visibility / 공개 범위**: only the public repo's `main` is public. Every other branch —
  user branches, `dev`, in-flight work — lives in the private dev repo and is never pushed
  to the public repo as a branch (only squashed/release content ever crosses; PR refs on a
  public repo are permanently retrievable).
  (공개되는 것은 공개 리포의 `main`뿐입니다. 사용자 브랜치·`dev`·진행 중 작업은 전부 비공개
  dev 리포에만 존재하며, 브랜치째 공개 리포로 push하지 않습니다.)

## Branch flow / 브랜치 흐름

1. **User branch / 사용자 브랜치** — name it `<user>/<topic>` (e.g. `whchoi/fix-eks-panel`).
   Push to the private dev repo and open a **PR into `dev`**. PR checks (merge-verify,
   AI pr-review) run on PRs targeting `dev`.
2. **`dev`** — the integration branch. Every push auto-deploys to the DEV stack
   (`awsops.dev.whchoi.net`) via `deploy-web.yml` (build → pin → roll → smoke).
3. **`main` (public)** — promote with a short-lived release branch:
   ```bash
   git push samples dev:release/$(date +%Y%m%d)
   gh pr create -R aws-samples/sample-awsops --base main --head "release/$(date +%Y%m%d)"
   # merge → delete the release branch → production deploy is dispatch + reviewer approval
   ```
   `main` accepts changes **only via PR** (ruleset `protect-main`: PR required,
   no force-push/deletion).

## Domain / deployment map / 도메인·배포 맵

| Tier | Branch | Stack / domain | Deploy trigger |
|---|---|---|---|
| Preview | `<user>/<topic>` | per-user stack, `<user>-awsops.dev.whchoi.net` | `deploy-preview.yml` workflow_dispatch (input: `user`) |
| Dev | `dev` | dev stack, `awsops.dev.whchoi.net` | auto on push (`deploy-web.yml`) |
| Production | `main` (public repo) | production stack — **domain not attached yet** | dispatch + `production` environment approval |

### Production domain decision / 프로덕션 도메인 결정 (PENDING)

Provision and deploy the production stack **without a custom domain first** — the stack
serves on its CloudFront default domain (`dxxxxxxxxxxxxx.cloudfront.net`, the
`public_url` terraform output; every workflow smoke-tests against that output, so no
workflow change is needed when a domain is attached later). After reviewing the deployed
CloudFront distribution, decide whether to attach `awsops.whchoi.net`:

- `awsops.whchoi.net` is **currently in use by an existing deployment** — attaching it
  here is a cutover decision for the domain's owner, not a default.
- Attaching later = tfvars domain change + ACM cert (us-east-1 for CloudFront) + alias →
  `terraform plan`/dispatch apply. Nothing else moves; `public_url` follows automatically.

(프로덕션 스택은 우선 커스텀 도메인 없이 프로비저닝·배포합니다 — CloudFront 기본 도메인
(`public_url` output)으로 서비스되며, 모든 워크플로 스모크가 그 output을 쓰므로 도메인을
나중에 붙여도 워크플로 변경이 없습니다. 배포된 CloudFront를 확인한 뒤
`awsops.whchoi.net` 부착 여부를 결정하세요 — 이 도메인은 현재 다른 배포가 사용 중이므로
부착은 도메인 소유자의 컷오버 결정입니다. 부착 = tfvars 도메인 + us-east-1 ACM + alias
→ plan/apply.)

## Per-user preview stacks / 사용자별 프리뷰 스택

A preview is a full (small) stack per user, provisioned once:

1. `make configure` for the user's stack — its own tfstate key, domain
   `<user>-awsops.dev.whchoi.net`.
2. `terraform plan -out tfplan` → review → `terraform apply tfplan` (never
   `-auto-approve`).
3. Register the generated files as repo secrets, uppercased user in the name:
   ```bash
   gh secret set TF_BACKEND_HCL_PREVIEW_<USER> -R Atom-oh/sample-awsops-dev \
     --body "$(base64 -w0 terraform/foundation/backend.hcl)"
   gh secret set TF_TFVARS_PREVIEW_<USER> -R Atom-oh/sample-awsops-dev \
     --body "$(base64 -w0 terraform/foundation/terraform.tfvars)"
   ```
4. Deploy any branch to it: Actions → **Deploy Preview** → run from the branch, input
   `user` (lowercase; the workflow uppercases it to pick the secrets). Missing secrets
   fail with a pointer here, never fall back to another stack.

The dev-scoped CI roles must cover preview stacks too — scope them to the dev AND
preview resource name patterns (see `dev-repo-setup.md` §2), never to production.
(dev 전용 CI 역할의 리소스 스코프는 dev와 preview 스택 이름 패턴까지 포함해야 하며,
production은 절대 포함하지 않습니다.)

## Verification / 확인

- User PR → `dev`: merge-verify + AI review run and pass on the PR.
- Push to `dev`: `deploy-web.yml` run ends green with the smoke against
  `awsops.dev.whchoi.net/api/health`.
- Promotion: release PR merges into public `main`; production deploy waits for the
  `production` environment approval and smokes against the `public_url` output.
