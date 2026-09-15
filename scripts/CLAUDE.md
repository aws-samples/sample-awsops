# Scripts

## Role
Deployment/ops automation behind the Makefile targets (`v2/`), plus the PR review panel
(`pr-review/`). Node deps live in `scripts/v2/package.json` (pg, @inquirer/prompts,
secrets-manager) — installed by `make deps`.

## Key Files
- `pr-review/image_capability.py` — manual dev-only authenticated runner Read diagnostic.
  Standard-library synthetic PNG before credentials; one bounded Claude call, exact
  Read/answer/exit trace proof from the actual checkout, image outside workspace/CLI temp.
  Safe JSON carries observations or null plus independent cleanup status; cleanup failure
  preserves Read proof but fails the job. Reused roots cannot invoke again or publish stale
  proof. Existing role/environment/tools only: operator CI under ADR-005, no mutation
  exception or review gate replacement.
  Offline tests: `v2/test_review_image_capability.py`; runbook: `docs/runbooks/review-image-capability.md`.
- `v2/ci_web_read.py` and `v2/ci_web_deploy.py` serve the Deploy Web controller. Only allowlisted idempotent reads raise typed transient errors; one shared deadline bounds retries and subprocess cleanup. Identity/permission/unknown failures are fatal; writes remain single-attempt. Exact failed/replaced ECS deployments fail promptly, with at most 15 seconds for the known old PRIMARY in receipt verification. Tests are `v2/test_ci_web_read.py` and `v2/test_ci_web_deploy.py`.
- `v2/automatic-migration-policy.mjs` admits a conservative additive SQL subset only when `AUTOMATIC_MIGRATION=1`, forced by every web migration caller. Check all actual pending files before pending SQL, ledger upgrades or reader synchronization; function defaults (`now()`/`gen_random_uuid()`), `ALTER`, `GRANT`, views and unknown syntax require reviewed standalone migration. Automatic calls reject a missing `public.schema_migrations` under the lock and never call `initializeEmptyDatabase`, regardless of `INITIALIZE_EMPTY_DB`. Complete standalone empty-only bootstrap/historical SQL/reader sync, then dispatch a fresh web build; no historical exemptions. `migrate.mjs` uses `pg_try_advisory_lock` and holds acquired locks through SQL-reader synchronization; contention fails immediately. Tests: `v2/ci/automatic-migration-policy.test.mjs`, `migration-runtime.test.mjs` and real PostgreSQL `migration.itest.mjs`. Contract and operator scope: `docs/runbooks/release-safety-primitives.md` (ADR-001/005).
- `v2/ci_web_image.py` — web provenance helper called by `ci_web_deploy.py`.
  `promote` composes caller/context/source/migration/producer checks before publishing only
  the validated project's digest. Every promotion requires a nonempty preflight digest;
  fresh builds also bind it to `web-<SHA>` in the verified registry/repository. Preserve
  original OCI index bytes/provenance and verify exactly one ARM64 child plus its config.
  ECR reads omit image-only accepted-media filters; writes specify media/digest/registry.
  Config reads require scoped `ecr:GetDownloadUrlForLayer` and curl. CLI errors expose only
  fixed `ImageError` diagnostics, never provider data. Do not call the low-level publisher from CI.
  Child processes require exported temporary AWS credentials / an explicit GitHub token,
  disable AWS config/credential files, isolate GH config and drop endpoint/profile/model/provider/CA/proxy overrides.
  Pin child PATH to `/usr/local/bin:/usr/bin:/bin`; omit caller HOME without reassigning it.
  Only curl receives explicit private stdin (`-q -K -`); no signed URL enters argv.
  Digest reads may return identical rows for multiple tags; reject conflicting row evidence.
  Recognized non-success producer jobs skip timestamp checks; successful jobs still require
  the artifact window. Helper stdout stays `{digest, image_sha, rollback}`; controller deploy adds `migration`; recovery evidence is caller-owned.
  Build/image-proof select `IMAGE_PROJECT` from protected branch tfvars; deploy cross-checks actual Terraform ECR/cluster/service outputs. Never use dispatch input. Each operation targets one verified stack repo; broad CI-account IAM is
  not stack authority. Publication failure is distinct from candidate validation and may
  succeed only after an independent equal-effect tag check. Manifests use owned 0600 files;
  ZIP payload reads are bounded and attestations must reference the verified ARM64 child.
  Provider operation labels are diagnostic only; shared command support for ECS/STS remains.
  `v2/test_ci_web_image.py` tests the contract; jq is required for compare projection.
  Required `v2/test_ci_web_workflow.py` needs PyYAML and Bash; actionlint is optional local lint.
  Every AWS-facing Deploy Web job needs `AWS_ACCOUNT_ID_DEV`, including main; the guard job does not.
  See `docs/runbooks/web-image-provenance.md` for receipt-step names, inputs and
  expiry/rollback limits. Operator CI publication adds no ADR-005 exception or IAM grant.
- `v2/ci_private_plan.py` provides policy/publish/restore/inspect for private saved plans.
  The read-only plan job keeps asset validation and stages manual attempt-specific ciphertext.
  A protected publisher uses the existing deployer with an S3/KMS-only session, verifies
  the HMAC bundle, stores pinned objects/private manifest and replaces the GitHub artifact
  with a nonsecret reference. Operators use IAM/KMS, not the CI key; apply still verifies
  asset HMAC plus reviewed_plan_sha256, exact source/attempt/scope and existing gates.
  Local-only inspection requires the private backend file and writes a new 0700 directory
  with 0600 files; it reads no state. Public references contain no backend identifiers/digests.
  References last five days. Mandatory read-only lifecycle validation requires plan-prefix
  7-day current/noncurrent expiry and 1-day multipart abort; operators configure it through
  the separately reviewed bootstrap. Expiration is asynchronous, not an erasure guarantee.
  SSE-KMS readers need no CI envelope key, so review effective S3/KMS access before rollout.
  Policy mode is publisher-only; Apply retains its own authorization. Legacy `tfplan` runs
  keep the historical inspector. Optional purge is the manual AWS-CLI runbook procedure
  for reviewed expired attempt versions, not another helper mode.
  Contract: `docs/reference/private-plan-transport.md`;
  tests: `v2/test_ci_private_plan.py`, `v2/test_ci_private_plan_workflow.py` and the existing crypto/context suites.
  This is operator CI artifact transport, not an ADR-005 exception or product mutation path.
- `v2/ci_plan_inspect.py` is the legacy encrypted-artifact inspector: it verifies plan-run identity, checkout SHA
  and the existing signed plan/assets before local private rendering. No backend init/apply;
  new 0700 destination with 0600 bounded outputs. It refuses execution inside Actions.
- `v2/ci_failure_diagnostics.py` drains bounded output in memory until Terraform exits; no scratch-write error may kill apply or replace its result. Linux supervision forwards one graceful interrupt, escalates a second, and kills Terraform if its capture parent dies. Retain the last 1 MiB and signed total/capture status. No success/advisory raw log is written.
- Strip GitHub command-file/token variables, encryption keys, TF_LOG* and TF_CLI_ARGS* from captured Terraform and pre-apply scope-check children; keep AWS STS credentials including AWS_SESSION_TOKEN. Publish only a validated owned single ciphertext path, gated by dispatch plus failure/cancellation, with attempt-specific artifact names and five-day retention.
- Fixed public audit fields distinguish command, capture, retention and cleanup status; numeric standard Terraform success counts never include resource/output text. Missing summaries stay unavailable. Schema-2 failure HMAC uses its own domain with the existing CBC cipher/key. Recovery verifies the exact failed attempt and emits fixed timeout/errors; private inspection remains authenticated and bounded to 32 MiB.
- The sealing payload reaches OpenSSL through stdin, with no plaintext staging file. Captured Terraform runs in a separate session; first-interrupt forwarding, second-interrupt group kill and parent-death protection govern cancellation. Sealing/storage/publication failures preserve the command exit.
- Cleanup deletes only after the identified upload's literal success; failed/cancelled/skipped/unknown outcomes retain ciphertext privately. Audits distinguish pending_upload, retained_unpublished and final cleanup outcomes. No broad runner-temp sweep, shared-UID isolation or SIGKILL guarantee.
- `v2/ci_deployment_audit.py` — manual dev audit with existing identity guards, a restrictive session policy, fixed reads/SELECTs and safe projections. It shares backend parsing and state-KMS resource selection with `ci_verifier_sessions.py`; the decrypt resource follows the shared `encrypt` rule. State-object/account/S3-context restrictions and the no-invoke boundary remain. Web observations do not claim an applied revision; timestamps do not classify product freshness, and observed types do not establish completeness. Offline fixtures: `python3 -m pytest -q scripts/v2/test_ci_deployment_audit.py`; operator guide: `docs/runbooks/deployment-audit.md`.
- `v2/ci_verifier_sessions.py` — pure policy generator for manual collection and Deploy Web verification:
  backend state-read and workload policies, never persistent IAM changes or AWS calls.
  Manual `collect-runtime.yml` dev dispatches support both phases and prepare/collect.
  `deploy-web.yml` dev push/dispatch supports workload collect only; backend/prepare are refused.
  Both workflows consume the helper policies. Dev Deploy Web prepares proof credentials/state
  for push and dispatch and requires the activated-runtime collect prerequisites; missing proof fails closed.
  Require a nonempty policy for each refresh; bind workload state to the selected private directory.
  Prepare cannot invoke Lambda; collect allows only the owned collector. The consumer must
  enforce explicit catalog and each validated catalog member's RequestResponse payloads (absent type defaults to all),
  distinct catalog/succeeded result shapes and post-marker authenticated freshness/runtime/worker proof.
  Operator collection writes application inventory, not AWS resources; this is not an ADR-005 exception.
  Tests: `v2/test_ci_verifier_sessions.py`; contract: `docs/runbooks/runtime-verifier-sessions.md`.
- `v2/ci_runtime_policy.py` binds development/preview CI roles and STS accounts. The dev profile pins inventory/worker digests and enforces read-only flags even without a discovery rollout; direct dev host-only settings require that profile.
  Plan's optional nonsecret `CI_STEAMPIPE_AWS_FILL_RATE_DEV` requires full scope and that verified dev profile;
  empty preserves configuration. Apply replays the saved plan, not the current repository variable.
  Canonical contract: [Steampipe refill override](../docs/runbooks/steampipe-quota-and-staleness.md#development-ci-refill-override).
- Readiness is separate from the runtime profile: `CI_READINESS_ENABLED_DEV=true/false`
  explicitly overrides `ci_readiness_enabled` on dev; empty/unset preserves operator tfvars
  and default false. Enabled readiness is rejected outside dev. Applied readiness plus
  AgentCore creates only the verifier group; demo membership needs create_demo_user. No admin/IAM grant.
  Explicitly apply readiness and provision before the mandatory dev release gate. The controller
  verifies authenticated readiness access, not live group/membership state; use reviewed imports.
  Group removal does not rewrite issued ID-token claims (up to 12 hours); session revocation
  and runtime disablement are independent. Never reset passwords or promote a verifier to admin.
- Dev/preview private discovery requires explicit full-plan rollout and preserves public DNS/certificates. `runtime-ecr-bootstrap` permits exactly three repositories. Manual dev/preview deployment blocks listed core teardown/replacement/forget and has no retirement mode; main is outside this development policy.
- `v2/ci/prepare-runtime-host.mjs` requires actual login/DB/host-registry proof before manual full dev activation plans; apply rechecks the approved profile. Automatic PR/push plans never receive the host-probe credential. Database-only proof is rejected; credentials stay private and failures use a fixed code. Flags/policy checks do not prove live access.
- `v2/agentcore/provision.py` maps the applied `agentcore.deployment_readiness_enabled` boolean
  to `DEPLOYMENT_READINESS_ENABLED`; missing/false is off and shell overrides are ignored.

- `v2/ci_tf_assets.py` prepares hash-locked pg8000 layers and transports plan/SHA/scope-bound
  Lambda assets, validating paths, modes and hashes. Pack requires every ZIP with a known
  saved-plan hash and verifies its bytes; deferred archives without known hashes are excluded.
  Pack/restore share an event allowlist: push, pull_request or workflow_dispatch in GitHub;
  local callers supply an explicit commit without a GitHub event. Other events fail before work.
  Pack/restore require `TF_PLAN_ENC_KEY` for HMAC authentication. The 0600 plaintext tarball is
  private scratch and may contain rendered secrets; this utility cannot upload it. Callers must
  encrypt for GitHub handoff or use private SSE-KMS storage, and clean plaintext files afterward.
  `v2/ci/pg8000-requirements.txt` is the single layer-install lock. Both Terraform paths call
  build-layer, or check-layer when CI_ASSETS_READY=true; lock/script changes trigger rebuilding.
  Prepare invalidates old markers and removes stale regular ZIPs before building; it rejects
  ZIP symlinks. Schema-2 markers bind installed-file hashes; validation also checks the fixed
  required-import list. The pin validator checks this lock and all four shared-layer consumers:
  `v2/{workers,steampipe,incident,remediation}/requirements.txt`. Update these together with
  verified wheel hashes. The separate Steampipe container's `v2/steampipe/Dockerfile` pin and
  installer are outside the Lambda lock/validator. `v2/test_ci_tf_assets.py` covers these
  contracts and restore recovery.
  Plan/apply export literal `CI_ASSETS_READY=true` for the same verification contract.
- `v2/configure.mjs` — `make configure`: interactive TUI → `terraform.tfvars` + `backend.hcl`.
  AWS access shells out to the `aws` CLI, not the SDK.
- `v2/deploy.mjs` — `make deploy` (runs migrate first): arm64 build → ECR push →
  ECS force-new-deployment → wait stable → smoke `/api/health`. `deployment-smoke.mjs`
  preserves service Host/SNI/TLS via CloudFront `--connect-to` before service DNS publication.
  The `DOCKER` env defaults to `sudo docker`.
- `v2/ci_web_deploy.py` — verify caller, owned service and required read access before
  web promotion. Readonly image proof shares registry/media/config and fresh source-tag checks before
  migrations; `promote(env, expected_digest=...)` must retain that digest/project.
  Receipts publish no account ID or fingerprint. Require source/project migration evidence for current dev source, or
  explicit schema-compatible older-image rollback. Bounded ECS consistency polling
  must converge to the exact deployment and healthy running digest, never a stable rollback.
- `v2/prepare-smoke-credentials.mjs` — credential preparation for every dev Deploy Web release,
  manual `collect-runtime.yml`, and Terraform's private host verification before plan/apply. These
  steps bind the shared `TF_VAR_DEMO_PASSWORD` secret as `TF_VAR_demo_password`; the helper privately
  evaluates effective Terraform demo credentials, requires unwrapped Terraform, strips TF logging/
  argument overrides, and publishes only a 0600 credential-file path inside a 0700 directory.
  Private init is bounded to 10 minutes; output/console each to 2 minutes.
- `v2/authenticated-smoke.mjs` — login plus edge-authenticated `/api/db` verification. Preserve
  Host/SNI/TLS; report only the phase and validated HTTP status, never bodies/cookies/passwords.
  CLI HTTP scratch belongs to the prepared credential directory and normal finalizers;
  process/runner loss can prevent cleanup. Standalone calls prefer RUNNER_TEMP. Response files default to 64 KiB; only the bounded CloudFront inventory leg permits 2 MiB.
- `v2/ci/runtime-release.mjs` — strict controller used by both dev workflows; `capture` writes private state
  and its `GITHUB_OUTPUT` path, `run` consumes it. See the controller contract below.
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
  This optional workflow step tolerates failure (eight-minute timeout), as does the separate
  advisory readiness-plan summary; DNS/CI/readiness gates remain required.
  Fixtures: `python3 -m pytest -q scripts/v2/test_ci_db_diagnostics.py`.
- `v2/ci_plan_context.py` — accepts only successful explicit Terraform plan dispatches from
  the exact deployment repository, branch and SHA; PR/push plans are advisory.
- `v2/ci_readiness_plan_summary.py` reports only fixed resource addresses, checks and a known
  public collector code hash for explicit full dev readiness plans. It is advisory, not
  approval or resource-presence proof; unknown changes require private inspection.
  It runs before encryption with a two-minute timeout and fenced JSON output.
  Presence booleans are separate, with a combined 256-row bound and no private values;
  new enrollment checks the existing or planned group's absence of an IAM role.
- `v2/test_ci_{db_diagnostics,dev_domain,dns_policy,plan_context,plan_inspect,readiness_plan_summary,failure_diagnostics,failure_review,deployment_workflows,terraform_reads,tf_assets,verifier_sessions,web_image,web_workflow,web_deploy}.py` —
  the suites collectively use policy/workflow fixtures, real no-provider plans and a localhost
  state backend to verify gates without AWS calls. From repo root: `python3 -m pytest -q scripts/v2/test_ci_*.py`.
  Summaries allow certificate suffixes/publication/change counts and addresses, plus active
  rollout's public zone name/ID/NS. The readiness summary adds fixed scope/presence checks and
  a known configured collector hash. Diagnostics also publish bounded numeric metric values;
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
  DB with INITIALIZE_EMPTY_DB=1 (one-shot host command; private CI template retains the
  guarded flag for standalone/manual initialization). Automatic calls refuse a missing ledger before this hook.
  Existing integer ledgers still require BOOTSTRAP=1.
  Non-null baseline/ULID checksums are immutable. Reader elevation is checked even in disabled
  mode; enabled sync with a missing role fails. `migration-errors.mjs` preserves bounded,
  encoded NOTICE/P0001 text and validated identifiers only during reviewed baseline/ULID SQL.
  Secret/connection/reader-sync phases expose only safe codes/context, never secret bodies.
  Client error events and cleanup failures fail closed; success follows connection cleanup.
  `v2/ci/Dockerfile.migration` is the ARM64 nonroot/read-only-filesystem runtime, using CMD.
- `v2/ci/run-migration.mjs` — private development controller used by
  `.github/workflows/deploy-migrations.yml`: clone the reviewed ARM64 template with an
  immutable image digest, run one private task, verify ownership/exit, and clean up only that run.
  Read retries are bounded; public failure categories use the runtime diagnostic contract.
  Standalone/AgentCore calls are dispatch-only. The explicit Deploy Web caller also
  accepts current-source dev pushes; generic runtime builds do not inherit that opt-in.
- `v2/ci/runtime-build.mjs` — manual dev transport for existing backend repositories.
  Require secret `AWS_ACCOUNT_ID_DEV`, configured-role and actual STS agreement, and verified
  Linux/ARM64 manifest digests. Build-role ECR scopes cover `-steampipe`/`-worker`; deployer scopes
  cover `-agentcore`. IAM is provisioned separately; web-only grants are insufficient.
  Preflight rejects missing repositories/denied access. No repository creation or latest-tag writes.
  Image verification exports a private Docker archive, validates its tag and Linux/ARM64 config,
  hashes exact config bytes and binds ECR to that digest. Tar reads validated hash paths with bounded
  output and no AWS credentials; optional BuildKit metadata/image IDs are not config identity.
- `v2/ci/setup-provision-python.py` — private Python 3.12 virtualenv for the host provisioner;
  installs hash-pinned wheels without inherited AWS/PIP credentials, verifies service models and
  imports and exact pinned SDK versions, derives required operations from the provisioner,
  and publishes PATH only after success. Base-Python cleanup warns on SDK-folder removal errors
  without changing deployment results; the folder contains packages, not credentials.
- `v2/agentcore.mjs` + `agentcore/` — dev uses applied `ci_migrations_enabled=true`
  (`CI_MIGRATIONS_ENABLED_DEV=true`) and non-null `migration_job`, then private migration and
  digest-bound build-only/provision-only phases. Fresh sessions of the same role follow setup
  and separate the bounded phases; provision-only rechecks identity/tag/digest without rebuilding.
  Dev guards are selected by `TARGET=dev` or `GITHUB_REF=refs/heads/dev`; main/preview retain the legacy path.
  Diagnostics expose bounded fixed stages/codes/catalog counts, never raw errors, ARNs or credentials.
  Optional smoke honors applied readiness enablement, nonce/account and producer freshness;
  other stacks retain advisory compatibility with transport failures still fatal. It is not the
  full web/collection/worker release gate. Exact timing and wire contracts: `docs/reference/05-agentcore.md`.
- `v2/*.itest.mjs` — migration integration tests against a disposable PostgreSQL 17 container.
- `v2/ci/*.test.mjs` — migration runtime/controller/workflow tests and mocked Terraform plans; install locked scripts/v2
  dependencies with `npm ci --prefix scripts/v2 --ignore-scripts --no-audit --no-fund`; Python PyYAML, boto3/botocore (`pip install -r agent/requirements.txt`) and Terraform 1.15.7 are also required.
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
  per lens), `synthesize.sh` (chair synthesis), `lib.sh` (slots, scrubbing, response/coverage checks).
  `image_capability.py` is the separate manual diagnostic, not a panel or gate override;
  its source contract and offline test entry are listed above.
  `review_context.py` pins the trusted CI checkout and reviewed PR/base metadata.
  `stage_head_pngs.py` stages bounded regular HEAD raster Git blobs as read-only data before
  review credentials; prompts use 200-character safe path labels, exact names stay in JSON data.
  Codex receives hash-checked `--image` attachments; Claude Read uses the same generated files.
  BASE pixels are historical, never replacement evidence for changed HEAD images.
  `image_coverage.py` validates bounded full reports before truncation/verdict: each of
  eight cells plus chair must declare plain `IMAGE_COVERAGE: COMPLETE` when images
  are staged. Explicit failure always blocks; quoted/fenced/prose examples do not count.
  Missing/unsupported required image evidence fails coverage; no finding suppression,
  HEAD execution or added permissions. See `docs/runbooks/pr-review-head-images.md`.
  Per-entry unavailable evidence preserves good files and publishes a deterministic FAIL.
  Preparation faults also reach a fixed failure comment after context/diff validation.
  The existing panel-prompt structure runner executes both pipeline and image fixture suites.
  Static PNG/WebP/single-rendition ICO use hash-pinned Pillow 12.3.0 on Python 3.12; isolated
  decode has CPU/memory/time/output bounds. Keep original blob/hash and render lineage.
  32 attempts/files cover the observed assets; animations/renditions never silently truncate.
  Response presence stays counted on image failure. Normalize terminal controls, reserve
  declaration prefixes (decorated failures block), and diagnose unreadable reports separately.
  Only the accepted chair needs required coverage; discarded invalid output without a
  declaration can recover. Explicit/malformed failures and panel failures remain sticky.
  Omitted-path diagnostics use safe labels; gate reasons are quoted environment data.
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
- Private-plan publication/apply require branch environments, including main plan approval.
  Only missing backend/tfvars blobs soft-skip; absent publisher roles fail. Inspection requires
  the private backend file. Public references omit storage identifiers/bare hashes and plan
  digests; every CLI result omits the plan digest. Mask the reviewed input before logging.
  Digests bind bytes, not human review. Existing bucket/IAM/KMS prerequisites are checked,
  never granted. Owner-installed plan-prefix lifecycle is mandatory; the optional owner-run
  bootstrap supplies it, never the workflow. Manual AWS-CLI purge is optional early cleanup
  or orphan investigation. Its age cutoff covers data versions, not delete markers; a complete
  listing must show no young data versions before deletion. Local cleanup is current-run
  scoped without a runner-loss guarantee.
- Scripts assume they run from the repo root (they resolve resource addresses via
  `terraform -chdir=terraform/foundation output`) — prefer the Makefile targets over running
  scripts directly.
- For the emergency IAM `put-role-policy` convention, see `terraform/CLAUDE.md`.

`v2/runtime-smoke.mjs` accepts explicit private prepare/verify configuration. Prepare
checks the host registry; optional hostOnly rejects members. Verify requires complete post-marker
collection for every supplied type, real web-role runtime evidence and owned worker completion.
Release mode changes the bounded polling window, not the strict data criteria.
The file is at most 16 KiB, collectionStartedAt at most 30 minutes old at validation, and types unique
with cloudfront included. The release controller supplies it for mandatory dev verification.
`readRuntimeSmokeConfig(file, credentialFile, now = Date.now())` takes a finite
numeric validation time. Pass calibrated `now()` from the controller; default callers
retain their existing behavior without changing the marker or extending expiry.

## Development release controller

Every dev release requires `v2/ci/runtime-release.mjs` identity/image/code, complete post-marker collection for every catalog type, fresh known CloudFront, SSM/model and both worker proofs. At most four synchronous collectors run; partial/failed/stale/missing/unknown evidence blocks release. The marker comes from authenticated Aurora time; request-start calibration preserves exact post-marker comparisons and existing deadlines. Missing clock evidence stops type invocation.
The [runtime contract](../docs/runbooks/runtime-foundation.md) owns strict data policy, proof budgets, digest binding, retry and adoption rules.
Manual prepare is neither first-web bootstrap nor readiness; never reset passwords or promote a verifier to admin.
Manual verification requires separate [backend/workload policies](../docs/runbooks/runtime-verifier-sessions.md) and private-file cleanup.

The reusable helper's verify mode accepts optional `inventoryPolicy: "full"` and `collectionMode: "release"`;
other values fail, and omission retains strict checks for every supplied type. Full mode
returns programmatic quality/gaps; CLI output stays fixed and catalog discovery belongs
to the caller. The helper selects a nominal 10-minute wait cap, or 20 in release mode, shared across rechecks.
Remaining absolute time and proof admission can shorten it; the controller does not promise
a twenty-minute wait after collecting the catalog. All runtime callers have a finite deadline: marker+30min
for verify, entry+30min for prepare; an explicit deadline only shortens it. One proven
CloudFront running collision permits a 65-second-cooldown retry after complete revalidation.
A repeated collision is runtime_inventory_contention, initial waiting is collection_timeout,
stale full-policy data is collection_stale and the outer limit is release_timeout. Workers
start after ready. The helper and collection-only BFF view do not activate a workflow/flag.
Requests require their full timeout remaining. Before billed readiness, require its 80s
allowance plus 370s per worker (35s enqueue, 300s poll, final 35s request); recheck remaining
workers before enqueue. Retry admission includes 65s cooldown, one 35s collection read,
the probe and both workers. Collection windows are caps; late completion may fail admission.
Fresh running collection attempts with old/null previous success remain pending and time
out as collection_timeout. Stale terminal evidence remains collection_stale in full mode.
The outer authenticated login/DB wrapper also refuses shortened request timeouts.

## Strict release controller capability

`v2/ci/runtime-release.mjs` drives mandatory dev Deploy Web verification and manual
collect-runtime operations. Dev runs verify the exact ECS/image deployment first, then
collect with `EXPECTED_WEB_DIGEST` from `steps.pin.outputs.digest`. Collect mode requires
full readiness (including login/DB); prepare only verifies
authenticated login/DB/host registration. Explicit runtime/readiness activation remains
separate, and inactive prerequisites cannot be skipped.
The controller verifies dev source/account/role, applied runtime metadata and ARM64
web digest, requires every pinned baseline member (currently 43, source-AST checked)
and permits valid growth up to 128 types, then drives every returned
type (currently 43) with at most four
concurrent in-flight synchronous invocations. It requires succeeded results, known counts and zero unknowns.
It samples the authenticated DB clock before collecting, anchors calibration at request
start, shifts the existing deadline by the same offset, and retains strict post-marker
ledger checks. Collector code hash and RevisionId must remain stable through collection.
Both modes require the enabled host only. Collect's authenticated DB/host preflight
rejects incompatible registries as `host_only_registry_required` before per-type calls.
AWS CLI children use an explicit credential/settings allowlist, pinned path, disabled
config/credential files and metadata, and endpoint isolation; never forward ambient CI
secrets, profiles, providers, CA/proxy overrides or hooks.
The first chronological terminal failure stops new type admission; admitted work settles,
and untouched types remain structured `not_started`. Six status counts partition
`expected`; a selected type whose first call is blocked by the 450-second floor is `deadline`/zero attempts,
while never-selected types are `not_started`/zero attempts. Inventory quality gaps can
still overlap. Preserve the full `Runtime release: <reason>` envelope. Passed-through
`SmokeError` messages retain nested `Runtime smoke:` / `Authenticated smoke:` prefixes;
direct `RuntimeSmokeError` config exceptions can become controller fallbacks.
Identical RPC/ledger suffixes are not interchangeable. Partial/unknown outcomes intentionally
stop even under limiter/hydrate pressure. Diagnose capacity, reachability or denials before
an authorized fresh bounded rerun; do not weaken acceptance or suppress the schedule.
Full SSM/AgentCore/model and both owned worker proofs remain required afterward.
Collect then rechecks service/list-tasks/describe-tasks against the original opaque
PRIMARY deployment ID, immutable task-definition ARN, count and ECR digest set before
`full_verified`, without another ECR/tag lookup. A changed ID fails even with the same
task definition. These are start/end observations, not continuous or atomic history proof.
Prepare has no closing recheck.
Private credentials/configuration and cleanup, restrictive consumer sessions and
explicit capability activation remain mandatory integration prerequisites.
See [runtime-foundation.md](../docs/runbooks/runtime-foundation.md#strict-release-controller-capability)
for budgets and [runtime-verifier-sessions.md](../docs/runbooks/runtime-verifier-sessions.md)
for session boundaries. The 18-minute reserve covers the single-pass 1,060-second
path plus 20 seconds. Auth proof ends 50 seconds before the original proof deadline,
reserving three sequential 15-second closing reads plus five seconds overhead.
Collection has at most 720 seconds; the 450-second floor puts last admission at
270 seconds minus clock preparation/earlier bounds. Extra 35-second reads need at
least 15 seconds saved. Full retry overhead is at least 215 seconds, needing 195 saved:
the helper's remaining 180-second admission allowance follows a 35-second confirmation
read. Worker allowances are reused, not counted twice. More reads/waits/overhead need
more time; no extras or continuous identity guarantee are promised.
CLI inputs and fixture prerequisites:
[controller CLI contract](../docs/runbooks/runtime-foundation.md#controller-cli-contract).
Catalog/per-type timeouts:
[collection effects and proof](../docs/runbooks/runtime-verifier-sessions.md#collection-effects-and-proof).
`remaining_prerequisites: "not_assessed"` preserves separate workflow/plan/promotion gates.
Use the canonical [fixed-code operator table](../docs/runbooks/runtime-foundation.md#fixed-diagnostics-and-remaining-prerequisites).
Combined tests: `node --test scripts/v2/ci/runtime-release.test.mjs scripts/v2/deployment-smoke.test.mjs`.
The owner requires all current types, superseding the earlier CloudFront-only proposal.
Four lanes are a concurrency ceiling, not a throughput guarantee; the active schedule
and shared limiter can cause throttling or incomplete data. Budgets fail closed rather
than promise every workload fits. Preserve the recorded feasibility sample and its
limitations in the runbook; do not suppress the schedule or weaken proof to pass.
