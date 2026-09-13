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
- `v2/prepare-smoke-credentials.mjs` — Deploy Web's dev-only opt-in preparation: privately
  evaluate effective Terraform demo credentials, require unwrapped Terraform, strip TF logging/
  argument overrides, and publish only a 0600 credential-file path inside a 0700 directory.
  Private init is bounded to 10 minutes; output/console each to 2 minutes.
- `v2/authenticated-smoke.mjs` — login plus edge-authenticated `/api/db` verification. Preserve
  Host/SNI/TLS; report only the phase and validated HTTP status, never bodies/cookies/passwords.
  The CLI keeps HTTP scratch files under the prepared credential directory so the workflow's
  always-cleanup owns them; standalone calls prefer RUNNER_TEMP. Response files are capped at 64 KiB.
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
- `v2/ci_db_diagnostics.py` — manual opt-in dev CI plan diagnostics (`CI_DB_DIAGNOSTICS_DEV=true`).
  Require `workflow_dispatch`, literal flag `true`, `--target dev`, and region `ap-northeast-2`.
  Wrong invocation context is rejected before any AWS read. The state-account/STS comparison
  is a consistency check, not authorization or same-account stack validation.
  Use only the fixed read-only CLI verbs. Run after encrypted plan upload; publish fenced safe
  JSON (including posture booleans) to the public Actions log/step summary.
  Independently retain all four sections: `logs`, `configuration`, `server_logs`, `rds_metrics`.
  Partial/unavailable reads are advisory, not readiness gates.
  `no_matching_events` labels empty accepted samples; `no_error_inference=true` prohibits health
  conclusions from any status's zero counts. Interpretation requires a known DB probe within
  the returned one-hour window. A successful task-definition read stays source-available even
  if its web container is missing/malformed; use `web_container_found` and derived-unknown flags.
  Web logs use a fixed one-hour `[start,end)` window, oldest-first, at most three pages of 100
  using `--next-token`/`--limit`; disclose bounds, category counts, ignored/unparsed and truncation.
  JSON `evt` OR selects `db_ping_failed` plus `db_connection_failed`; the latter exposes only
  seven allowed phases, eight milestone keys and finite 0–3,600,000 ms durations (milestones
  cannot exceed elapsed). Count phases and retain the latest valid timing in the sample.
  Server logs select the latest two observed PostgreSQL filenames from at most three listing
  pages for `<project>-aurora-1`; at most two downloads of 500 newest lines without Marker
  (1 MiB cap per file). Count only FATAL/ERROR/PANIC web-role lines as errors.
  `benign_role_mentions` counts exactly non-error-severity lines mentioning `awsops_web`;
  lines for other database roles are ignored. Never print names/lines. Tail/listing truncation is independent;
  failed downloads retain listing metadata as partial. Capped web samples are also partial.
  Sources and unknown derived fields have separate flags. Accept single-object IAM Statement.
  HBA failures are distinct from TLS; pool-acquire timeout differs from unexpected connection
  loss, and PostgreSQL slot/client limits are recognized. Metadata is the service target definition, not running
  revision proof; credential env/secrets names and environment-file presence are declarations
  only. SG/inline connect-Allow matches do not prove effective access under SCPs/boundaries.
  Emit fixed labels/bounded metric values/counts/timestamps/booleans/nulls only; withhold raw messages, credentials
  and ARNs, including Terraform stderr. Unset/false is off; no writes or new IAM grants.
  Early input/context/identity failure returns only `{"status":"unavailable"}` with nonzero exit.
  Discarded milestones or regex inputs shortened to 4,096 characters mark samples partial.
  Read-only violations escape partial-read handlers and fail with a fixed reason, never raw args.
  One bounded CloudWatch `get-metric-data` request adds seven IAM-auth Sum series plus CPU
  Average, free-memory Minimum and capacity Average, scoped to the configured first instance.
  Preserve fixed IDs, status/missing/invalid flags and at most 60 minute points each; never
  remote labels/messages/tokens. Instance-wide metrics cannot attribute a probe outcome.
  Metric read status is separate from presence: clean Complete+empty is available/missing;
  Forbidden/InternalError is unavailable, PartialData or malformed/degraded reads are partial.
  `read_ok` describes the response envelope, not an auth outcome.
  Expose configured min/max ACUs as bounded numbers or null; change no capacity/auth/timeout setting.
  Every server lifecycle count requires the web user in a recognized RDS prefix and anchored
  PG messages, separately from error categories. This rejects bare/mid-line tokens, but
  multiline SQL with a full prefix and RAISE LOG can forge matching text. Always retain
  `lifecycle_source_integrity=unverified_text`, `lifecycle_injection_possible=true` and unknown
  probe outcome. Authenticated/authorized messages require log_connections (PostgreSQL default
  off; not enabled here); the effective setting is uninspected, `log_connections_enabled=null`.
  Only this optional workflow step tolerates failure (eight-minute timeout); DNS/CI/readiness
  gates remain required. Fixtures: `python3 -m pytest -q scripts/v2/test_ci_db_diagnostics.py`.
- `v2/ci_plan_context.py` — accepts only successful explicit Terraform plan dispatches from
  the exact deployment repository, branch and SHA; PR/push plans are advisory.
- `v2/test_ci_{db_diagnostics,dev_domain,dns_policy,plan_context,deployment_workflows,terraform_reads}.py` —
  workflow fixtures, real no-provider plans and a localhost state backend verify deployment
  gates without AWS calls. From repo root: `python3 -m pytest -q scripts/v2/test_ci_*.py`.
  Summaries allow certificate suffixes/publication/change counts and addresses, plus active
  rollout's public zone name/ID/NS. Diagnostics also publish bounded numeric metric values;
  never raw configuration, ARNs, account IDs, state or plans.
- `v2/terraform-test.sh` — Terraform 1.15.7 validate/mock tests in a disposable tracked-file
  copy, `init -backend=false`, fresh data dir, no deployment credentials or real backend.
  `v2/requirements-test.txt` declares pytest/PyYAML; the shared merge script runs Node smoke tests.
- `v2/workers.mjs` — `make workers`: builds and pushes the worker image **only**. The Fargate
  worker is not an ECS service — SFN `RunTask` pulls `:worker-latest` at job time. Short jobs
  deploy as Lambda zips and need no image. Run after applying with `workers_enabled=true`.
- `v2/migrate.mjs` + `migrate-core.mjs` — `make migrate`: advisory-lock, checksum, stamps the
  release version from the `-- since:` header. `DRY_RUN=1` previews; `--status` gives an
  offline summary. Default CLI credentials come from Terraform outputs → Secrets Manager.
  Any AURORA_ENDPOINT/DATABASE/SECRET_ARN env selects explicit runtime mode (no Terraform
  fallback), requiring AWS_REGION and SQL_READER_SYNC_MODE=secret|disabled; secret mode also
  requires SQL_READER_SECRET_ARN. AURORA_SECRET_ARN means master here. TLS verifies the
  bundled RDS CA and hostname. `initialize-db.mjs` atomically initializes only a verified-empty
  DB with INITIALIZE_EMPTY_DB=1 (one-shot host command; manual CI template retains the
  guarded flag). Existing integer ledgers still require BOOTSTRAP=1.
  Non-null baseline/ULID checksums are immutable. Reader elevation is checked even in disabled
  mode; enabled sync with a missing role fails. `migration-errors.mjs` preserves bounded,
  encoded NOTICE/P0001 text and validated identifiers only during reviewed baseline/ULID SQL.
  Secret/connection/reader-sync phases expose only safe codes/context, never secret bodies.
  Client error events and cleanup failures fail closed; success follows connection cleanup.
  `v2/ci/Dockerfile.migration` is the ARM64 nonroot/read-only-filesystem runtime, using CMD.
- `v2/ci/run-migration.mjs` — manual development controller used by
  `.github/workflows/deploy-migrations.yml`: clone the reviewed ARM64 template with an
  immutable image digest, run one private task, verify ownership/exit, and clean up only that run.
  Read retries are bounded; public failure categories use the runtime diagnostic contract.
- `v2/ci/runtime-build.mjs` — manual dev-only transport for existing Steampipe/worker
  repositories and dev AgentCore images. Required repository secret `AWS_ACCOUNT_ID_DEV`
  must match configured role and actual STS identity; both private migration jobs require
  it too. BatchGetImage preflight accepts the expected missing commit tag, never a missing
  repository/access denial. No DescribeRepositories grant, repository creation or latest-tag
  write. Verify Linux/ARM64 configuration and uploaded single-manifest digest. Limits:
  short CLI/TF 2 minutes, dev build 35, push 10, provision 45. Aggregate deadlines:
  build helper 48 minutes, agent phases 50 including reads. Manual image builds acquire
  fresh one-hour credentials after QEMU/buildx setup and cap the build step at 50 minutes.
- `v2/agentcore.mjs` + `agentcore/` — `make agentcore`: arm64 agent image + idempotent
  provisioner, writes to SSM. Dev uses an immutable digest and reusable private migration;
  main/preview retain legacy migration/tag behavior. Dev requires `--build-only` then
  `--provision-only`, with the workflow acquiring a fresh one-hour session of the SAME role
  after setup and again between phases. Only verified project/digest outputs are passed;
  provision-only rechecks STS and the current commit tag/digest without rebuilding or latest
  fallback. A combined dev CLI call is rejected. Fresh-role checks take at most 2 minutes,
  phase steps 52 and the dev job 120 including setup; no custom credential process or IAM/session-max change.
  `provision_report.py` emits fixed stages,
  error codes, catalog keys and status counts; at most 240 resource events plus a dropped
  count, no raw errors/ARNs/credentials. Node relays only bounded structured records and
  preserves child failure exit codes. Optional smoke runs after provisioning: strict on dev;
  elsewhere compatible invocation/advisory checks remain and transport errors still fail.
  Structured mode needs the readiness producer, runtime_deployment and enabled inventory.
  Applied `agentcore.deployment_readiness_enabled` must be literal boolean true to enable
  the runtime probe. Missing/false values disable it; ambient DEPLOYMENT_READINESS_ENABLED
  cannot override the applied output.
  Accept one real SSE payload after optional data spacing, event/id/comments and [DONE].
  Match nonce/account/fixed checks; count is a capped sample (1–500), ageMinutes 0–1440 is
  only a validation bound. Freshness uses the producer's MCP stale_after_minutes classifier,
  never a local hard 15-minute threshold. Missing dev prerequisites are coded smoke failures,
  not pre-provision blockers on production. CLI smoke does not prove Memory/Interpreter use
  or the full authenticated web/collection/worker release gate.
- `v2/*.itest.mjs` — migration integration tests against a disposable PostgreSQL 17 container.
- `v2/ci/*.test.mjs` — migration runtime/controller/workflow tests and mocked Terraform plans; install locked scripts/v2
  dependencies with `npm ci --prefix scripts/v2 --ignore-scripts --no-audit --no-fund`; Python PyYAML,
  boto3/botocore (`pip install -r agent/requirements.txt`) and Terraform 1.15.7 are also required.
  `v2/ci/migration.itest.mjs` includes initializer regressions. It and
  `v2/ci/web-db-connection.itest.mjs` are **required fail-hard exceptions** to the legacy
  optional itest convention: bare `docker` on PATH, OpenSSL, postgres:17,
  no automatic sudo/DOCKER override, no skip if Docker is unavailable.
  See `docs/v2-merge-verification.md`; PR fixtures must remain without AWS credentials/OIDC.
- `v2/ci/web-db-connection.itest.mjs` — real PostgreSQL/verified-TLS regressions for the
  web connection observer's phase/timing logs, async password resolution and error propagation.
  Uses the locked web driver and TypeScript via `npm ci --prefix web`, plus scripts/v2
  dependencies for the disposable fixture. Merge Verify runs it alongside all migration cases.
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
