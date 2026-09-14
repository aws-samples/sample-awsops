<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 38c635d6d51e · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# AWSops — Reviewer Context

**v2 is live on `main`** (Terraform · ECS Fargate · Aurora · AgentCore agents · async workers). v1.8.0 (`src/`, CDK/EC2/Steampipe, `/awsops` basePath) is decommissioned per ADR-016 — its code left the tree 2026-07-12 (`git tag v1-pre-code-removal-20260712`); AWS teardown Phase 4.1-4.3 (CFN stack `AwsopsStack`, ALB/SQS) is complete (2026-08-25), Phase 4.4/4.5 (orphan Lambdas, AgentCore gateways/Memory/Interpreter, deploy bucket) is UNCONFIRMED as of 2026-08-27 pending a re-run against a corrected 21-name list — see `docs/runbooks/v1-decommission.md` §Phase 4. v1 rules do NOT apply to v2. A diff under `web/`, `terraform/`, `agent/`, or `scripts/v2/` is v2.

**ADR numbering:** ADR bodies (001–021 + the BASELINE register) live in the private upstream repository, not in this public tree — docs here cite ADR numbers for traceability only.

## ⛔ Product posture (ADR bodies maintained in the private upstream repo)
v2 = ops dashboard + AI diagnosis. **Current form = diagnosis + remediation *proposal* (read-only).**
- **FROZEN (do-not-enable, ADR-005):** AWS-resource mutation + autonomy (remediation substrate, arbitrary BYO-MCP, mutating tools). Unfreezing is **not a doc cleanup** — it needs a NEW ADR + multi-AI panel + a dated owner-override, full stop. Frozen substrate is retained **dark code** (regression = *enabling* it, not its presence).
  - **One granted exception: ADR-015** (`secret_rotation_redeploy_enabled`, default-off, owner-override 2026-07-01) — exactly one call: `ecs:UpdateService(forceNewDeployment)` restarting the host's own web service on its own Aurora master-secret rotation event (same image/task-def — not a code deploy), IAM scoped to one service ARN, secret-id fail-closed (`terraform/foundation/secret-rotation.tf`). Do NOT flag this specific path; any OTHER mutating/autonomous path is still a FROZEN violation. (ADR-019's SG-rules Athena role is NOT an ADR-005 exception — ADR-019 §Decision concludes it sits inside the existing read-only invariant and needs no relaxation at all; `sg_rule_activity_enabled` is an ordinary GATED entry, not a FROZEN carve-out.)
- **GATED analysis-only (ADR-006):** incident lifecycle / RCA write-back / K8sGPT — read-only triage/RCA, no autonomous mitigation; flags default OFF.
- **External DATA is NOT the freeze (ADR-007, keystone):** external observability read + governed external write are allowed under governance; curated connectors only (arbitrary `custom_mcp` dropped). `diagnosis_notify_enabled` (SNS email) is the **one LIVE external write**; broad `integrations_write_enabled` stays GATED-OFF. Curated official MCP presets = ADR-017 (vendor-hosted 3 only, runtime fail-closed tool allowlist, GATED; ClickHouse stdio embed FROZEN).
- **🚩 Flag any PR that enables mutation/autonomy/BYO-MCP** — flips a frozen flag or wires the dark substrate live.

## Stack / runtime
- **Web:** Next.js 14 thin-BFF (`web/`), standalone **arm64**, root path `/` — no basePath. Fetch is `/api/*` (never `/awsops/api/*`). Heavy/long/OOM work is enqueued to the worker tier — BUT the generic `POST /api/jobs` accepts **only allowlisted noop job types**; domain jobs (`report`, `compliance`, etc.) are submitted only via their ownership-checked dedicated routes (`/api/diagnosis`, `/api/compliance/run` — IDOR fix, PR #195/ADR-009).
- **Data:** Aurora Serverless v2 (PG 17.9) via node-pg (`web/lib/db.ts`, shared `getPool`). App state in Aurora, **not `data/*.json`** (v1 pattern). Schema = `terraform/foundation/data/schema.sql` + ULID migrations (`migrations/<ULID>_*.sql`, never append to schema.sql — a migration's `-- since:` header is checksum-immutable once merged, never retag it).
- **IaC:** Terraform only (CDK dropped). Single root `terraform/foundation/`, partial S3 backend (`backend.hcl`, no DynamoDB), TF ≥1.15, provider `~>6.0`.
- **Edge:** CloudFront(TLS) → VPC Origin `https-only:443` → internal ALB HTTPS:443 (regional ACM) → HTTP → Fargate `awsops-v2-web:3000`. **No public ALB.** ALB SG allows 443 from `CloudFront-VPCOrigins-Service-SG` (VPC-CIDR-only → 504).
- **AI:** Bedrock Sonnet 5 / Opus 4.8 / Haiku 4.5 + AgentCore (Strands, `agent/agent.py`, routes via `GATEWAYS_JSON`). Live AWS queries via AgentCore MCP Lambda tools (`agent/lambda/*.py`), never inline in the BFF. Config source of truth = SSM `/ops/awsops-v2/agentcore/{runtime_arn,interpreter_id,memory_id}` (runtime read; no ECS `valueFrom`).
- **Chat routing (LIVE):** regex fast-path (`web/lib/route.ts`, first-match-wins RULES) → Haiku classifier fallback; gated by `hybrid_routing_enabled`. **16 routing keys are registered** = 9 gateway-routed sections + `aws-data` + 6 auto-collect collectors (`web/lib/collectors/`); the latter 7 are web-BFF-local (not via AgentCore) and their Steampipe-backed execution is hard-disabled — they fail-open to normal routing at runtime.
- **Async workers (P2):** enqueue → `worker_jobs` + SQS → ESM (kill-switch) → dispatcher Lambda (idempotent on job_id) → Step Functions → RunLambda (short) or `ecs:runTask.sync` Fargate (long/OOM) → worker writes running/succeeded itself → status_updater on Catch sets failed (SFN can't write VPC Aurora) → reaper (5min) reconciles stale. Files: `terraform/foundation/workers.tf`, `scripts/v2/workers/`.

## Build · Test · Lint (copy-paste; do not invent)
```bash
# v2 web (cwd = web/) — scripts: dev / build / start / test (no lint script)
cd web && npm ci && npm run build       # next build (standalone)
cd web && npx vitest run                 # web test suite (vitest)

# Required database CI tests (repo root; no AWS credentials/OIDC)
npm ci --prefix web
npm ci --prefix scripts/v2 --ignore-scripts --no-audit --no-fund
node --test scripts/v2/ci/*.test.mjs
node --test scripts/v2/ci/migration.itest.mjs scripts/v2/ci/web-db-connection.itest.mjs

# agent (Python)
cd agent && python3 -m pytest test_agent.py test_readiness.py -q

# Terraform (controller runs apply on shared infra; agents do NOT auto-approve)
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation validate
terraform -chdir=terraform/foundation plan -out tfplan   # controller runs `apply tfplan`

# Makefile
make migrate     # CLI/private-host migrations + reader sync, before make agentcore
make deploy      # migrate → buildx arm64 → ECR push → ECS roll → wait stable → smoke /api/health
make agentcore   # arm64 agent image + idempotent AgentCore provisioner (MCP Lambda code ships via terraform apply, NOT this)
make workers     # arm64 worker image push (after apply with workers_enabled=true)
```
Dev Deploy AgentCore runs reusable private `deploy-migrations.yml` before its split build/provision phases. It requires `CI_MIGRATIONS_ENABLED_DEV=true` and applied `ci_migrations_enabled=true` with a non-null `migration_job` output before dispatch. Main/preview and direct private-host CLI retain `make migrate`
before `make agentcore`. Migrations and reader password sync always precede AgentCore provisioning. Private migration offline `scripts/v2/ci/*.test.mjs` fixtures require locked Node dependencies, Python PyYAML and boto3/botocore (`pip install -r agent/requirements.txt`), and Terraform
1.15.7; runtime/controller/workflow and mock-plan checks make no AWS calls. Both `scripts/v2/ci/migration.itest.mjs` and `scripts/v2/ci/web-db-connection.itest.mjs` require bare `docker` on PATH, a reachable daemon and OpenSSL, with no automatic `sudo`/`DOCKER` override. The web connection-phase suite
additionally uses the locked web driver and TypeScript dependencies. Both PostgreSQL suites are fail-hard exceptions to legacy optional `scripts/v2/*.itest.mjs`; missing Docker is never a skip.

No repo-root `package.json` — the only one outside `web/`/`docs-site/` is `scripts/v2/package.json` (`make deps` runs `npm ci --prefix scripts/v2`). `next build` fails on app-level type errors but `*.test.ts(x)` type noise is non-blocking.

## BANNED PATTERNS (enforce in review)
- **AWS security:** no `0.0.0.0/0` ingress; no IAM `Principal:"*"`/wildcard-action without scoped condition; **no secrets in env/code/IaC** (Secrets Manager / SSM).
- **Cognito:** `selfSignUpEnabled`/self-signup must stay closed (`allow_admin_create_user_only = true`); admin-create + `admin_only` account recovery is the ratified model.
- **No AWS-resource mutation or autonomy** — frozen (see posture). Flag any PR that revives it.
- **SG `description` is immutable** — changing it forces a replace that hangs on the attached ALB; ingress changes in-place only.
- **arm64 required** for web/agent/worker images (`buildx --platform linux/arm64`).
- **`HOSTNAME=0.0.0.0` must be a runtime env** (task-def `environment`) for Next standalone — image ENV is insufficient (ECS overwrites → health check UNHEALTHY).
- **Fargate worker Dockerfiles use `CMD`, not exec-form `ENTRYPOINT`** (SFN `containerOverrides.command` appends to ENTRYPOINT → argv doubles).
- **Where ECS `secrets`/`valueFrom` is used (e.g. optional Steampipe), execution-role permissions are required**, otherwise `ResourceInitializationError`. The web pool instead uses task-role `rds-db:connect` as `awsops_web`; it receives no Aurora master password.
- **No `-auto-approve` on shared infra** — saved `tfplan` only; long applies run by the controller.
- **Flag-gate large new features** (`agentcore_enabled`, `workers_enabled`, `steampipe_enabled`, `hybrid_routing_enabled`, `finops_baseline_enabled` — default false → `plan` = No changes, $0).

## Naming / conventions
- Components `export default`. Resources `awsops-v2-*`; gateways `awsops-v2-{key}-gateway`; SSM under `/ops/awsops-v2/...` (`aws...` prefix is SSM-reserved).
- Admin authority = Cognito admin group OR SSM email allowlist (`web/lib/admin.ts`, fail-closed) — NOT v1 `data/config.json` `adminEmails`.
- Edge auth = Cognito + Lambda@Edge **RS256 JWKS** + iss/aud/token_use + OAuth `state` + PKCE public client. Primary login = self-hosted `/login` + `POST /api/auth/login` (unsigned public `InitiateAuth USER_PASSWORD_AUTH`; ADR-002[legacy 042]); Hosted-UI `/_callback` is a dark fallback. Server-side logout = Aurora `session_revocations` (LIVE control, PR #199 — BFF-side check; edge is JWT-only). Ownership converges on the immutable Cognito `sub` (#203); `legacy_email_owner_match` (**default true — currently ON live**, ECS taskdef env) is a migration-window switch, not a feature gate — it lets legacy email-keyed ownership rows still resolve (read + report PATCH/DELETE, via `matchesIdentity()`) while the sub-migration is in flight. Do not flag legacy email-keyed matching code as violating the sub-only invariant, and never approve flipping this to `false` without a completed `--apply` (not just a clean plan) confirming zero remaining legacy rows.

## Review checklist
1. **Posture:** no mutation/autonomy enabled (ADR-005); external write must satisfy ADR-007 governance; current truth = BASELINE.md.
2. **Edge/auth — two layers, only one is per-route optional:** *authentication* terminates at the CloudFront Lambda@Edge (RS256/`iss`/`aud`/`token_use`; public-path allowlist lives in `terraform/foundation/edge-lambda/cognito_edge.py.tftpl` — currently 11 exact matches (`/api/health`, `/api/auth/signout`, `/login`, `/api/auth/login`, `/icon.svg`, `/api/incidents/webhook` [ADR-013 machine-ingress carve-out, HMAC-SHA256/SNS-verified], and 5 PWA static assets `/manifest.webmanifest`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, `/icon-512-maskable.png`) + a `/_next/static/*` prefix, and any OTHER addition is itself flag-worthy). *Authorization, ownership (`sub`) and session revocation are BFF-side only* (ADR-002 §2-4) → RS256 verification intact (no decode-only regression); `verifyUser()` present on every data-returning/billable route outside the three enumerated carve-outs (`/api/db`, `/api/stream`, `/api/incidents/webhook`); `session_revocations` check not removed; ownership keyed on `sub`.
3. **Thin-BFF:** heavy work enqueued (domain jobs via their dedicated ownership-checked routes, never generic `/api/jobs`); Aurora via `getPool`; AgentCore ARNs from SSM; admin via `web/lib/admin.ts`.
4. **Terraform:** under `terraform/foundation/`; flag-gated; SG description unchanged; no `0.0.0.0/0` / `Principal:*`; no `-auto-approve`.
5. **Containers:** arm64; `HOSTNAME=0.0.0.0` runtime env; worker `CMD`; health path `/api/health` everywhere.
6. **v2 vs v1:** fetch `/api/*`; state in Aurora; new tables as ULID migration files.
7. **Routing:** golden-routing fixture labels must match `route.ts` RULES order (first-match-wins); `observability` chat key must resolve to a real gateway at runtime.

## Do-not-"fix" traps (real bugs that look wrong, and aren't)
- **Gateway key-derivation mismatch (`agent/agent.py:_resolve_gateway_key`):** `_discover_gateways` derives keys via `name.replace("awsops-","").replace("-gateway","")`, so `awsops-v2-external-obs-gateway` yields `v2-external-obs` — but the `GATEWAYS_JSON` env fallback and the `observability`→`external-obs` alias use the canonical `external-obs` (no `v2-` prefix). `_resolve_gateway_key` tries BOTH the canonical key and the `v2-` variant on purpose (coexistence shim across the two key-naming paths); do not "simplify" it to a single lookup — that reopens the exact silent-fallback-to-`ops` bug the shim fixed.
- **Cross-account self-assume trap (`agent/agent.py`/`cross_account.py`):** v2 is single-account, but if chat picks the host account, the agent used to force `target_account_id=<host>` and then self-assume `AWSopsReadOnlyRole` — a role that only exists in v1 *target* accounts, not the host — causing an `AccessDenied` the agent misdiagnosed as "cross-account blocked." `cross_account.get_role_arn()` now returns `None` when the target is the host (use the exec role directly instead). Do not "fix" this back to assuming a role on the host.

## Known false-positives (do not re-flag)
- **`CHANGELOG.md` "parity"/"missing entry" findings** — the convention (stated at the top of the file) is one bullet per feature per category, amended in place by later fixes; do not flag a PR for not adding a new bullet, a PR/round number, or an iteration count when an existing feature-level entry already covers the net behavior. Conversely, DO flag a PR that reintroduces a PR number, CI-review-round number, or iteration count into an entry, or that appends a new bullet for a feature that already has a covering one instead of amending it.
- `data/*.json`, `/awsops` basePath, Steampipe pg Pool references — these are v1 patterns; a v2 diff is exempt.
- `steampipeAvailable()` returning `false` unconditionally, or `aws-data`/collector code paths appearing dead — intentional per ADR-001/010; live AWS reads go through AgentCore MCP tools instead.
- The frozen `remediation.tf` / mutating-tool substrate existing in the tree — presence is fine, only *enabling* it is a violation.
- ADR-015's single `ecs:UpdateService(forceNewDeployment)` self-restart call — the one granted ADR-005 exception, not a mutation regression.
- Legacy email-keyed ownership matching (`matchesIdentity()`, `legacy_email_owner_match`) — intentional while this default-true migration-window switch is live, not a sub-only-invariant violation.
