# Scripts

## Role
Deployment/ops automation behind the Makefile targets (`v2/`), plus the PR review panel
(`pr-review/`). Node deps live in `scripts/v2/package.json` (pg, @inquirer/prompts,
secrets-manager) — installed by `make deps`.

## Key Files
- `v2/configure.mjs` — `make configure`: interactive TUI → `terraform.tfvars` + `backend.hcl`.
  AWS access shells out to the `aws` CLI, not the SDK.
- `v2/deploy.mjs` — `make deploy` (runs migrate first): arm64 build → ECR push →
  ECS force-new-deployment → wait stable → smoke `/api/health`. `deployment-smoke.mjs`
  preserves service Host/SNI/TLS via CloudFront `--connect-to` before service DNS publication.
  The `DOCKER` env defaults to `sudo docker`.
- `v2/ci_dns_policy.py` — reads Terraform state to preserve managed certificate ownership
  (JSON null) and existing service aliases; verifies operator-selected/attached certificates
  without account-wide selection. Redacts public summaries. Blocks all Route53/Cloud Map
  mutations when DNS is prohibited (including private DNS, validation and registered ECS).
  Routine CI always blocks managed-certificate externalization and owned validation-CNAME
  retirement/replacement, regardless of DNS permission.
- `v2/ci_dev_domain.py` — dev repo names/mode plus explicit `domain_rollout` dispatch input.
  Generates gitignored `ci-domain.auto.tfvars.json` for console/plan; the workflow rejects
  tracked overrides. `ci_domain_rollout` is declared default-false metadata in the saved plan:
  only true dev/full plans narrow DNS to configured A/ACM CNAME owners in the selected zone.
  Ordinary full plans retain broad DNS behavior with explicit permission. Apply reads only
  the saved marker. Dev advisory preflight preserves ownership from state without live
  certificate validation; advisory DNS allowance is reporting only.
- `v2/ci_plan_context.py` — accepts only successful explicit Terraform plan dispatches from
  the exact deployment repository, branch and SHA; PR/push plans are advisory.
- `v2/test_ci_{dev_domain,dns_policy,plan_context,deployment_workflows,terraform_reads}.py` —
  workflow fixtures, real no-provider plans and a localhost state backend verify deployment
  gates without AWS calls. From repo root: `python3 -m pytest -q scripts/v2/test_ci_*.py`.
  Summaries allow certificate suffixes/publication/change counts and addresses, plus active
  rollout's public zone name/ID/NS; never raw configuration, ARNs, account IDs, state or plans.
- `v2/terraform-test.sh` — Terraform 1.15.7 validate/mock tests in a disposable tracked-file
  copy, `init -backend=false`, fresh data dir, no deployment credentials or real backend.
  `v2/requirements-test.txt` declares pytest/PyYAML; the shared merge script runs Node smoke tests.
- `v2/workers.mjs` — `make workers`: builds and pushes the worker image **only**. The Fargate
  worker is not an ECS service — SFN `RunTask` pulls `:worker-latest` at job time. Short jobs
  deploy as Lambda zips and need no image. Run after applying with `workers_enabled=true`.
- `v2/migrate.mjs` + `migrate-core.mjs` — `make migrate`: advisory-lock, checksum, stamps the
  release version from the `-- since:` header. `DRY_RUN=1` previews; `--status` gives an
  offline summary. Credentials come from `terraform output aurora_secret_arn` → Secrets
  Manager (collision-free, fail-loud migration runner).
- `v2/agentcore.mjs` + `agentcore/` — `make agentcore`: arm64 agent image + idempotent
  provisioner, writes to SSM.
- `v2/*.itest.mjs` — migration integration tests against a disposable PostgreSQL 17 container.
- `v2/upgrade.sh` — `make upgrade`: RDS snapshot → migrate → deploy. Previews unless
  `CONFIRM=go`.
- `pr-review/` — lens×model review panel: `run-panel.sh` (parallel fan-out, one `*.txt` prompt
  per lens), `synthesize.sh` (chair synthesis), `lib.sh` (slot/credential scrubbing).
  `review_context.py` pins the trusted CI checkout and reviewed PR/base metadata.
  `v2/ci_review_access.py` produces the protected-environment/IAM trust plan without API writes.
  - **Every Claude panel/chair call MUST pass `--strict-mcp-config`.** A user-scope MCP server (e.g. github)
    loads at session init; if its auth is broken, `claude -p` waits silently for the tool until
    `CHAIR_TIMEOUT` (currently 900s) with no error — killing both primary and fallback chairs
    and failing the gate regardless of the diff (observed: PR #194/#197/#202/#203).
    `--allowedTools` is a permission allowlist and does not stop MCP loading, so it is not a
    substitute.

## Migration Filename Rule
- `terraform/foundation/migrations/<ULID>_<snake_name>.sql`
- ULID = 26-char Crockford base32 — **no I, L, O, U** (`/^[0-9A-HJKMNP-TV-Z]{26}$/i`).
  Hand-numbered (integer) ids are rejected by the runner; only ULID filenames are accepted.
- Duplicate ids fail loud before connecting; sort order is lexical (which is also time order
  for ULIDs).

## Rules
- Scripts assume they run from the repo root (they resolve resource addresses via
  `terraform -chdir=terraform/foundation output`) — prefer the Makefile targets over running
  scripts directly.
- For the emergency IAM `put-role-policy` convention, see `terraform/CLAUDE.md`.
