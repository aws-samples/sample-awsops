<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: adfa7b96e07e · generated-at: 2026-09-14 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Scripts — Reviewer Context

Deployment/ops scripts live under `v2/`; PR review automation lives under `pr-review/`.
Run from the repo root. Node dependencies are in `scripts/v2/package.json`, not the root.

Changed HEAD PNG evidence is staged from bounded Git blobs before review credentials.
All panel lenses and the chair share its manifest and read-only generated paths;
BASE pixels are historical. Required unavailable images fail coverage, never suppress
findings. No HEAD execution or permission expansion. See `docs/runbooks/pr-review-head-images.md`.

## Diagnostic and deployment boundaries
- `v2/ci_web_image.py` is unwired. CI must use composed `promote`, which verifies the
  caller/context/source/migration/producer before publishing the validated project's digest.
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
  suppressing another successful receipt. Three-field stdout adds no recovery history.
  Project selection requires authenticated branch Terraform/verified job output, never inputs.
  Target one verified stack repo per operation; broad IAM is not branch/stack authority.
  Unconfirmed publication is a provider/retry diagnosis, not a rebuild signal; retain equal-effect
  confirmation. Use 0600 manifest files, bounded ZIP reads and ARM-child attestation references.
  Operation labels do not restrict the shared consumer's ECS/STS calls.
  Child PATH is `/usr/local/bin:/usr/bin:/bin`, ignoring caller additions; HOME is omitted, never reassigned.
  No manually assembled publishing chain. `test_ci_web_image.py` requires jq; the future
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
  only, never backend/prepare. Workflow wiring and earlier Deploy Web deployment credentials
  remain consumer responsibilities; the helper installs neither consumer path. Dev verification
  needs an activated runtime and private proof credentials/state for both push and dispatch.
  Missing proof fails closed; each refresh needs a nonempty policy. State must share the selected private directory.
  Prepare has no Lambda grant; collect permits only the
  owned collector. The consumer enforces explicit catalog/CloudFront RequestResponse payloads
  (missing type means all), distinct catalog/succeeded replies and post-marker authenticated
  freshness/runtime/worker proof. Application inventory writes are operator collection, not an
  ADR-005 exception. Tests: `test_ci_verifier_sessions.py`; guide: `docs/runbooks/runtime-verifier-sessions.md`.
- `v2/ci_runtime_policy.py` binds development/preview CI roles and STS accounts. The dev profile pins inventory/worker digests and enforces read-only flags even without a discovery rollout; direct dev host-only settings require that profile.
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
  ULIDs have 26 Crockford-base32 characters (no I/L/O/U). One-shot initialization is atomic;
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
node --test scripts/v2/ci/migration.itest.mjs scripts/v2/ci/web-db-connection.itest.mjs
```

Both PostgreSQL suites are required and fail rather than skip when prerequisites are missing.
They require bare `docker` on PATH, a reachable daemon, OpenSSL and `postgres:17`, without an
automatic `sudo`/`DOCKER` override. The web connection suite uses the locked web driver and
TypeScript, covering phase/timing logs, asynchronous passwords and original error propagation.

The CI glob also needs Python boto3/botocore (`pip install -r agent/requirements.txt`).
The CI fixtures use mocked AWS responses or local Terraform backends, not live AWS. Terraform
checks use 1.15.7 with isolated data and mocked providers; dependencies are declared in
`v2/requirements-test.txt`. Do not initialize a real backend for tests.

Runtime smoke configuration is explicit and private: prepare checks registration, verify
checks fresh collection, real runtime access and workers. Optional hostOnly rejects members.
Cap the file at 16 KiB; require a recent start (30 minutes) and unique types including cloudfront.
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

Runtime smoke accepts verify-only inventoryPolicy=full and collectionMode=release; omission
keeps strict supplied-type checks. Full quality is programmatic; the caller discovers types.
Collection polls share 10 minutes, or 20 in release mode. Every runtime call is bounded by
marker+30min (prepare: entry+30min), shortened by explicit deadlines. One proven collision
permits a cooldown/revalidation retry. No workflow or billed capability is activated.
Require full HTTP timeouts remaining, and probe/worker budgets before billing or enqueue:
80s probe, 370s per worker; retry also needs 65s cooldown and a 35s collection read.
Collection windows are caps; late completion can fail admission.
Post-marker running attempts with old/null previous success time out as collection_timeout;
full-policy stale terminal evidence is collection_stale. Login/DB also require full timeouts.


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
