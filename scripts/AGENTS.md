<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: f3cd690374b3 · generated-at: 2026-09-19 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Scripts — Reviewer Context

- `pr-review/image_capability.py` is the manual dev-only runner image Read diagnostic.
  Synthetic data precedes credentials; one bounded call requires exact Read/answer/exit
  proof from the checkout, with image outside workspace/CLI temp. JSON observations may
  be null; cleanup failure preserves proof but fails the job. Reused roots reject new
  calls/stale proof. Existing grants only, operator CI under ADR-005, no mutation exception
  or replacement for PR review gates. Tests:
  `v2/test_review_image_capability.py`; see `docs/runbooks/review-image-capability.md`.

- Web release helpers `v2/ci_web_image.py` and `v2/ci_web_deploy.py` bind producer/source/project/digest. Readonly receipt/ECR proof precedes migrations; promotion retains that digest and requires actual caller/account/read access plus exact healthy ECS evidence. Public receipts contain no account IDs/fingerprints. Unit and workflow contracts are split between `test_ci_web_image.py`, `test_ci_web_workflow.py` and `test_ci_web_deploy.py`.
- Current-source dev pushes require matching private migrations; explicit older-image rollback requires producer/schema acknowledgement and runs no DDL. Every dev web release prepares private demo credentials and requires full runtime readiness, including login/DB. Standalone and AgentCore migration calls remain dispatch-only. Tests include `test_ci_web_image.py` and `test_ci_web_deploy.py`.

Deployment/ops scripts live under `v2/`; PR review automation lives under `pr-review/`.
Run from the repo root. Node dependencies are in `scripts/v2/package.json`, not the root.

Changed HEAD PNG evidence is staged from bounded Git blobs before review credentials.
All panel lenses and chair share safe labels and read-only generated paths; exact
names remain in JSON data. Codex gets hash-checked --image attachments, Claude uses Read;
BASE pixels are historical. Required unavailable images fail coverage, never suppress
findings. No HEAD execution or permission expansion. See `docs/runbooks/pr-review-head-images.md`.
Python helpers use isolated mode so application-base modules and PYTHONPATH cannot
execute through standard-library imports under review credentials.
`review-limits.json` ties raw/scrubbed diff, report and chair-stdin allocations.
The stdin bound measures diff, reports and short headers only; synthesis instructions
and image-context text are a separate CLI argument. The max-budget fixture proves
that IO distinction, not model latency.
`report-panel-failure.sh` retains fixed diagnostics and severity-keyword presence booleans, names missing vendors
and separates checklist/image/report diagnoses without implying code safety.
Input admission requires complete filtered diffs within 6,000 lines/128 KiB and
complete hash-valid image evidence before model credentials. No truncated reviews.
Two independent Codex/Claude reports each cover all four checklists and must declare
substantive sections for L2–L5, including security L3, plus plain
`LENS_COVERAGE: L2,L3,L4,L5`; missing panel coverage skips chair calls.
Report truncation cannot approve unseen findings. Oversized promotion diffs still
need a separately reviewed complete-batching/reuse design.
Bounded full-report validation requires a plain `IMAGE_COVERAGE: COMPLETE` from both
comprehensive vendor reports and chair for staged images. Explicit failure overrides PASS even without
images; examples inside quotes/fences/prose do not count as declarations.
Unsupported/over-limit entries preserve staged files but force published coverage FAIL.
Preparation faults publish fixed failures after context/diff validation. Both image
and pipeline fixture suites are run by the existing panel-prompt structure check.
Static PNG/WebP/single-rendition ICO use an isolated hash-pinned Pillow 12.3.0 decoder on
Python 3.12 with 32 attempts/files and bounded CPU/memory/time/bytes. Preserve source/render
hashes and geometry; reject extra frames/renditions. Context admission includes rendered
paths and final counter reserve; report omitted scope without discarding admitted images.
Check renamed blob size before reading. Image failure does not erase response
presence. Decorated failures block; terminal controls normalize before parsing; unreadable
review output is distinct from image coverage. No new tool or AWS permission.
The accepted chair must satisfy required coverage; discarded invalid output without a
declaration may recover. Explicit/malformed and panel failures remain sticky. Omitted-path
diagnostics use safe labels, and gate reasons are quoted environment data.

## Diagnostic and deployment boundaries
- `ci_web_read.py` / `ci_web_deploy.py` serve Deploy Web. Only typed transient reads retry within a shared deadline; writes/permissions/identity failures do not retry. Failed/replaced ECS deployments are terminal; receipt verification gives known old PRIMARY visibility 15 seconds.
- Every web migration caller forces `AUTOMATIC_MIGRATION=1`, checking every ledger-derived pending SQL file against the transactional subset before pending SQL/ledger/reader changes; function defaults (`now()`/`gen_random_uuid()`), `ALTER`, `GRANT`, views and unknown/contract SQL require reviewed standalone migration. Automatic calls reject a missing `public.schema_migrations` under the lock and never call `initializeEmptyDatabase`, regardless of `INITIALIZE_EMPTY_DB`. Complete standalone empty-only bootstrap/historical SQL/reader sync before a fresh web dispatch; no historical exemptions. Advisory lock acquisition is nonblocking and remains held through reader sync. See `docs/runbooks/release-safety-primitives.md` and the corresponding Python/Node/PostgreSQL tests.
- `v2/ci_web_deploy.py` calls composed `ci_web_image.promote(env, expected_digest=...)`, verifying the
  caller/context/source/migration/producer; readonly proof shares ECR/config/source-tag checks before DDL.
  A nonempty preflight digest is mandatory; fresh builds must match the registry's source
  tag. Preserve OCI index bytes and verify one ARM64 child plus its digest-bound config.
  Pin ECR registry/media/digest explicitly; do not use image-only accepted-media filters.
  Config reads need scoped `ecr:GetDownloadUrlForLayer` and curl. CLI diagnostics are
  fixed `ImageError` messages, never provider data.
  Provider children use explicit temporary AWS credentials / GitHub token, disabled AWS config
  files, private GH config and no inherited endpoint/profile/model/provider/CA/proxy overrides. Stdin is closed
  except curl's private `-q -K -` config; signed URLs never enter argv. Multi-tag digest rows
  must agree on identity, raw manifest and media.
  Check recognized producer conclusions before timestamps; skip non-success jobs without
  suppressing another successful receipt. Helper stdout is `{digest, image_sha, rollback}`;
  controller deploy adds `migration`, with no recovery history.
  Build/image-proof select `IMAGE_PROJECT` from protected branch tfvars; deploy cross-checks actual Terraform ECR/cluster/service outputs. Never use dispatch inputs.
  Target one verified stack repo per operation; broad IAM is not branch/stack authority.
  Unconfirmed publication is a provider/retry diagnosis, not a rebuild signal; retain equal-effect
  confirmation. Use 0600 manifest files, bounded ZIP reads and ARM-child attestation references.
  Operation labels do not restrict the shared consumer's ECS/STS calls.
  Child PATH is `/usr/local/bin:/usr/bin:/bin`, ignoring caller additions; HOME is omitted, never reassigned.
  No manually assembled publishing chain. `test_ci_web_image.py` requires jq;
  required `test_ci_web_workflow.py` needs PyYAML and Bash; actionlint is optional local lint.
  Every AWS-facing Deploy Web job needs `AWS_ACCOUNT_ID_DEV`, including main; the guard job does not. The
  receipt steps, main account prerequisite and recovery limits are documented in
  `docs/runbooks/web-image-provenance.md`. Operator CI adds no ADR-005 exception or IAM grant.
- `ci_readiness_plan_summary.py` runs before encryption only for explicit full dev readiness
  plans, with a two-minute timeout and fenced JSON output. Its failure-tolerant report publishes
  fixed scope/presence checks, fixed addresses and a known collector hash, never private values.
  The combined 256-row view is not approval or resource-presence proof; unknown changes require
  private inspection. Membership checks include the existing/planned group's lack of an IAM role.
  Reporting cannot weaken DNS/runtime/exact-plan gates or block the encrypted handoff or private publication.
- `CI_READINESS_ENABLED_DEV` is separate from the runtime profile: true/false explicitly overrides readiness on dev, while empty/unset preserves operator tfvars/default false. Public CI rejects enabled readiness elsewhere. The applied group requires AgentCore, and automatic membership requires the managed demo; no admin/IAM grant.
- `v2/ci_plan_inspect.py` is the legacy encrypted-artifact inspector, local-only: authenticate successful plan-run context, checkout
  SHA and existing signed plan/assets before private rendering. No backend init/apply.
  Outputs are bounded 0600 files in a new 0700 destination.
- `v2/ci_failure_diagnostics.py` drains bounded output in memory until Terraform exits; no scratch-write error may kill apply or replace its result. Linux supervision forwards one graceful interrupt, escalates a second, and kills Terraform if its capture parent dies. Retain the last 1 MiB and signed total/capture status. No success/advisory raw log is written.
- Strip GitHub command-file/token variables, encryption keys, TF_LOG* and TF_CLI_ARGS* from captured Terraform and pre-apply scope-check children; keep AWS STS credentials including AWS_SESSION_TOKEN. Publish only a validated owned single ciphertext path, gated by dispatch plus failure/cancellation, with attempt-specific artifact names and five-day retention.
- Fixed public audit fields distinguish command, capture, retention and cleanup status; numeric standard Terraform success counts never include resource/output text. Missing summaries stay unavailable. Schema-2 failure HMAC uses its own domain with the existing CBC cipher/key. Recovery verifies the exact failed attempt and emits fixed timeout/errors; private inspection remains authenticated and bounded to 32 MiB.
- The sealing payload reaches OpenSSL through stdin, with no plaintext staging file. Captured Terraform runs in a separate session; first-interrupt forwarding, second-interrupt group kill and parent-death protection govern cancellation. Sealing/storage/publication failures preserve the command exit.
- Cleanup deletes only after the identified upload's literal success; failed/cancelled/skipped/unknown outcomes retain ciphertext privately. Audits distinguish pending_upload, retained_unpublished and final cleanup outcomes. No broad runner-temp sweep, shared-UID isolation or SIGKILL guarantee.
- `v2/ci_deployment_audit.py` is manual dev-only, with a restrictive session and fixed reads/SELECTs. It shares backend parsing and state-KMS resource selection with `ci_verifier_sessions.py`; the decrypt resource follows the shared `encrypt` rule. State-object/account/S3-context restrictions and the no-invoke boundary remain. Preserve identity/resource guards and safe output projection; current web status, event metrics and observed SQL-reader rows never establish full deployment readiness. Tests: `test_ci_deployment_audit.py`; guide: `docs/runbooks/deployment-audit.md`.
- `v2/ci_verifier_sessions.py` supplies policies for manual collection and Deploy Web verification:
  backend/workload restrictions, no AWS calls or persistent IAM changes. Workload state must
  come from the consumer's private capture. Manual dev collect-runtime dispatches support
  backend/workload and prepare/collect; dev deploy-web push/dispatch supports workload collect
  only, never backend/prepare. Both workflows consume these policies. Dev verification
  needs an activated runtime and private proof credentials/state for both push and dispatch.
  Missing proof fails closed; each refresh needs a nonempty policy. State must share the selected private directory.
  Prepare has no Lambda grant; collect permits only the
  owned collector. The consumer enforces explicit catalog and validated per-type RequestResponse payloads
  (missing type means all), distinct catalog/succeeded replies and post-marker authenticated
  freshness/runtime/worker proof. Application inventory writes are operator collection, not an
  ADR-005 exception. Tests: `test_ci_verifier_sessions.py`; guide: `docs/runbooks/runtime-verifier-sessions.md`.
- `v2/ci_runtime_policy.py` binds development/preview CI roles and STS accounts. The dev profile pins inventory/worker digests and enforces read-only flags even without a discovery rollout; direct dev host-only settings require that profile.
  Plan's optional nonsecret `CI_STEAMPIPE_AWS_FILL_RATE_DEV` requires full scope and that verified dev profile;
  empty preserves configuration. Apply replays the saved plan, not the current repository variable.
  Canonical contract: [Steampipe refill override](../docs/runbooks/steampipe-quota-and-staleness.md#development-ci-refill-override).
- Dev/preview private discovery requires explicit full-plan rollout and preserves public DNS/certificates. `runtime-ecr-bootstrap` permits exactly three repositories. Manual dev/preview deployment blocks listed core teardown/replacement/forget and has no retirement mode; main is outside this development policy.
- `v2/ci/prepare-runtime-host.mjs` requires actual login/DB/host-registry proof before manual full dev activation plans; apply rechecks the approved profile. Automatic PR/push plans never receive the host-probe credential. Database-only proof is rejected; credentials stay private and failures use a fixed code. Flags/policy checks do not prove live access.
- `v2/ci_db_diagnostics.py` is default-off manual dev-plan diagnostics. Both workflow and helper
  require `workflow_dispatch`, literal `CI_DB_DIAGNOSTICS_DEV=true`, and `--target dev`;
  region is fixed to `ap-northeast-2`. Invalid invocation context causes no AWS calls.
  State-account/STS consistency does not authorize access or detect the wrong same-account stack.
  Use existing read-only grants and a fixed CLI verb allowlist; no new grants/writes/DB connection.
- Run only after encrypted plan upload. Opt-in publishes fenced safe JSON, including posture
  booleans, to the public Actions log and step summary. This optional DB step tolerates failure (eight-minute limit), as does the separate
  advisory readiness-plan summary; DNS/CI/readiness gates remain required.
- Retain all four sections independently: `logs`, `configuration`, `server_logs`, `rds_metrics`. Capped/failed reads with
  retained evidence are partial; distinguish unavailable source reads from unknown derived
  fields. Early context/input/identity failure returns only `{"status":"unavailable"}`.

- `no_matching_events` labels empty accepted samples; `no_error_inference=true` prohibits
  no-error/healthy conclusions from zero counts in every status. A known authenticated DB
  probe must fall within the returned one-hour window before interpreting the sample.
  Successful task-definition reads remain source-available for missing/malformed web containers;
  use `web_container_found` and derived-unknown flags. Discarded milestones and regex inputs
  shortened to 4,096 characters make samples partial; read-only violations are not swallowed.
- Web logs use JSON `evt` OR for ping errors and connection-stage observations: fixed one-hour
  bounds, oldest-first, at most 3 × 100 with `--next-token`/`--limit`. Only fixed phases/milestones
  and finite 0–3,600,000 ms durations are emitted; milestones cannot exceed elapsed. Latest
  timing describes the returned sample. Count invalid timings/discarded milestones explicitly.
- RDS reads at most two latest observed PostgreSQL files from at most three listing pages.
  Each download is newest 500 lines without Marker (1 MiB cap per file). FATAL/ERROR/PANIC
  web-role lines count as errors. `benign_role_mentions` counts exactly non-error-severity
  lines mentioning `awsops_web`; lines for other database roles are ignored. Never print
  filenames/raw lines. Failed downloads retain listing metadata as partial.
- Pool-acquire timeouts, unexpected connection loss, HBA rejection, TLS errors and PostgreSQL
  client/slot limits have distinct fixed categories. Metadata describes the service target
  definition, not running revisions; credential declarations do not prove runtime values.
  Exact inline-Allow/SG comparisons do not prove effective access or connectivity. Never
  waive authenticated DB/login readiness or expose Terraform/AWS error details.

- `rds_metrics` adds one bounded CloudWatch get-metric-data request for the configured first
  instance: seven IAM-auth Sum series, CPU Average, free-memory Minimum and capacity Average.
  Preserve fixed IDs, status/missing/invalid flags and at most 60 minute points per series;
  never publish remote labels/messages/tokens. Configured min/max ACUs are numeric or null.
  Clean Complete+empty is an available read with missing=true; Forbidden/InternalError is
  unavailable and PartialData or malformed/degraded reads are partial. `read_ok` describes
  the response envelope only. Instance metrics cannot attribute a probe outcome or authorize tuning.
  Prefix/message filters reject bare and mid-line tokens, but full-prefix SQL continuations
  and RAISE LOG can forge lifecycle text. Keep lifecycle_source_integrity=unverified_text,
  lifecycle_injection_possible=true and unknown probe outcome. Auth-success messages need
  log_connections (PostgreSQL default off, not enabled here); the uninspected setting stays null.
- `ci_plan_context.py` accepts only successful explicit same-repo/branch/SHA plan dispatches.
  PR/push plans are advisory. `ci_dns_policy.py` preserves managed certificate ownership and
  service aliases; blocks all public/private DNS mutations unless authorized, including Cloud
  Map and validation records. Routine CI cannot retire owned validation records.
- `ci_dev_domain.py` writes gitignored overrides for console/plan; reject tracked copies.
  Domain rollout is saved-plan metadata, not apply-time authority. No account-wide cert scan.
- Smoke scripts keep credentials/HTTP scratch in private 0700/0600 files with cleanup; publish
  only fixed phases and validated HTTP status. Never reset credentials to pass verification.
- Migration credentials stay in memory; verify RDS TLS and immutable baseline/ULID checksums.
  ULIDs have 26 Crockford-base32 characters (no I/L/O/U). Standalone empty-only initialization is atomic;
  automatic web calls reject a missing ledger before that hook, even with the template's retained flag;
  elevated/missing reader roles and connection/cleanup errors block migration/deployment.
  Worker/migration images are ARM64, nonroot where applicable, and use CMD rather than ENTRYPOINT.
- PR panel/chair Claude calls require `--strict-mcp-config`; allowed-tools is not a substitute.

## Local verification

Runtime image/provisioning: verify the independent account, configured role, actual STS caller
and ARM64 digest. Build-role scopes cover `-steampipe`/`-worker`; deployer scopes cover `-agentcore`.
Web-only ECR grants are insufficient; IAM is separate. No repository creation or latest-tag writes.
Verify the exported image archive tag/Linux/ARM64 config and bind its byte hash to ECR. Tar reads
validated hash paths with bounded output and no AWS credentials; BuildKit metadata is not required.
The host provisioner uses a private Python 3.12 environment with hash-pinned SDK wheels,
credential-free install/preflight, source-derived operation checks, exact SDK versions and imports.
Base-Python cleanup warns on package-removal failures without overwriting deployment results.
Dev requires applied migration infrastructure and non-null `migration_job`, private migration,
then bounded digest-bound phases with fresh same-role sessions. Guard selection uses TARGET/dev ref.
Provision-only never rebuilds. Fixed diagnostics preserve failure codes without raw secrets/ARNs.
Smoke uses applied readiness enablement and nonce/account/freshness evidence; legacy checks stay
advisory, transport errors fatal. Full web/collection/worker proof remains separate.

```bash
python3 -m pytest -q scripts/v2/test_ci_db_diagnostics.py
python3 -m pytest -q scripts/v2/test_ci_*.py
npm ci --prefix web
npm ci --prefix scripts/v2 --ignore-scripts --no-audit --no-fund
node --test scripts/v2/ci/*.test.mjs
node --test scripts/v2/ci/migration.itest.mjs scripts/v2/ci/web-db-connection.itest.mjs scripts/v2/ci/agent-tool-policy.itest.mjs
```

All three PostgreSQL suites are required and fail rather than skip when prerequisites are missing.
They require bare `docker` on PATH, a reachable daemon, OpenSSL and `postgres:17`, without an
automatic `sudo`/`DOCKER` override. The web connection and policy suites use the locked web driver and TypeScript. The policy suite covers sticky restrictions and concurrent edits; the web suite covers connection phases, asynchronous passwords and error propagation.

The CI glob also needs Python boto3/botocore (`pip install -r agent/requirements.txt`).
The CI fixtures use mocked AWS responses or local Terraform backends, not live AWS. Terraform
checks use 1.15.7 with isolated data and mocked providers; dependencies are declared in
`v2/requirements-test.txt`. Do not initialize a real backend for tests.

Runtime smoke configuration is explicit and private: prepare checks registration, verify
checks fresh collection, real runtime access and workers. Optional hostOnly rejects members.
Cap the file at 16 KiB; require a start no older than 30 minutes at validation and unique types including cloudfront.
HTTP files default to 64 KiB; only the CloudFront inventory leg allows 2 MiB. The utility
alone does not change workflow wiring.

## Plan asset utility

`v2/ci_tf_assets.py` prepares the hash-locked pg8000 closure and validates plan/SHA/scope,
paths, modes and hashes; every ZIP with a known saved-plan hash must be present and match.
Deferred archives without known hashes are excluded. Both pack/restore APIs allow GitHub
push, pull_request and workflow_dispatch only, or explicit local commits without a GitHub event.
They use TF_PLAN_ENC_KEY HMAC.
The 0600 tarball is private secret-bearing scratch, with no upload path;
callers require encrypted GitHub handoff or private SSE-KMS storage and owned cleanup.
Both Terraform layer paths use the same locked build-layer command, or check-layer for
CI_ASSETS_READY=true, also exported by plan/apply. Prepare invalidates markers, removes stale regular ZIPs and rejects ZIP
symlinks. Schema-2 markers bind file hashes; validation checks a fixed required-import list.
The pin gate covers `v2/ci/pg8000-requirements.txt` and the four requirements
under workers, steampipe, incident and remediation; update all with verified wheel hashes.
The separate Steampipe Dockerfile pin/installer is outside that Lambda lock and validator.
`v2/test_ci_tf_assets.py` covers these contracts and recovery.

## Development release controller

Dev releases require identity/image/code, complete post-marker collection for every catalog type with known counts/zero unknowns, fresh known CloudFront, SSM/model and both workers. Collect synchronously through at most four workers; no partial/degraded fallback. Use authenticated DB time and conservative request-start calibration; preserve strict lower bounds/deadlines and stop on missing clock evidence.
Preserve the strict proof-budget, digest and retry contract in `docs/runbooks/runtime-foundation.md`.
Prepare is existing-web only; no password reset, admin promotion or full-gate bypass.
Manual session scopes and cleanup follow `docs/runbooks/runtime-verifier-sessions.md`.

Runtime smoke accepts verify-only inventoryPolicy=full and collectionMode=release; omission
keeps strict supplied-type checks. Full quality is programmatic; the caller discovers types.
Collection polls share a nominal 10-minute cap, or 20 in release mode, clipped by remaining
absolute/proof budgets; the controller does not reserve a full twenty-minute wait. Every runtime call is bounded by
marker+30min (prepare: entry+30min), shortened by explicit deadlines. One proven collision
permits a cooldown/revalidation retry. No workflow or billed capability is activated.
Require full HTTP timeouts remaining, and probe/worker budgets before billing or enqueue:
80s probe, 370s per worker; retry also needs 65s cooldown and a 35s collection read.
Collection windows are caps; late completion can fail admission.
Post-marker running attempts with old/null previous success time out as collection_timeout;
full-policy stale terminal evidence is collection_stale. Login/DB also require full timeouts.
`readRuntimeSmokeConfig(file, credentialFile, now = Date.now())` accepts a finite numeric
validation time; controller callers pass calibrated `now()` without changing marker/expiry.

## Strict release controller capability

`v2/ci/runtime-release.mjs` drives mandatory dev Deploy Web and manual collect-runtime
verification. Dev releases verify exact ECS/image proof first and pass `EXPECTED_WEB_DIGEST` from `steps.pin.outputs.digest`.
Full releases require collect mode (including login/DB); prepare never establishes full readiness.
Explicit activation remains separate and inactive prerequisites cannot be skipped.
It binds dev source/account/actual role, applied runtime identity and ARM64 web digest.
Require the pinned 43-name baseline, source-AST checked; valid growth is allowed up
to 128 types. Every returned type
needs post-marker succeeded evidence, known counts and
zero unknowns, with at most four concurrent in-flight synchronous owned calls. Prepare obtains authenticated
DB time plus host proof; calibration anchors at request start and shifts the existing
deadline equally. No lower-bound freshness tolerance or rolling prior success is introduced.
Legacy host-only registry violations retain `host_only_registry_required`.
Both modes default to the enabled host only. Applied targets require exact enabled
host/member registration, measured SQL reachability over enabled scan accounts with zero
unreachable accounts and fresh account-bound EC2/CloudFront member evidence from one
exact minimal `/api/deployment/member-inventory` lookup. Explicit scope preserves null for
host-only/unmeasured counts; CI allows host-only/null only for five source-AST-pinned
SDK types, not 43-type coverage for every member. Only Terraform onboarding preflight permits approved subsets;
apply reads the restored saved plan, never a newer secret. Runtime release stays exact.
AWS CLI children use an explicit
credential/settings allowlist, pinned path, disabled config/credential files/metadata
and endpoint isolation; drop ambient profiles/providers/CA/proxy/hooks and CI secrets.
First chronological terminal failure stops new type admission; admitted work settles
and untouched types remain `not_started`. Six status buckets partition `expected`:
a selected type unable to admit its first call under the 450-second floor is
`deadline`/zero attempts; never-selected is
`not_started`/zero attempts. Inventory quality gaps may overlap. Keep the outer
`Runtime release:` and the prefixes of passed-through `SmokeError` messages;
direct `RuntimeSmokeError` config failures can become controller fallbacks.
RPC/ledger suffixes must not be normalized together. Partial/unknown results are expected hard
stops under limiter/hydrate load too; investigate capacity, reachability or denials
before an authorized fresh bounded rerun. No weaker acceptance or scheduler suppression.
Collector hash/RevisionId must remain stable before/after collection; then full
SSM/AgentCore/model and both owned worker proofs remain mandatory. Preserve private
credentials/cleanup, restrictive consumer sessions and reviewed activation prerequisites.
Collect's closing service/list/tasks reads reuse the original opaque deployment ID,
immutable task-definition ARN, count and digest set; never resolve the ECR tag again.
A changed ID fails even with the same task definition. Matching snapshots are not
continuous/history proof or an atomic lock. Prepare has no closing recheck.
Budgets and boundaries: `docs/runbooks/runtime-foundation.md#strict-release-controller-capability`
and `runtime-verifier-sessions.md`. Each explicit target adds 35 seconds to the proof
reserve and removes 35 seconds from collection/admission. Empty-target budgets:
the 18-minute reserve covers a single-pass
1,060-second path plus 20 seconds. Auth proof ends 50 seconds before the original
deadline for three 15-second closing reads plus five seconds overhead, still within
the original window. Collection is at most 720 seconds; 450-second admission requires
a start by 270 seconds minus preparation/earlier bounds. An extra 35-second read
needs at least 15 seconds saved. Full retry overhead is at least 215 seconds and
needs 195 saved: confirmation spends 35 seconds before the helper's remaining
180-second allowance. Worker allowances are reused. Extras are not guaranteed.
`capture` reads private deployment JSON on stdin and emits `deployment_file` to
`GITHUB_OUTPUT`; `run` reads `RUNTIME_DEPLOYMENT_FILE`. Both need private credentials.
CLI inputs and fixture prerequisites: `docs/runbooks/runtime-foundation.md#controller-cli-contract`.
Catalog/per-type timeouts: `docs/runbooks/runtime-verifier-sessions.md#collection-effects-and-proof`.
`remaining_prerequisites: "not_assessed"` retains separate workflow/plan/promotion gates;
use the canonical fixed-code operator table in that runbook.
Tests: `node --test scripts/v2/ci/runtime-release.test.mjs scripts/v2/deployment-smoke.test.mjs`.
The dated owner requirement supersedes the earlier CloudFront-only proposal.
Four lanes do not promise fourfold throughput or completion for every workload.
Keep the schedule active and fail closed on budget/permission/contention failures;
the runbook records one feasible measured workload, not a latency guarantee.


## Private plan transport

Private S3 helpers require a private backend file and existing bucket/IAM/KMS posture.
Publish/apply enter branch environments; only backend/tfvars absence soft-skips.
Public references omit storage bindings and plan hashes; CLI results omit plan hashes.
Mask the reviewed input before step environments. Private digests select exact bytes;
CI still checks asset HMAC and original gates. Read-only lifecycle validation requires
the owner-configured plan-prefix 7-day current/noncurrent expiry and 1-day multipart abort.
Expiration is asynchronous; scoped purge and current-run scratch cleanup remain separate.
Purge is a manual AWS-CLI runbook procedure, not a helper mode or a required scheduled task.
Its complete listing must contain no young data versions; delete markers need no age cutoff.
SSE-KMS readers need no CI envelope key: review effective S3/KMS access before rollout.
Generated policy is publisher-only; Apply retains its own authorization. Legacy `tfplan`
runs use the historical inspector.
The workflow wires the four helper modes with Plan / Publish private plan job contracts,
attempt-specific tfplan-N references, protected storage sessions and existing apply guards.
The helper has no orphan recovery, legacy fallback or Terraform apply operation. Contract:
`docs/reference/private-plan-transport.md`; validate both helper and consumer workflow tests.

This is operator CI artifact transport, not an ADR-005 exception; no frozen product capability is enabled.

## Isolated review codec

`pr-review/codec_sandbox.py` prepares a digest-pinned Python/Pillow decoder image and
runs bytes in a non-root, network-none, read-only container with no workspace mounts.
No direct host fallback is allowed. State binds an immutable image, owned tag and run
label; per-decode and final cleanup are bounded and scoped to that ownership.
`v2/test_review_codec_sandbox.py` requires prepared Docker state and verifies actual
confinement, transport and cleanup. Privileged review wiring is a separate change.
