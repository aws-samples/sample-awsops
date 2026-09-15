# Runbooks

Operational playbooks organized by scenario. Each follows symptoms → diagnosis → action.

`review-image-capability.md` documents the manual dev-only operator CI diagnostic under
ADR-005, with existing OIDC role/environment and no mutation exception or gate replacement.
Model cwd is the checked-out workspace; the image is outside it and CLI temp. JSON keeps
observations/unknown values separate from cleanup; cleanup failure fails the job without
erasing valid Read evidence. Source helper/tests and the role consumer catalog are linked.

## Index

| Runbook | Topic |
|---|---|
| [review-image-capability.md](review-image-capability.md) | Manual authenticated runner Read proof for a synthetic image; no review-gate substitution |
| [start-services.md](start-services.md) | **⚠️ v1 (legacy)** — start all services (Steampipe + Next.js on EC2); v2 runs ECS always-on |
| [deploy-new-version.md](deploy-new-version.md) | **⚠️ v1 (legacy)** — deploy a new version (CDK); v2 uses `make deploy` |
| [add-new-page.md](add-new-page.md) | Adding a new dashboard page |
| [multi-account-setup.md](multi-account-setup.md) | **⚠️ v1 (legacy)** — onboard a new AWS account (Steampipe Aggregator); v2 uses `onboard-target-account.md` |
| [onboard-target-account.md](onboard-target-account.md) | v2 target-account onboarding (`AWSopsReadOnlyRole` + ExternalId) |
| [istio-agent-eks-access.md](istio-agent-eks-access.md) | Granting `istio-read` MCP access to an EKS cluster (agent Lambda role Access Entry) |
| [network-path-eks-access.md](network-path-eks-access.md) | Granting Network Path Check live-identity verification access to an EKS cluster's Nodes/Pods (worker task role / `AWSopsReadOnlyRole` Access Entry, AdminView) |
| [k8sgpt-operator-install.md](k8sgpt-operator-install.md) | Out-of-band K8sGPT operator install (manual operator work, ADR-005 precedent) |
| [alert-pipeline-troubleshoot.md](alert-pipeline-troubleshoot.md) | Alert pipeline failure response (ADR-008/013) |
| [cache-warmer-issues.md](cache-warmer-issues.md) | Cache warmer staleness / error response |
| [tempo-query-generation.md](tempo-query-generation.md) | Tempo query generation — connector/web deployment, admin API schema refresh, cached summaries, and recent-window limits |
| [graph-read-contract.md](graph-read-contract.md) | Bounded graph requests, collection/read failures, projection/index migrations and local PostgreSQL fixtures |
| [source-sync-observability.md](source-sync-observability.md) | Public source rollout — graph evidence/identity boundaries, DX assessment scope, migrations and Lambda deployment prerequisites |
| [cognito-auth-issues.md](cognito-auth-issues.md) | Login failures, Lambda@Edge verification errors |
| [user-offboarding.md](user-offboarding.md) | Offboarding a departing employee's Cognito account — closing the account-takeover path (ADR-002/009) |
| [v1-to-v2-aurora-backfill.md](v1-to-v2-aurora-backfill.md) | v1→v2 Aurora history backfill |
| [v1-decommission.md](v1-decommission.md) | v1 legacy decommission — 5-phase procedure (ADR-016) |
| [branch-strategy.md](branch-strategy.md) | Single-repo branch/PR chain (user → dev → main + guard), external-PR handling, domain map, production-domain decision, per-user preview stacks |
| [dev-repo-setup.md](dev-repo-setup.md) | CI/OIDC, private exact-plan inspection and encrypted failure recovery; upload-confirmed cleanup; ECR preflight, state-preserving DNS, authenticated assets, Host/SNI smoke, private DB migration, mandatory full dev runtime verification and opt-in diagnostics (ADR-002/005/016) |
| [release-safety-primitives.md](release-safety-primitives.md) | Active web controller/bounded reads, forced web-migration SQL admission, immediate contention and operator recovery (ADR-001/005) |
| [web-release.md](web-release.md) | Digest-bound web release, private migration ordering, mandatory full dev runtime checks and explicit image rollback (ADR-001/005) |
| [legacy-web-image-recovery.md](legacy-web-image-recovery.md) | Explicitly approved private-host recovery for images without receipts: trusted source/digest evidence, schema approval, exact image verification, no migrations (ADR-001/005) |
| [web-image-provenance.md](web-image-provenance.md) | Helper contract: receipt steps/inputs, composed promotion, main account prerequisite, migration/rollback/expiry limits (ADR-005) |
| [first-web-bootstrap.md](first-web-bootstrap.md) | New unpublished stacks only: reviewed web ECR/base, matching ARM64 image, guarded empty-DB initialization, local deploy and authenticated host preparation before mandatory runtime release verification |
| [runtime-foundation.md](runtime-foundation.md) | Runtime activation and strict release controller: host-only default, explicit targets, pinned catalog, budgets, expected hard stops, measured feasibility, CLI and fixed-code triage |
| [deployment-audit.md](deployment-audit.md) | Manual development observations: restrictive session, ECS/Lambda/AgentCore status, schedule metrics and SQL-reader metadata; no full-readiness claim |
| [runtime-verifier-sessions.md](runtime-verifier-sessions.md) | Development verification policies: manual backend/workload phases, Deploy Web workload-only collect, owned collector invocation, synchronous/HTTP proof, and cleanup gates (ADR-002/005/021) |
| [dev-domain-rollout.md](dev-domain-rollout.md) | Unpublished/same-domain dev rollout; saved-plan scope, links to branch-independent artifact inspection/recovery, certificate issuance, smoke-before-publication and owned-record-preserving rollback (ADR-005/016) |
| [steampipe-quota-and-staleness.md](steampipe-quota-and-staleness.md) | Steampipe quota guard — rate limiter knobs, Plan-only dev refill override, partial runs and freshness |
| [agent-sql-reader.md](agent-sql-reader.md) | Data API role/password sync: dev applies private-migration infrastructure before its reusable migration/AgentCore workflow; main/preview/private-host CLI use `make migrate → make agentcore` |

## Deployment invariants
- `release-safety-primitives.md` defines the active web read/controller contracts and transactional pending-SQL admission forced by every web-driven migration clone. Automatic calls reject missing ledgers under the lock and never call `initializeEmptyDatabase`, regardless of the template's init flag. Standalone empty-only bootstrap applies historical SQL and reader sync first; initialized DBs retain full pending checks. Function defaults (`now()`/`gen_random_uuid()`), ALTER/GRANT/views and non-transactional SQL require reviewed standalone migration, then a fresh web dispatch. No historical exemptions or automatic-baseline exception. Advisory-lock contention fails promptly; locks cover reader sync. Only transient reads retry within a shared budget; writes and identity/permission failures do not retry. Receipt verification gives the known old PRIMARY 15 seconds of visibility grace; start confirmation retains its separate 120-second bound.

- Private S3 plans require the configured backend file, verified bucket posture and existing
  base-role/key-policy permissions; publication grants none. Operators use IAM/KMS, not the
  CI key. Public references expose only source context and the unpredictable manifest hash;
  no storage identifiers or bare bucket/account/backend hashes. CLI results omit plan hashes.
- Manual publication and apply enter the branch environment, including main production
  approval. Only missing backend/tfvars blobs soft-skip; missing publication roles otherwise
  fail. One-day ciphertext becomes a five-day reference after successful publication.
- The privately selected plan digest binds exact bytes, not human attestation. Mask the input
  before workflow step environments can log it. CI still authenticates assets and all original
  apply gates. Publication and private reads require owner-installed plan-prefix lifecycle:
  7-day current/noncurrent expiry and 1-day multipart abort; conflicting expiry/archive
  at or before five days is rejected. The optional owner-run bootstrap configures it;
  the workflow does not apply bootstrap. S3 expiration is asynchronous. Review effective
  S3/KMS readers: they need no CI envelope key. Publisher policy requires SSE-KMS on PUT,
  separately from reads. Optional purge targets reviewed expired attempt versions.
  Current-run scratch cleanup can be prevented by runner loss; summaries are advisory.
- Deploy Web wires producer-receipt steps and current-dev migration outputs, with readonly
  image proof before DDL and composed `promote` preserving the validated project/digest;
  never manually mint migration evidence or silently fall back to mutable-tag authority.
  Require a nonempty preflight digest on all paths and fresh digest/source-tag agreement.
  Preserve OCI indexes with unambiguous ARM64 verification. Document the producer's
  ci-build role, producer/reuse-consumer `actions: read`, upload-artifact v4 plus required Artifact API digest, and repository-scoped
  config-download permission; publication uses the deployer role and explicit ECR media.
  Helper stdout is `{digest, image_sha, rollback}`; controller deploy adds `migration`, with no tag history. Recovery requires independently retained source/digest evidence. Legacy images without receipts use the separately approved private-host recovery runbook with source/digest evidence and schema approval, never fabricated receipts or a workflow bypass. Automatic receipt cleanup removes only the fixed GitHub run/attempt path; manual leftover cleanup checks ownership. Migration/preflight assertions use verified job outputs,
  never dispatch inputs. Fresh-only consumers do not need `actions: read`.
  Build/image-proof select `IMAGE_PROJECT` from protected branch tfvars; deploy cross-checks actual Terraform ECR/cluster/service outputs. Broad current CI-account IAM does not
  supply stack authority; each operation selects one verified repo and any new grant uses
  its exact ARN. Publication confirmation failure calls for provider checks/revalidation,
  not rebuilding a validated candidate; document completed-producer and superseded-push cases.
  Provider children require explicit exported auth, disabled AWS config files, private GH config and filtered
  environments; signed curl URLs use private stdin, never argv. Multi-tag digest rows
  are accepted only with matching identity and byte-identical manifest/media evidence.
  Provider PATH is pinned to standard CLI directories; caller HOME is omitted, never reassigned.
- Every AWS-facing Deploy Web job needs `AWS_ACCOUNT_ID_DEV`, including main; the guard job does not. Required `test_ci_web_workflow.py` needs PyYAML and Bash; actionlint is optional local lint, not installed/run by CI.
- Verification policies support manual collect-runtime dev dispatches (backend/workload, prepare/collect) and deploy-web dev push/dispatch (workload collect only; backend/prepare refused). Both workflows consume these policies. Dev verification requires activated runtime prerequisites and private proof credentials/state for push and dispatch; missing proof fails closed. Sessions require nonempty restrictions and owned-file cleanup. Collect may invoke only the owned collector; application-data effects are operator CI, not an ADR-005 exception. IAM cannot constrain its event body; the controller must enforce catalog or each verified catalog member's RequestResponse payload, banning empty/all/unregistered/Event calls. The dated owner requirement is all current types with post-marker succeeded evidence, known counts and zero unknowns, not rolling prior success. At most four calls are concurrent and in flight; at least one catalog request plus at least one per type, including any retries, determines total volume. The separate deployment audit remains no-invoke. See `runtime-verifier-sessions.md`.
- Private S3 inspection authenticates source/run/reference, manifest, pinned plan and hashes before bounded local rendering; it never authorizes apply. Asset HMAC is checked inside CI publication/apply, not by the keyless operator renderer.
- Branch-independent plan inspection and failure recovery live in `dev-repo-setup.md`; domain stages in `dev-domain-rollout.md` remain dev-only.
- Linux capture forwards the first interrupt, kills the child group on a second, and arms parent-death SIGKILL before exec; cancellation is not infrastructure rollback.
- Plan/apply capture drains a 1 MiB tail in memory, preserving the command exit independently of scratch writes. Fixed audits include capture/retention classes and available numeric success action counts; no raw automatic-run diagnostics.
- Only an owned single ciphertext file can be uploaded for dispatch failure/cancellation, under an attempt-specific name. Schema-2 failure HMAC uses a separate domain; recovery authenticates the original attempt. Keep AWS_SESSION_TOKEN while removing GitHub channels/tokens, encryption keys, TF_LOG* and TF_CLI_ARGS* from Terraform child environments.
- Sealing uses OpenSSL stdin without plaintext staging. Captured Terraform uses Linux parent-death protection and escalates a second interrupt after graceful first-interrupt forwarding.
- Key/storage/seal/publication/cleanup outcomes are distinct. Delete owned ciphertext only after the identified upload succeeds; failed/cancelled/skipped/unknown uploads retain it privately. Audits report pending_upload and final upload/cleanup outcomes; no broad temp sweep, host-loss guarantee or shared-UID isolation.
- `deployment-audit.md` separates manual dev observations under backend-bound and workload-read sessions. Preserve identity/resource guards and private cleanup. Web and AgentCore observations do not prove applied versions or invocation readiness; observed SQL-reader types never establish complete inventory.
- `runtime-foundation.md` covers activation and the strict release controller: host-only default, explicit targets, pinned catalog, budgets, expected hard stops, measured feasibility, CLI and fixed-code triage. Dev/preview private discovery requires explicit full-plan rollout and DNS permission; public DNS/certificates remain blocked. `runtime-ecr-bootstrap` creates three repositories.
- The dev profile enforces read-only flags and real login/DB/host-registry proof at manual plan/apply; direct dev host-only settings require it. Automatic PR/push plans do not run the credentialed host probe. Manual dev/preview deployment blocks listed core teardown/replacement/forget and has no retirement mode; main is outside this development policy. Configuration checks are not live-access proof.
- Before promoting the IAM changes from dev to main, require reviewed dev apply and live gateway/chat, worker-diagnosis and tagged SFN/Fargate evidence. Mock plans do not satisfy this promotion gate; this dev PR does not authorize production apply.
- `scripts/v2/ci_tf_assets.py` shares one locked pg8000 installer with Terraform.
  Prepare invalidates markers and removes stale regular ZIPs, rejecting ZIP symlinks.
  Pack requires known planned ZIPs and binds plan/SHA/scope, paths, modes and hashes with
  `TF_PLAN_ENC_KEY` HMAC. Both pack/restore APIs allow only push/pull_request/workflow_dispatch
  in GitHub, or explicit local commits without an event; other events fail before work.
  Targeted plans omit untargeted Lambda resources from planned_values; preserve the ZIP check.
  The 0600 tarball can contain signing keys. Use encrypted GitHub handoff and private SSE-KMS
  storage; clean owned plaintext/staging. CI publication/apply preserve pack/restore checks.
  `CI_ASSETS_READY=true` makes layer provisioners validate restored files without reinstalling.
  See `scripts/v2/ci/pg8000-requirements.txt`, `scripts/v2/test_ci_tf_assets.py` and
  `docs/reference/06-workers.md`. Old signed bundles require their matching prior key after rotation.
- `CI_DB_DIAGNOSTICS_DEV` is false/unset by default; literal `true` plus `workflow_dispatch`
  enables advisory dev plan diagnostics only after encrypted artifact upload. Require
  `--target dev`, region `ap-northeast-2`, and state-account/STS consistency; this is not
  authorization or same-account stack validation. Use existing read-only grants and an exact
  CLI verb allowlist. No IAM/resource writes or DB connection. Opt-in publishes fenced safe
  JSON, including posture booleans, to the public Actions log/summary.
  This optional step and the separate advisory readiness-plan summary tolerate failure;
  DNS/CI/readiness gates remain required.
  Retain all four sections independently: `logs`, `configuration`, `server_logs`, `rds_metrics`.
  Distinguish unavailable sources from unknown derived comparisons; early input/context/identity
  failure returns only `{"status":"unavailable"}`, not fabricated empty sections.
  Empty samples explicitly expose `no_matching_events` and `no_error_inference`; zero counts
  in any status are not health proof. Interpretation requires a known probe in the returned window.
  Successful task-definition reads stay source-available for missing/malformed web containers;
  `web_container_found` and derived-unknown flags describe the configuration defect.
  Web logs cover a fixed one-hour window, oldest-first, at most 3 × 100 events; disclose actual
  bounds, truncation and count meanings. JSON `evt` OR selects ping errors and connection-stage
  observations; phase/milestone names are fixed, durations finite and bounded to one hour,
  and latest timing describes only the returned sample. RDS lists at most three PostgreSQL-file pages for the
  configured first Aurora instance and reads at most two newest-500-line tails without download
  Markers. Only FATAL/ERROR/PANIC web-role lines count as errors. `benign_role_mentions` counts
  exactly non-error-severity lines mentioning `awsops_web`; lines for other database roles are
  ignored. Capped/failed reads retaining evidence are partial; download failure retains metadata.
  Discarded milestones and regex text shortened to 4,096 characters also mark samples partial.
  The same opt-in uses one bounded CloudWatch get-metric-data read for the configured first
  instance: seven IAM-auth Sum metrics, CPU Average, free-memory Minimum and capacity Average.
  Preserve fixed IDs/status/missing/invalid flags and at most 60 minute points per series;
  never emit remote labels, messages or pagination tokens. Configured min/max ACUs are numeric
  or null; no capacity, authentication or timeout tuning is authorized.
  Separate read status from data presence: clean Complete+empty is available with missing=true;
  Forbidden/InternalError is unavailable; PartialData/malformed/degraded reads are partial.
  `read_ok` describes an accepted response envelope, not an authentication outcome.
  Every lifecycle observation needs the web user in a recognized RDS prefix and an anchored
  message, separately from error counts. Full-prefix SQL continuations and RAISE LOG can forge
  matching text: lifecycle_source_integrity stays unverified_text, lifecycle_injection_possible
  is always true, and probe outcome stays unknown. Auth success messages require log_connections
  (PostgreSQL default off; not enabled here). The effective value is not inspected;
  log_connections_enabled=null is explicitly unknown.
  Metrics aggregate IAM clients and never prove an individual probe outcome or authorize tuning.
  Publish fixed projections only, including on Terraform/AWS failures; never raw logs/filenames.
  Service-target/declaration comparisons and error categories are hypotheses, not proof of
  running revisions, effective access, runtime credentials, connectivity or readiness.
- `ci_migrations_enabled` / `CI_MIGRATIONS_ENABLED_DEV` is a default-off operator capability.
  Dev Deploy AgentCore and current-source dev Deploy Web require the reviewed `true` plan already applied and a non-null `migration_job` output; a repository variable or plan alone does not provision it. The guarded Deploy Web caller also permits dev pushes; standalone and AgentCore use remain dispatch-only. Explicit older-image rollback skips this workflow.
  `deploy-migrations.yml` builds an ARM64 image and `run-migration.mjs` launches/verifies one
  private task. The task role reads exact Aurora secrets; DDL uses DB credentials. This is
  operator CI, not product autonomy or an ADR-005 AWS-resource-mutation exception.
- `dev-repo-setup.md` covers CI/OIDC, protected review recovery, ECR preflight, state-preserving
  DNS deferral and explicit same-branch/SHA dispatch plans. PR/push plans are advisory.
- Dev repo domain overrides feed both console and plan through a gitignored auto-tfvars
  file; reject a tracked override before generation. `CERTIFICATE_MODE_DEV` preserves
  ownership or selects managed issuance. Dev advisory preflight uses state only, without
  live certificate/SAN/trust validation; DNS allowance is reporting, never apply authority.
- `domain_rollout=false` is the ordinary full-plan default. Every authorized domain-stage
  plan sets it true (dev/full only), stored as declared Terraform metadata `ci_domain_rollout`.
  Apply derives scoping from the saved plan, not current repo variables or apply inputs.
  Active rollout allows only configured service A/ACM CNAME owners in the selected zone.
  Published old-domain retirement needs a separate expressly authorized old-configuration plan.
- Preserve managed certificates as JSON null and existing service aliases. External certificates
  must be operator-selected or already attached; never scan the account. Routine CI cannot
  externalize a managed certificate or delete/replace owned validation CNAMEs even when DNS is
  allowed; ownership migration and validation-record retirement need separate reviewed procedures.
- ALLDNS includes private Cloud Map, certificate validation and registered ECS task changes.
  The optional full-dev Plan refill override is documented in [Steampipe quota and staleness](steampipe-quota-and-staleness.md#development-ci-refill-override).
  Steampipe tuning, hydrate-fallback remedies and rollback/disable can change private DNS and are
  blocked too. No private-DNS exception. Future authorized cutovers explicitly set
  `allow_dns_changes=true` on both plan and apply dispatches; examples do not grant permission.
- Public summaries include managed/external certificate suffixes, publication, change counts/
  addresses and active-rollout public zone name/ID/NS; diagnostics additionally permit bounded
  metric values. Explicit full dev readiness plans may also publish fixed scope/presence
  checks and a known configured collector hash through `ci_readiness_plan_summary.py`.
  That advisory summary does not establish approval or resource presence; unknown changes
  require private inspection. Its two-minute, failure-tolerant step runs before encryption,
  renders fenced JSON, and must not block encrypted handoff/private publication.
  Never expose full ARNs, account IDs or
  raw configuration/state/plan JSON. Deploy Web/manual smoke share the argv-safe Host/SNI/TLS
  CLI; standalone health proves liveness only. Every dev Deploy Web release requires
  the full authenticated runtime gate before service A publication. Existing-web
  prepare does not create first web or bypass readiness; follow runtime adoption first.
- Offline Terraform checks use `bash scripts/v2/terraform-test.sh` from the repo root:
  Terraform 1.15.7, tracked working files copied in isolation, fresh `TF_DATA_DIR`,
  `init -backend=false`, mocked providers and no real backend. Test dependencies are declared in
  `scripts/v2/requirements-test.txt`; deployment Node tests also run in the shared merge script.
  Root-level Python command: `python3 -m pytest -q scripts/v2/test_ci_*.py`.

## Authenticated development verification
- Verify requires applied `agentcore_enabled=true` and `ci_readiness_enabled=true`, then AgentCore
  provisioning, active inventory/dispatch, `workers_enabled=true` and deployed ARM64 worker images.
  Only the output boolean sets `DEPLOYMENT_READINESS_ENABLED`, with no shell override.
  False/missing is `runtime_disabled`. A reviewed apply creates `deployment-verifiers`
  only with readiness and AgentCore enabled; managed-demo membership additionally requires
  `create_demo_user=true`. No admin membership or IAM role is granted. Public CI permits
  the flag only on dev. Dedicated CI_READINESS_ENABLED_DEV=true/false overrides the flag;
  empty/unset preserves explicit tfvars/default false. The runtime profile alone does not enable it.
  `auth.tf` configures 12-hour ID/access tokens. Removing membership does not rewrite issued
  ID-token group claims; they can persist for the remaining lifetime unless session revocation
  rejects them. Runtime disablement is independent; see runtime-foundation's readiness guidance.
  Disabled AgentCore blanks only the web task's `SSM_RUNTIME_ARN_PARAM`; invocation and status
  lookup honor it. The separate alias and incident bridge paths remain literal. Status lookup
  does not validate the full ARN and can still perform other control-plane reads.
  The controller does not create the group/membership; use reviewed imports for existing resources.
  Capped samples cannot prove absence. Every current catalog type requires clean post-marker
  success with known counts and zero unknown attributes. Missing, partial, failed, stale or
  unknown evidence blocks release; a prior rolling success is insufficient.
- The runtime smoke capability uses a private 0600 `SMOKE_RUNTIME_CONFIG_FILE` beside the
  credentials. Prepare checks host registration (optional hostOnly); verify additionally
  requires applied CloudFront identity, the deployed catalog and pre-probe timestamp,
  complete post-marker collection evidence, web-role SSM/AgentCore/model proof and Lambda/Fargate completion.
  Every dev Deploy Web release requires the controller-generated verify file after exact ECS/image
  verification, with `EXPECTED_WEB_DIGEST` from `steps.pin.outputs.digest`; `verify_database` cannot bypass it.
  The billed route requires admin or deployment-verifiers, one in-flight call and a per-process
  60-second cooldown; replicas have independent cooldowns.

- Reused-image receipt/ECR validation precedes migrations. Automatic DDL is expand-only;
  contract cutovers require a merge freeze, drained queues and explicit manual coordination.
  The active `protect-main-dev` ruleset requires GitHub Actions AI Code Review and
  Merge Verify success before main/dev merge; no extra environment reviewer is added.
  Current-source releases require matching private migrations; explicit rollback runs no DDL.
  Both require the full runtime gate, including login/DB. Every dev release prepares
  effective demo credentials privately with unwrapped Terraform before rollout, then verifies
  login and edge-authenticated `/api/db`. A positive table count is not a full ledger audit.
- Terraform plan/private host preparation, Deploy Web and manual collect-runtime credential steps
  bind `TF_VAR_DEMO_PASSWORD` as step-scoped `TF_VAR_demo_password`; only private file paths cross steps.
- Credentials and HTTP scratch share one 0700 run directory with 0600 files. Normal
  finalizers clean them; process/runner loss can prevent cleanup. Public diagnostics
  contain only fixed phases and validated HTTP status.
  Never relay Terraform diagnostics, response bodies or cookies, or reset a user's password.
- Curl/OpenSSL, PyYAML and Terraform 1.15.7 are mandatory for the authenticated smoke fixtures;
  missing tools fail the shared runner. Only final fmt/validate diagnostics are informational.

Collector verification binds the applied `sync_code_sha256` to the configured archive
`source_code_hash` and checks live `CodeSha256`; stale provider observations cannot authorize code.

The release controller synchronously collects every code-checked catalog type through at most four collectors. It requires successful owned responses and strict post-marker ledger evidence for all types, plus a fresh known CloudFront record, nonce-bound web SSM/AgentCore/model proof and both terminal worker proofs. Full policy reports collection attempts and categorized gaps; no degraded acceptance is available. The marker-plus-thirty-minute proof deadline includes required HTTP/model/worker allowances. Collection stops early enough to reserve them; the single confirmed-contention retry revalidates all types within the original poll window. See `runtime-foundation.md` for exact budgets, digest binding, cleanup and adoption. No scheduler or IAM repair is performed.

## Conventions
- Filename: `kebab-case.md`, domain-then-topic order.
- Structure: **symptoms → candidate causes → verification commands → action → related files/ADRs**.
- New or rewritten runbook bodies and context files are English-only, as defined in
  `docs/CLAUDE.md`. Preserve operational facts when maintaining an existing bilingual
  body; do not restore parallel translations. Multilingual product guides remain
  under `docs-site/`.
- Commands should be copy-paste ready.
- Cite the related ADR number(s) at the bottom.
- Do not let a runbook embed secrets, AWS account IDs, ARNs, or live domains.

## Adding a Runbook
1. Add it to this index.
2. Use an existing runbook's structure as a template (`start-services.md`, `deploy-new-version.md`).
3. Follow the symptoms → diagnosis → action order strictly.
4. Always include the related file paths.

The reusable runtime probe supports verify-only inventoryPolicy=full and collectionMode=release
(nominal 20-minute rather than 10-minute collection wait caps, clipped by remaining
absolute/proof budgets). The controller does not promise that whole wait. Rechecks share the first window; all
runtime callers have marker+30min/prepare-entry+30min deadlines, shortened by explicit bounds.
Programmatic quality/gaps do not imply CLI JSON output or catalog discovery. Document
collection_stale, release_timeout and repeated runtime_inventory_contention distinctly.
Before billed readiness or worker enqueue, require the remaining probe/worker allowances;
collection windows are caps and late completion can fail admission. Retry admission includes
cooldown, recheck, probe and both workers. HTTP requests need their full timeout remaining.
Keep the probe contract before Related/ADR references. From the repository root run
`node --test scripts/v2/deployment-smoke.test.mjs`; it imports the runtime-smoke test suite.

Both dev workflows call the strict controller. Preserve the active scheduler and the
distinction between operational degraded data and ineligible release evidence.
Four lanes share Lambda/Steampipe limits; contention can fail the gate. Budgets are
admission bounds, not guaranteed completion. Runtime foundation records a 43-type,
57.461-second collection sample and its limits; it is not full live readiness.
The catalog must include the pinned baseline (currently 43 names, source-AST checked);
valid growth is allowed up to 128 types and every returned type needs strict proof.
Both modes default to the enabled host only. Explicit applied targets require exact
enabled host/member registration before type calls, zero unreachable counts in every
owned RPC, and fresh account-bound EC2/CloudFront known-member evidence. Host-only SDK
collectors do not establish per-member43 coverage. Terraform plan/apply onboarding
alone allows approved subsets; apply derives scope from the restored saved plan.
Runtime release never requests subset leniency. See `runtime-foundation.md#explicit-runtime-targets`.
Preserve the AWS CLI environment allowlist, configuration isolation and endpoint restrictions.
The first chronological terminal failure stops new type admission; admitted work settles
and untouched types remain `not_started`.
`collection_attempts.counts` uses six status buckets that partition `expected`.
A selected type whose first call is refused by the 450-second floor is `deadline` with zero attempts;
never-selected types are `not_started` with zero attempts. Do not classify by attempts alone
or apply this partition rule to overlapping `inventory_quality` gaps.
Preserve exact diagnostics: outer `Runtime release: <reason>`; passed-through `SmokeError`
messages retain `Runtime smoke:` / `Authenticated smoke:` prefixes. Direct `RuntimeSmokeError`
config failures can become controller fallbacks. RPC and ledger suffixes are not
interchangeable; the operator table enumerates controller reasons and describes helper families.
Partial/unknown outcomes are expected hard stops even under limiter/hydrate pressure.
Use bounded capacity/reachability/permission diagnosis before an authorized fresh rerun,
never automatic permission widening, degraded acceptance or scheduler suppression.
`remaining_prerequisites: "not_assessed"` leaves separate workflow/plan/promotion gates;
keep the fixed-code table and calibrated `readRuntimeSmokeConfig` parameter documented.
Collect's closing service/list-tasks/describe-tasks reads must match the initial opaque
deployment ID, immutable task-definition ARN, count and ECR digest set before success;
never resolve the tag again. A changed ID fails even with the same task definition.
Equal snapshots are not continuous identity/history proof or an atomic lock; prepare is unchanged.
Each explicit target reserves another 35 seconds, reducing collection/latest admission
equally. The empty-target 18-minute reserve covers the single-pass 1,060-second path plus 20 seconds.
Auth proof ends 50 seconds before the original proof deadline for three closing reads
at 15 seconds each plus five seconds overhead, all inside that original deadline.
Collection has at most 720 seconds; the 450-second floor requires admission by 270
seconds minus clock preparation/earlier bounds. An extra 35-second read needs 15 seconds
saved. Full retry overhead is at least 215 seconds, needing 195 saved: a 35-second
confirmation precedes the helper's remaining 180-second admission allowance, with the
original worker allowances reused rather than counted twice.
Additional reads/waits/overhead require more time; no extras are guaranteed.
CLI inputs and fixture prerequisites: `runtime-foundation.md#controller-cli-contract`.
Catalog/per-type timeouts: `runtime-verifier-sessions.md#collection-effects-and-proof`.
Combined checks: `node --test scripts/v2/ci/runtime-release.test.mjs scripts/v2/deployment-smoke.test.mjs`.

## Graph read contract

Graph reads admit at most two requests per shared max:3 pool. The two-second request deadline includes acquisition; admission remains reserved until a late checkout settles, and abandoned work never starts. Annotation normalization and serialization run after client release. SQL and HTTP collection projections share bounded scalar/source/reason fields and metadataTruncated disclosure. Source-attempt metadata is supported before the separately gated inventory publisher is activated. See `graph-read-contract.md` for operator rollout and disposable tests; source integration does not establish deployment.
