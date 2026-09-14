<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: f75df677709e · generated-at: 2026-09-14 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Runbooks — Reviewer Context

Operational playbooks organized by scenario, each following symptoms → diagnosis → action. See
`docs/runbooks/CLAUDE.md`'s index for the current runbook list (several are marked **v1
(legacy)** — v2 has since replaced their procedure with a different mechanism; don't treat a
legacy runbook's steps as the current operational path).

## Deployment review checks
- Release safety primitives remain unwired to web workflows. Automatic transactional pending-SQL checks are opt-in; column/view and non-transactional changes require reviewed cutovers. The empty-only frozen baseline precedes pending admission. Contention fails immediately under the shared lock. Read retries share a deadline and never retry writes; failed/replaced ECS deployment evidence is terminal. See `release-safety-primitives.md`.

- S3 runbooks must state backend-file, bucket-posture and existing role/key-policy prerequisites,
  branch-environment approval for publication/apply, missing-backend/tfvars soft skips and
  hard failures for missing publisher roles. No automatic permission/configuration changes.
- Public references contain source context and manifest hash only; no storage bindings or
  plan digest. Mask the reviewed input before any step environment; hashes select bytes,
  not human review. CI asset HMAC remains mandatory. Require owner-installed plan-prefix
  lifecycle (7-day current/noncurrent, 1-day multipart abort), rejecting conflicting
  expiry/archive at or before five days. The workflow never applies the optional bootstrap.
  Expiration is asynchronous; optional purge and runner-loss cleanup remain separate.
  Review effective S3/KMS readers; they need no CI envelope key. Publisher policy requires
  SSE-KMS on PUT independently of read permissions.
- The web provenance helper is unwired; `web-image-provenance.md` defines future receipt
  steps, current-dev migration outputs and recovery limits. Require composed `promote`;
  never fabricate migration evidence or fall back to mutable tags as provenance.
  All paths require a preflight digest; fresh promotion also checks its source tag.
  Preserve OCI indexes and verify an unambiguous ARM64 image/config. The producer uses
  ci-build credentials, promotion uses the deployer; producer and reuse-capable consumers
  need `actions: read`, dedicated fresh-only consumers do not.
  Document upload-artifact v4 with required Artifact API digest and scoped config-download permission; ECR publication
  supplies explicit media.
  Preserve three-field stdout with no history API. Recovery requires independently retained
  source/digest evidence and owned run/attempt cleanup; migration/preflight assertions
  come from verified job outputs, never dispatch inputs.
  IMAGE_PROJECT comes from authenticated branch Terraform/verified job output and independent
  ECR/cluster/service checks. Existing broad IAM is not stack authority: one verified repo
  per operation, exact repo ARNs for new grants. Distinguish publication/provider failures
  from invalid candidates and document completed-producer/superseded-push handling.
  Provider subprocesses disable AWS config files, isolate GH config and filter endpoint/profile/model/provider/CA/proxy
  overrides, retain explicit exported auth, and keep signed curl URLs in private stdin.
  Multi-tag digest reads require consistent identities and identical manifest bytes/media.
  Child PATH uses only `/usr/local/bin:/usr/bin:/bin`; HOME is omitted, never reassigned.
- Verification policies accept manual collect-runtime dev dispatches for backend/workload and prepare/collect, plus deploy-web dev push/dispatch for workload collect only (backend/prepare refused). The helper installs neither consumer path. Dev integration needs activated runtime prerequisites and private proof credentials/state for both events; missing proof fails closed. Consumers enforce nonempty restrictions and owned-file cleanup. Collect permits only the owned collector; its application-data effects are operator CI, not an ADR-005 exception. IAM cannot restrict event payloads: the consumer enforces catalog/CloudFront RequestResponse calls and synchronous plus authenticated HTTP proof. The separate deployment audit remains no-invoke. Contract: `runtime-verifier-sessions.md`.
- `ci_readiness_plan_summary.py` runs before encryption only for explicit full dev readiness
  plans, with a two-minute timeout and fenced JSON output. Its failure-tolerant report publishes
  fixed scope/presence checks, fixed addresses and a known collector hash, never private values.
  The combined 256-row view is not approval or resource-presence proof; unknown changes require
  private inspection. Membership checks include the existing/planned group's lack of an IAM role.
  Reporting cannot weaken DNS/runtime/exact-plan gates or block the encrypted handoff or private publication.
- Private S3 plan inspection validates source/reference, manifest, version and hash before bounded local rendering; CI alone verifies asset HMAC. Inspection never authorizes apply.
- Branch-independent artifact inspection/recovery lives in `dev-repo-setup.md`; domain rollout remains dev-only. Linux capture forwards the first interrupt, kills the child group on a second and arms parent-death SIGKILL; cancellation is not rollback.
- Plan/apply capture drains a 1 MiB tail in memory, preserving the command exit independently of scratch writes. Fixed audits include capture/retention classes and available numeric success action counts; no raw automatic-run diagnostics.
- Only an owned single ciphertext file can be uploaded for dispatch failure/cancellation, under an attempt-specific name. Schema-2 failure HMAC uses a separate domain; recovery authenticates the original attempt. Keep AWS_SESSION_TOKEN while removing GitHub channels/tokens, encryption keys, TF_LOG* and TF_CLI_ARGS* from Terraform child environments.
- Sealing uses OpenSSL stdin without plaintext staging. Captured Terraform uses Linux parent-death protection and escalates a second interrupt after graceful first-interrupt forwarding.
- Key/storage/seal/publication/cleanup outcomes are distinct. Delete owned ciphertext only after the identified upload succeeds; failed/cancelled/skipped/unknown uploads retain it privately. Audits report pending_upload and final upload/cleanup outcomes; no broad temp sweep, host-loss guarantee or shared-UID isolation.
- `deployment-audit.md` separates manual dev observations under backend-bound and workload-read sessions. Preserve identity/resource guards and private cleanup. Web and AgentCore observations do not prove applied versions or invocation readiness; observed SQL-reader types never establish complete inventory.
- `runtime-foundation.md` covers account-bound default-off activation and saved-plan assets. Dev/preview private discovery requires explicit full-plan rollout and DNS permission; public DNS/certificates remain blocked. `runtime-ecr-bootstrap` creates three repositories.
- The dev profile enforces read-only flags and real login/DB/host-registry proof at manual plan/apply; direct dev host-only settings require it. Automatic PR/push plans do not run the credentialed host probe. Manual dev/preview deployment blocks listed core teardown/replacement/forget and has no retirement mode; main is outside this development policy. Configuration checks are not live-access proof.
- Before promoting the IAM changes from dev to main, require reviewed dev apply and live gateway/chat, worker-diagnosis and tagged SFN/Fargate evidence. Mock plans do not satisfy this promotion gate; this dev PR does not authorize production apply.
- `scripts/v2/ci_tf_assets.py` shares Terraform's locked layer installer. Prepare invalidates
  markers, removes stale regular ZIPs and rejects ZIP links. Pack requires known planned ZIPs;
  untargeted Lambdas are absent from targeted planned_values. TF_PLAN_ENC_KEY HMAC binds plan/SHA/scope and
  file paths/modes/hashes. Both APIs permit push/pull_request/workflow_dispatch, or explicit
  local commits without an event. Old signed bundles require their matching prior key after rotation.
  The 0600 archive may contain signing keys; use encrypted GitHub handoff or private SSE-KMS
  storage and clean owned plaintext/staging. Terraform plan/apply now wire pack/restore.
  CI_ASSETS_READY=true validates restored layers without reinstalling. See
  `scripts/v2/ci/pg8000-requirements.txt`, `scripts/v2/test_ci_tf_assets.py` and
  `docs/reference/06-workers.md`.
- `CI_DB_DIAGNOSTICS_DEV` is default-off and advisory, enabled only by manual `workflow_dispatch`
  dev plans with literal flag `true`, `--target dev`, and region `ap-northeast-2`. Invalid context
  causes no reads; state-account/STS is consistency only, not authorization or stack isolation.
  Run after encrypted plan upload. Opt-in publishes fenced safe JSON including posture booleans
  to the public Actions log/summary; this optional DB step and the separate advisory
  readiness-plan summary tolerate failure.
  Keep DNS/CI/readiness gates required and the fixed read-only CLI verb allowlist.
  Retain all four sections independently (`logs`, `configuration`, `server_logs`, `rds_metrics`): partial for retained capped/failed reads,
  separate unavailable source and unknown derived fields. Early failure is only
  `{"status":"unavailable"}`. Never publish raw logs/filenames or Terraform/AWS errors.
  Web logs use a fixed one-hour oldest-first 3 × 100 sample and JSON `evt` OR; timing keys are
  fixed, durations finite and bounded, and latest means latest valid returned observation.
  RDS selects at most two latest observed files and downloads newest 500 lines each without
  Marker. Only FATAL/ERROR/PANIC web-role lines are errors. `benign_role_mentions` counts exactly
  non-error-severity lines mentioning `awsops_web`; lines for other database roles are ignored.
  Pool timeout is distinct from lost connection, HBA and PostgreSQL capacity failures.
  Service-target/declaration/inline-Allow comparisons are hypotheses, not runtime/access proof.
  The dev runbook's Development variable catalog and Aurora component reference register this path.

- `no_matching_events` labels empty accepted samples; `no_error_inference=true` prohibits
  no-error/healthy conclusions from zero counts in every status. A known authenticated DB
  probe must fall within the returned one-hour window before interpreting the sample.
  Successful task-definition reads remain source-available for missing/malformed web containers;
  use `web_container_found` and derived-unknown flags. Discarded milestones and regex inputs
  shortened to 4,096 characters make samples partial; read-only violations are not swallowed.

- The configured first instance's metrics are an optional manual-plan read, not a tuning action.
  Its single CloudWatch get-metric-data batch contains seven IAM-auth Sum metrics and CPU
  Average, free-memory Minimum, capacity Average. Limit each series to 60 minute points and
  expose fixed IDs/status/missing/invalid flags; suppress remote labels/messages/page tokens.
  Show configured ACU minimum/maximum as numbers or null. `read_ok` means an accepted envelope.
  Available/partial/unavailable describes the read independently of data presence: clean
  Complete+empty is available/missing, Forbidden/InternalError unavailable, degraded reads partial.
  Lifecycle counts have no provenance guarantee: full-prefix SQL and RAISE LOG can forge them.
  Always mark lifecycle_source_integrity=unverified_text, lifecycle_injection_possible=true
  and unknown probe outcome.
  Genuine auth-success logging needs log_connections, which defaults off in PostgreSQL and
  is not enabled here. Its effective value is uninspected and reported as null. Never tune from these counts.
- `ci_migrations_enabled` / `CI_MIGRATIONS_ENABLED_DEV` is default-off. The manual
  dev AgentCore workflow requires the reviewed true plan applied and non-null `migration_job` output before dispatch; setting a variable or generating a plan alone is insufficient. The manual
  `deploy-migrations.yml` + `run-migration.mjs` controller starts one verified private
  ARM64 task. Its IAM reads exact Aurora secrets; DB DDL uses those credentials.
  It enables no product AWS-resource mutation/autonomy (ADR-005).
- `dev-repo-setup.md` covers CI/OIDC, protected review recovery, ECR preflight and explicit
  same-branch/SHA dispatch plans. PR/push plans are advisory.
- `dev-domain-rollout.md` covers unpublished/same-domain dev stages only. Every domain-stage
  plan sets `domain_rollout=true` (dev/full only), pinned as default-false Terraform metadata
  `ci_domain_rollout`. Apply reads the saved marker, not current repo vars or an apply toggle.
  Scoped DNS permits only configured service A/ACM CNAME owners in the selected zone.
  Published old-domain retirement needs a separate expressly authorized plan under the old
  configuration; do not expand scope or accept unknown identities to make a rename pass.
- Dev repo name overrides feed console and plan through gitignored auto-tfvars; reject tracked
  copies before generation. Dev advisory preflight preserves ownership/publication from state
  without live ACM/SAN/trust validation. Its DNS allowance is reporting only, never apply
  authority. `CERTIFICATE_MODE_DEV` preserves ownership or selects managed issuance.
- Keep managed certificates as JSON null and preserve existing service aliases. External
  certificates must be operator-selected or already attached; never scan the account.
  Routine CI cannot externalize managed certificates or delete/replace owned validation CNAMEs,
  even with DNS permission. Ownership migration and record retirement need separate review.
- ALLDNS includes private Cloud Map, validation CNAMEs and registered ECS task changes:
  Steampipe tuning, hydrate-fallback remedies and rollback/disable can change private DNS.
  Ordinary full plans (`domain_rollout=false`) retain broad DNS behavior only with explicit
  permission. No private-DNS exception. Authorized cutovers set `allow_dns_changes=true` on
  both plan and apply; documentation is not authorization.
- Public summaries permit certificate suffixes, publication, change counts/addresses and
  active-rollout public zone name/ID/NS; readiness reports add fixed posture/presence checks
  and a known collector hash; diagnostics permit bounded metric values. Never expose full ARNs, account IDs or raw
  configuration/state/plan JSON. Deploy Web/manual smoke share the argv-safe Host/SNI/TLS
  CLI; health proves liveness only. Verify DB/auth separately before service A publication.
- From the repo root, `bash scripts/v2/terraform-test.sh` runs Terraform 1.15.7 in an isolated
  tracked-file copy with fresh `TF_DATA_DIR`, `init -backend=false` and mocked providers.
  Never initialize a real backend for tests. Dependencies: `scripts/v2/requirements-test.txt`;
  Node smoke tests are also required by the shared merge script.
  Root Python command: `python3 -m pytest -q scripts/v2/test_ci_*.py`.

## Conventions
- Filename: `kebab-case.md`, domain-then-topic order.
- Structure: symptoms → candidate causes → verification commands → action → related files/ADRs.
- New or rewritten runbook bodies and context files are English-only. Preserve facts
  when maintaining old bilingual documents; do not require parallel translations.
  Multilingual product guides remain under `docs-site/`.
- Commands should be copy-paste ready; cite the related ADR number(s) at the bottom.
- Do not let a runbook embed secrets, AWS account IDs, ARNs, or live domains.

## Known false-positives
- A runbook marked **v1 (legacy)** describing a procedure that no longer matches v2's
  architecture is intentional — it's kept for reference during the v1 decommission window
  (ADR-016), not stale content to delete outright.

## Authenticated development verification
- Apply both `agentcore_enabled` and `ci_readiness_enabled`, then provision AgentCore.
  Verify also requires active inventory/dispatch, `workers_enabled=true` and deployed ARM64 worker images.
  Only that output boolean enables `DEPLOYMENT_READINESS_ENABLED`; no shell override.
  A reviewed apply with readiness and AgentCore enabled creates only deployment-verifiers;
  membership additionally requires the managed demo flag. No admin/IAM role is granted.
  Existing ID-token group claims can persist for their remaining 12-hour lifetime unless
  session revocation rejects them; use the canonical runtime-foundation readiness guidance.
  Disabled AgentCore blanks only the web task's `SSM_RUNTIME_ARN_PARAM`; invocation/status
  lookup honor it. The separate alias and incident bridge paths remain literal. Status lookup
  does not validate the full ARN and can still perform other control-plane reads.
  Public CI permits readiness only on dev. Dedicated CI_READINESS_ENABLED_DEV=true/false overrides the flag; empty/unset preserves explicit tfvars/default false. The runtime profile alone does not enable it. False/missing reports `runtime_disabled`. Capped samples cannot
  prove absence; missing ledger, partial/failed runs and unknown attributes remain failed readiness.
- The runtime smoke capability uses a private 0600 `SMOKE_RUNTIME_CONFIG_FILE` beside the
  credentials. Prepare checks host registration (optional hostOnly); verify additionally
  requires applied CloudFront identity, complete queued types and pre-dispatch timestamp,
  fresh collection, web-role SSM/AgentCore proof and Lambda/Fargate completion. Current Deploy
  Web remains DB-only until the release controller supplies this file. The billed readiness
  route requires admin or deployment-verifiers, one in-flight call and a 60-second cooldown.

- Dev-only `verify_database=true` prepares effective demo credentials privately before rollout,
  then verifies login and edge-authenticated `/api/db`; positive table count is not a ledger audit.
- Unwrapped Terraform and private 0600/0700 files are required. CLI scratch shares the
  credential directory; normal finalizers own cleanup, which process/runner loss can prevent.
  Expose only phases/validated HTTP status,
  never Terraform diagnostics, bodies or cookies. Do not reset credentials to pass verification.
- Auth fixtures require curl/OpenSSL, PyYAML and Terraform 1.15.7; missing tools fail the runner.

Runtime probes accept verify-only full policy and release mode (shared 20min poll vs 10min).
Calls with runtime configuration expire at marker+30min/prepare-entry+30min, or an earlier bound.
Quality/gaps are programmatic; the CLI stays fixed. Distinguish collection_stale,
release_timeout and runtime_inventory_contention. Require full HTTP timeouts and remaining
probe/worker allowances before billing or enqueue; retry includes cooldown and recheck.
Collection windows are caps, so late completion may fail admission. Keep the probe contract
before Related/ADR references. Run `node --test scripts/v2/deployment-smoke.test.mjs`
from the repository root; it imports the runtime-smoke suite.
