<a id="runtime-foundation--런타임-기반-구성"></a>

# Runtime foundation

<!-- Legacy fragment anchors preserve incoming links; visible guidance is English. -->

<a id="symptoms-and-verification--증상과-검증"></a>

## Symptoms and verification

A healthy web endpoint does not prove inventory, SSM, AgentCore or worker readiness; inspect disabled backends, pending parameters and failed collection separately.
Use Terraform 1.15.7 and both `scripts/v2/requirements-test.txt` and `scripts/v2/steampipe/requirements.txt`. From the repository root, run these mocked-provider checks:

```bash
python3 -m pytest -q scripts/v2/test_ci_*.py
bash scripts/v2/terraform-test.sh
python3 -m pytest -q scripts/v2/steampipe/test_host_scope.py
node --test scripts/v2/ci/prepare-runtime-host.test.mjs
```

<a id="activation--활성화"></a>

## Activation

1. Configure the **secret** `AWS_ACCOUNT_ID_DEV`, backend and existing CI roles. Checks establish account/role consistency, not dev/production isolation.
2. A new inactive stack needs foundation, migration and working login first. `CI_READONLY_RUNTIME_DEV=true` enables core runtime, without enabling the separate readiness capability; manual full plan/apply require real login/DB and an enabled host registry with no enabled foreign rows.
3. `runtime-ecr-bootstrap` creates only three repositories. Build ARM64 images and set verified `STEAMPIPE_IMAGE_DIGEST_DEV` / `WORKER_IMAGE_DIGEST_DEV` before a full plan.
4. Dev/preview private discovery requires full-plan `runtime_rollout=true` and DNS permission; dev also requires the profile. Keep `domain_rollout=false`. Profile/rollout require remediation, RCA write-back, integrations write and diagnosis notifications off; governed external writes are not reclassified as FROZEN.
5. Inspect the same branch/SHA plan privately in S3 and supply its `reviewed_plan_sha256` to apply; CI verifies pinned assets and HMAC. Preserve public DNS, certificates and network topology; unchanged owned ECS registration still requires DNS permission. Missing/mismatched bundles require a new plan. `CI_ASSETS_READY=true` selects layer verification, not rebuilding.

```bash
# After the profile, base application and verified digests are configured:
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev -f mode=plan -f plan_scope=full -f runtime_rollout=true -f allow_dns_changes=true
```
Host-only removes only collector AssumeRole; Agent MCP grants remain. IAM includes known regions regardless of current opt-in; newly launched AWS regions require a fresh apply. IAM narrowing also applies to already-enabled main/preview stacks independently of the dev profile.
S3 steady denials remain unknown: rows carry `attributes_unknown`, the ledger increments `unknown_attribute_count`, and freshness is `degraded`; full readiness rejects that incomplete evidence.
The digest/host-preflight profile is dev-only. Preview retains operator-configured mutable tags or digests and multi-account scope, without dev host verification; account/role and private-DNS ownership checks still apply.

## Collector catalog prerequisite

Deploy the collector's read-only `type=catalog` mode before enabling the full-release
controller. It returns the registered type names without collecting resources or
scheduling work. Catalog acknowledgement alone never proves collection completeness;
the controller must still check fresh complete results for every returned type.

## Readiness capability

Review the entire saved plan through [private S3 inspection](dev-repo-setup.md#private-exact-plan-inspection) and pass its verified hash to apply. The bounded summary below is advisory for this rollout.

After the existing runtime/DNS checks, a manual full dev plan with
`CI_READINESS_ENABLED_DEV=true` publishes an advisory `bounded_readiness_rollout`
summary without raw plan values. It recognizes only
creation of the verifier group in the existing pool with no IAM role, enrollment
of the existing managed demo, and a code-only inventory Lambda update. Supported
output changes are the AgentCore readiness Boolean and the
collector fingerprint. Resource identities and private values remain undisclosed;
the report uses fixed resource addresses, checks and a package hash.

`no_changes_outside_expected_scope: true` only describes reported changes. It can
be true for an empty plan; it does not confirm resource presence, readiness or
approval. Separate `planned_changes` booleans indicate which group, enrollment,
collector update and readiness-output activation are present. Unrecognized changes,
wrong identities/IAM roles, non-code collector changes, unsupported operations and
truncation make the scope comparison false. Description/precedence of a role-less
group are not checked. Imports, state address moves, disabling features and retiring
resources fall outside this view. The combined resource/output report is capped at 256 rows.

The summary step has a two-minute timeout and renders fenced JSON. Reporting failure
or timeout is advisory and does not block the encrypted plan-job handoff or private S3 publication.
An unavailable, incomplete or unsupported summary requires
[private exact-plan inspection](dev-repo-setup.md#private-exact-plan-inspection).
The completed source/publisher reference, pinned S3 versions, privately selected plan hash,
asset HMAC and exact-saved-plan apply checks remain required; no boundary is bypassed.

Saved-plan JSON can retain CLI Boolean inputs as the exact strings `true`/`false`,
while Terraform's effective values are Boolean. The readiness policy decodes only
those canonical spellings and real Booleans; other strings, numbers and null remain
invalid. The dev-only, separate opt-in and checked-saved-plan controls still apply.

`CI_READONLY_RUNTIME_DEV` does not grant billed-probe access. The dedicated dev repository variable `CI_READINESS_ENABLED_DEV` is independent of that profile:

| Value | Terraform behavior on dev |
|---|---|
| `true` | Explicitly sets `ci_readiness_enabled=true`. |
| `false` | Explicitly sets it false, overriding a true value in restored tfvars. |
| Empty/unset | Emits no readiness override; preserves explicit tfvars and the default false. Unsetting is not revocation. |

Other values are rejected. The workflow forwards this variable only on dev; helper opt-in and public-CI plan checks reject enabled readiness elsewhere. Direct Terraform remains explicit operator configuration. With readiness and AgentCore both enabled, a reviewed apply creates `deployment-verifiers`; automatic membership additionally requires the Terraform-managed demo (`create_demo_user=true`). No admin or IAM role is granted. Every holder of that shared demo login can then access the existing bounded billed model probe, so this must be a separate operator decision. The endpoint retains authentication, one in-flight request and a per-process cooldown; group creation is not deployment-readiness proof.

Use a fresh normal login to obtain new group claims. `terraform/foundation/auth.tf` configures **12-hour ID/access tokens**; `web/lib/auth.ts` reads groups from the ID token and checks the existing session-revocation store. Removing membership does not rewrite issued tokens: they can retain verifier authorization for their remaining lifetime, up to 12 hours, unless session revocation rejects them. Disabling the runtime is a separate control and can block the probe even while an old group claim remains. For urgent removal, use the existing [offboarding/session-revocation procedure](user-offboarding.md); do not reset a password to make verification pass.

An explicit false decision still needs the reviewed apply to remove managed membership/group state. When AgentCore is disabled, the web task's `SSM_RUNTIME_ARN_PARAM` is empty; invocation and status lookup respect that blank. The separate `AGENTCORE_RUNTIME_ARN_PARAM` alias and the incident bridge's literal project paths remain unchanged. Status discovery does not validate the full runtime ARN or prove invocation readiness, and other control-plane status reads can still run.

<a id="rollback--롤백"></a>

## Rollback

Retain runtime resources and restore reviewed prior digests/settings. Manual dev/preview plans and apply block listed core deletion/replacement/forget; this development policy does not cover main. No retirement mode is provided. A destructive teardown needs a separate reviewed procedure covering Aurora ingress, migration dependencies and optional gates.

<a id="promotion-to-main--main-승격"></a>

## Promotion to main

Sequence: merge reviewed code to dev → reviewed dev apply and full live readiness → main promotion → reviewed production apply. Do not promote this IAM narrowing until live dev exercises verify gateway-backed chat, worker diagnosis, and an SFN/Fargate run with managed tags. Record actual identities, outcomes and denied operations privately; a mock plan or IAM document alone cannot satisfy this promotion gate. This dev PR is the prerequisite for that evidence, not production deployment authorization.

## Reusable runtime probe contract

Every supplied type requires post-marker success, known counts and zero unknown attributes.
Verify accepts optional `inventoryPolicy: "full"` for structured quality/gap return values;
omission retains strict checks and other policies fail. These payloads are programmatic:
the CLI keeps fixed status/error messages. The caller supplies the intended catalog; the
helper does not discover it. Gap categories can overlap and must not be summed as disjoint counts.
Quality may be absent before the first ledger read; `collection_unavailable` supplies
`counts: null` and `types: null`. Other collection outcomes carry categorized arrays and
timestamps. Categories describe the latest ledger row, including prior attempts; only
the verified set establishes post-marker success.

Optional `collectionMode: "release"` allows a 20-minute collection poll window instead of
10 minutes. Both the initial poll and a contention recheck share that original window.
Every runtime entry point has a finite deadline: verify expires 30 minutes after
`collectionStartedAt`, while prepare gets at most 30 minutes from entry. A caller deadline
can only shorten it. Authentication, HTTP, cooldowns and workers share the bound. Admitted
poll responses still must arrive before the overall deadline to pass. Start promptly after
the marker; an older marker shortens the available collection and worker budget.

`readRuntimeSmokeConfig(file, credentialFile, now = Date.now())` accepts a finite
numeric validation timestamp. The controller passes its calibrated `now()` when
loading the private config; the default preserves ordinary callers. This validates
the existing marker against the selected clock without changing it or extending expiry.

Collection windows are caps, not a promise that late collection can finish verification.
Before billing readiness, the helper requires the full 80-second request allowance plus
370 seconds for each remaining worker (35-second enqueue, 300-second poll and a final
35-second status request). It checks worker allowances again before each enqueue.
Every HTTP request needs its full configured timeout remaining; it is never shortened
to start a request that cannot finish within the overall bound.
With a new marker, billed readiness must start before about 16 minutes 20 seconds
(30 minutes minus the 820-second probe/worker allowance). Earlier deadlines and preceding
login, database and inventory reads reduce the available collection time further.

A validated inventory-incomplete/stale response permits one retry only when the ledger
shows a unique fresh running CloudFront attempt with a fresh prior success. After a
65-second cooldown, every supplied type must be complete again before retrying. A second
proven collision after successful revalidation, or insufficient shared-window time to
admit revalidation, is `runtime_inventory_contention`. Admission also requires time for
cooldown, a 35-second collection read, another full probe and both worker allowances.
The latter fails before wasting the
cooldown; delayed wakeups are checked again. Initial or continuous collection waiting
exhausts as `collection_timeout`. Full-policy stale
coverage can end as `collection_stale`; the overall bound is `release_timeout`.
A post-marker running attempt stays a collection wait even when its previous success
is old or null; exhausting that wait is `collection_timeout`, never verified coverage.
Partial/failed/unknown evidence and unrelated protocol, authorization or model failures
never pass. Workers start only after ready. One additional AgentCore probe may be billed.

`/api/inventory/summary?view=collection` authenticates normally and reads only the sanitized
aggregate ledger, avoiding dashboard aggregations. Account/region filters do not narrow
this collector-wide ledger or establish per-account health. Normal authentication governs
this GET view. The separate default-off capability governs the billed readiness POST; this
utility does not enable a workflow.

```bash
node --test scripts/v2/deployment-smoke.test.mjs
```

Implementation: `scripts/v2/runtime-smoke.mjs`, `scripts/v2/authenticated-smoke.mjs`
and `web/app/api/inventory/summary/route.ts`. Worker ownership follows ADR-009.

### Optional database-clock sample

The existing edge-authenticated `/api/db` response includes `server_time`, sampled
by Aurora's `clock_timestamp()` in the same table-count SELECT and formatted as UTC
ISO with milliseconds. This adds no endpoint or authentication exception.
Programmatic `authenticatedSmoke` callers may pass `includeDatabaseClock: true`
only with a valid prepare-mode `runtimeConfig`. After login, DB and host-registry
checks succeed, the usual result additionally contains
`database_clock: { server_time, request_started_at_ms, response_observed_at_ms }`.
The local timestamps use the supplied `now`, bracketing the DB HTTP request; their
elapsed time must be between zero and 35,000 ms. Missing/malformed clocks fail only
opted-in callers; default/opt-out return shapes are unchanged, with no raw response
or credential fields added.

Opt-in requires the updated API to be deployed first. No workflow opts in here.
The controller below consumes this sample; workflow integration remains separate.
Calibration anchors at **request start**, conservatively, rather than response
observation. Neither helper introduces clock tolerance, relaxes the post-marker
lower bound, or extends an existing expiry/deadline.

## Strict release controller capability

`scripts/v2/ci/runtime-release.mjs` is available for future CI integration. Current
Deploy Web still performs DB-only verification, and the manual `collect-runtime.yml`
workflow is absent. Adding this controller enables no workflow, feature flag or IAM
grant. Integrating the mandatory release gate is separate work; it must not silently
skip disabled prerequisites or accept health-only/DB-only proof as a full release.

The accepted context is dev-only: same repository/ref, configured account and CI role,
actual STS caller, and a valid source SHA. A future manual collect-runtime dispatch may
prepare or collect; Deploy Web push/dispatch may collect only. Collect requires a full
lowercase `PIN_SHA`, applied inventory/AgentCore/worker metadata, the exact owned
collector identity/hash and known CloudFront ID. Web verification binds the running
ARM64 task role/revision/digest; Deploy Web also requires the approved root digest.
ECR digest lookup may return multiple tag entries for one manifest. Every entry must
match the configured account/repository, one digest and identical manifest bytes before
normalization and hash/ARM64 validation. Tag lookup still binds every entry to the
requested tag; unrelated entries never become valid aliases.
Collect records the initial opaque PRIMARY `deployment.id`, immutable task-definition
ARN, task count and validated ECR digest set. After HTTP/model/worker proof and before
`full_verified`, service, task-list and task-description reads must still match that
original baseline and the required stable/healthy state. A changed deployment ID fails
even if the task-definition ARN is unchanged. The closing check reuses the original
task-definition proof and digest set; it never resolves the ECR tag again.
These are bounded start/end observations, not a continuous-identity guarantee, atomic
lock or history audit; an unobserved intermediate change/restore is not disproved.
Prepare retains its existing result and has no closing web recheck.
Use the [restrictive session contract](runtime-verifier-sessions.md) and private
0700/0600 credential/state files. Both controller modes require exactly one enabled
host matching the configured account and no enabled foreign accounts. This is the
intended host-only first end-to-end target; the generic smoke helper's optional
multi-account support does not widen the controller's scope. An incompatible registry
fails as `host_only_registry_required`. Prepare verifies login/DB/host registration
but is never a full-release result. First-time stacks must complete the
[bootstrap sequence](first-web-bootstrap.md) before this existing-web preflight.

Collect checks web identity and the owned Lambda's configuration/catalog, then performs
authenticated login, DB and host-only preparation with the DB-clock sample. This
preflight rejects an incompatible registry before any per-type collection call; only
metadata reads and read-only catalog discovery precede it. It validates canonical UTC
milliseconds and request/response times inside the observed prepare interval, with
DB request elapsed time from zero through 35 seconds. The DB timestamp becomes
`collectionStartedAt`; subsequent time is `rawNow + (DB time - request start)`.
The existing controller deadline shifts by that same offset, preserving time remaining.
Every current catalog type (43 at this revision) must succeed after that marker with
known counts and zero unknown attributes. The returned catalog must contain every
member of the controller's pinned baseline of 43 type names, not merely 43 arbitrary
names. A source-AST regression ties that baseline to the checked-in `QUERIES` and
`SDK_SYNCS` catalogs. Valid additional returned types are allowed up to 128 total;
every returned type remains required, permitting growth without replacing a baseline member.
Prior rolling success is insufficient.
At most four synchronous owned invocations are concurrent and in flight. The first
chronological terminal failure becomes the headline error and stops admission of
further types. Already-admitted operations settle within their existing bounds before
cleanup and final failure reporting. Never-selected types retain `status: "not_started"`
and `attempts: 0` in `collection_attempts`; they are never counted as successful proof.
Its six status counts (`succeeded`, `partial`, `failed`, `unknown`, `deadline`,
`not_started`) are mutually exclusive and sum to `counts.expected`, the number of
catalog types. Counts use each type's `status`, not its attempt count. A selected
type whose first call is refused by the 450-second admission floor has `status: "deadline"` and
`attempts: 0`; a never-selected type has `status: "not_started"` and `attempts: 0`.
Zero attempts alone cannot distinguish them. This partition applies only to
`collection_attempts`; the separate `inventory_quality` gap categories can overlap.
Code hash and a nonempty RevisionId are captured before collection
and rechecked within 15 seconds afterward, before final authenticated runtime proof.
Changed/incomplete code metadata or read failure blocks that proof.

The outer controller cap is 50 minutes. In collect mode, the original proof deadline
is the earlier of that cap and DB marker plus 30 minutes. Authentication/model/worker
proof receives a deadline 50 seconds earlier. The closing web check is then capped
at the earlier of the original proof deadline and 50 seconds from its own start:
three sequential AWS reads capped at 15 seconds each, plus five seconds for overhead.
Prepare's deadline handling is unchanged.
The 18-minute reserve covers only the single-pass
base path: five 35-second HTTP calls, one 80-second probe, two 370-second worker paths
plus the 15-second collector recheck and 50-second closing web check total 1,060 seconds,
leaving 20 seconds of margin.
This assumes one collection-ledger read and the known CloudFront row on the first
inventory page. Each extra page or collection re-poll needs another full 35-second
request allowance. If collection used its maximum window, one extra request needs
at least 15 seconds saved by earlier work; otherwise proof admission fails. Additional
requests, polling waits and local overhead consume more time. The reserve does not
promise those extras fit. Initial prepare adds three bounded 35-second HTTP reads/requests; its DB
request and subsequent host proof consume the nominal 12-minute collection window,
as does local overhead. Each type needs at least 450 seconds remaining before admission;
confirmed busy/superseded or throttled retries share that remaining global window.
Transport uncertainty, partial/failed/unknown results cannot become success.

Final proof repeats authentication and requires strict fresh inventory/known CloudFront,
SSM/AgentCore/model evidence and terminal success of both owned worker types. The shared
probe's one contention retry is conditional. Its full additional allowance is at least
215 seconds: a 35-second confirmation ledger read before retry admission, a 65-second
cooldown, a 35-second collection recheck and an 80-second retry probe. At admission the
confirmation read is already spent, so the helper requires the remaining 180 seconds
plus both 370-second worker allowances. Those workers reuse their original allowances
and are not counted twice. After maximum-window collection, the full retry needs at
least 195 seconds saved by earlier work; additional reads, waits and overhead need more.
Insufficient remaining time fails before cooldown. No retry or extra page is promised.
Collection invokes may upsert/prune application inventory in Aurora, and full proof may
bill a bounded model call and submit internal worker jobs. These are operator verification
effects, not an ADR-005 AWS-resource mutation exception. No direct CI model/SQS/DB grants
are added. Fixed diagnostics and private cleanup remain required on success and failure.

### Strict acceptance, load and measured feasibility

The [owner's 2026-09-14 acceptance condition](https://github.com/aws-samples/sample-awsops/pull/67#issuecomment-5663692939)
requires all current catalog types, superseding the earlier CloudFront-only verifier
proposal. At this revision that means at least one catalog request plus at least one request
for each of the 43 types; catalog and per-type retries add calls. Four is the concurrency ceiling, not the total call count or
a claim of fourfold throughput. The [session contract](runtime-verifier-sessions.md#collection-effects-and-proof)
authorizes exactly catalog or a verified catalog member, never empty/all/unregistered
payloads or asynchronous `Event` invocation. No IAM scope is widened.

Operational collection may preserve last-good rows or report degraded data after
partial, failed or unknown work. Those are supported diagnosis states, but they are
expected hard stops for this release gate, including when the controller's own load
contributes to degradation. An `iam_role` hydrate timeout can produce a succeeded
fallback with unknown attributes; a limiter-contended host-reachability check can
produce a partial zero-row result. Neither proves the owner's strict criterion, and
neither receives an automatic partial/unknown retry inside the release attempt.
Inspect bounded per-type evidence for limiter/hydrate pressure, reachability and
actual permission denials; permission widening is not a universal remedy. After
diagnosing/addressing the cause, an authorized operator may rerun within the same
finite limits with a fresh marker. Keep the scheduler active and the acceptance
criteria unchanged; the controller performs no automatic capacity or IAM tuning.
The controller requires both successful owned RPCs
and strict post-marker ledger observations for every type. The singleton ledger is
not bound to this verifier's run token: a later scheduled partial/failed/unknown result
can block acceptance, while a current running attempt waits within the bounded window.
There is no rolling-success substitute or permission/tolerance override.

The controller does not change scheduler state; the existing fifteen-minute schedule
is retained enabled for this integration. With the default reserved
concurrency of four, four controller calls can occupy all Lambda slots and compete
with scheduled work. The shared Steampipe limiter also limits throughput; more lanes
do not bypass it. Throttling, supersession, hydrate exhaustion and asynchronous event
expiry can therefore affect collection or schedule delivery; the existing maximum
asynchronous event age is 900 seconds. This operator-verification
load is an explicit tradeoff of the required full-catalog proof, not permission to
disable the schedule, change concurrency or relax acceptance. A run that cannot fit
must fail for capacity/permission investigation. The separate deployment audit remains
observation-only and makes no collection invokes.

The budget is a fail-closed admission policy, not a worst-case completion guarantee.
With the full 720-second collection allocation, a new type needs admission by
270 seconds to retain its 450-second call allowance; clock-prepare time and an earlier
outer deadline shorten that opportunity. A 420-second Lambda timeout is an upper
bound, not an assumed duration for every type. Slow or contended workloads can
intentionally leave later types unstarted and block release.

A sanitized operator measurement on 2026-09-14 used a hash-verified deployed collector,
all 43 catalog types, four synchronous lanes, reserved concurrency four, a 450-second
admission floor and the then-current 780-second global collection budget (the current
allocation is 720 seconds). All 43 per-type results succeeded
with known counts and zero unknown attributes in **57.461 seconds**; the last admitted
call was at **39.802 seconds**. A following SQL-reader check verified post-marker ledger
evidence for all 43 types with no gaps. The EC2 result records three attempts, but the
record does not establish their exact retry causes. The schedule was enabled before
and after; that does not establish a concurrent scheduled invocation.

The operator separately verified the running Steampipe task configuration as
`max_concurrency = 4`, `bucket_size = 4`, `fill_rate = 2.0`. The measured collection
phase is therefore a concrete feasibility counterexample to a claim that the catalog
can never fit, not a throughput guarantee. It does not include the complete
authentication/model/worker or closing web proof, establish future or larger-workload latency, or
authorize another deployment.

### Controller CLI contract

These are integration interfaces, not installed workflow steps. Use the actual dev
workflow/account/role context from the [session contract](runtime-verifier-sessions.md#action-and-integration-contract);
do not fabricate Actions metadata to run this as an unrestricted local command.

| Command | Input and result |
| --- | --- |
| `node scripts/v2/ci/runtime-release.mjs capture` | Reads at most 16 KiB of applied `runtime_deployment` JSON from stdin, validates it, and writes private state beside the prepared credential file. Appends `deployment_file=<path>` to `GITHUB_OUTPUT`; prints no deployment payload. |
| `node scripts/v2/ci/runtime-release.mjs run` | Reads `RUNTIME_DEPLOYMENT_FILE`, runs the selected operation and cleans the owned credential directory on handled success/failure. Full success reports `full_verified`; prepare reports only `prepared`. |

| Environment input | Contract |
| --- | --- |
| `SMOKE_CREDENTIAL_FILE` | Existing producer-owned absolute 0600 credential file in a 0700 directory, required by both commands. Never pass a password inline. |
| `GITHUB_OUTPUT` | Required output channel for `capture`; its `deployment_file` value becomes the later `RUNTIME_DEPLOYMENT_FILE`. |
| `RUNTIME_DEPLOYMENT_FILE` | Required by `run`; use the captured 0600 state file directly beside the credentials. |
| `RUNTIME_MODE`, `PIN_SHA` | Manual `prepare` requires empty `PIN_SHA`; collect requires a full lowercase 40-character reviewed image SHA. Deploy Web supports collect only. |
| `EXPECTED_WEB_DIGEST` | Required for Deploy Web's `run`: the approved `sha256:` root manifest digest. Manual observation may omit it and verify the selected tag; a supplied digest is still validated. |
| `INVENTORY_POLICY` | `full` only; omission defaults to `full`. Empty or other values fail, and no degraded policy exists. |
| `PUBLIC_URL`, `CLOUDFRONT_DOMAIN` | Required application/edge targets for `run`, retaining service Host/SNI/TLS verification. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | All three exported temporary credential values are required for AWS reads; ambient profiles and credential files are not substitutes. |

Process or runner loss can prevent cleanup; future consumers still need always-run
owned-file cleanup. Neither command adds IAM grants or activates a workflow.

The AWS CLI child receives an explicit environment allowlist, not the full CI
environment. It uses a pinned CLI search path, explicitly exported credentials and
fixed region/runtime settings; AWS config and shared-credential files are disabled
with `/dev/null`, configured endpoint URLs are ignored and instance metadata is disabled.
Caller-selected profiles, endpoints, credential providers, CA/proxy overrides and
command hooks cannot replace that evidence path. Account/role and restricted-session
checks still apply; this isolation grants no additional AWS access.

Catalog/per-type invocation timeouts are defined in
[collection effects and proof](runtime-verifier-sessions.md#collection-effects-and-proof).
Offline controller, real authentication composition, and clock-helper checks require
Node.js and Python/PyYAML; the authenticated fixtures also require curl, OpenSSL and
Terraform 1.15.7. From the repository root:

```bash
node --test scripts/v2/ci/runtime-release.test.mjs scripts/v2/deployment-smoke.test.mjs
```

### Fixed diagnostics and remaining prerequisites

Use fixed codes and the bounded `collection_attempts` / `inventory_quality` fields
when present. The first chronological per-type terminal error identifies the collection
stop; later settled outcomes and never-started types remain visible. Do not relay raw
provider responses or secrets.

The controller's stderr envelope is exactly `Runtime release: <reason>`.
`smokeFailure` passes through only `SmokeError` messages, retaining their
`Runtime smoke: <code>` or `Authenticated smoke: <phase>` text; only a `SmokeError`
whose message is exactly `Runtime smoke: host_registry` maps to
`host_only_registry_required`. Direct `RuntimeSmokeError` exceptions from private
config validation are a different class: the config-file path inside the proof
catch can become `authenticated_runtime_proof_failed`, while direct validation or
deadline calls elsewhere can become `runtime_release_failed`. Prefix preservation
is not universal. Authentication phases can include fixed explanatory text and a
validated `; HTTP status NNN` suffix. Passed-through examples:

```text
Runtime release: collection_partial
Runtime release: Runtime smoke: collection_partial
Runtime release: Runtime smoke: runtime_inventory_contention
Runtime release: Authenticated smoke: host_registry_http; HTTP status 503
```

The first two lines identify different failures: the owned collector RPC and the
authenticated ledger verifier. Preserve the full reason when matching logs; do not
strip helper prefixes or normalize identical suffixes into one code. A controller
deadline guard can take precedence and emit the bare `release_timeout` reason.

The following table covers the current controller's fixed reasons, including
dynamic RPC reason variants and the CLI's unclassified fallback. Rows group
context/source, deployment/web identity, collection/proof and local execution failures.

| Reason after `Runtime release: ` | Meaning and bounded operator action |
| --- | --- |
| `invalid_command`, `output_path_required` | Use exactly the documented `capture` or `run` command. Capture requires the real `GITHUB_OUTPUT` channel; do not substitute fabricated workflow context. |
| `invalid_dev_source`, `invalid_release_workflow` | Repository, dev ref, region, source SHA or workflow/event context is not accepted. Check the actual Actions context against the allowed caller matrix; do not rewrite metadata to pass. |
| `invalid_runtime_mode`, `invalid_inventory_policy` | Mode/policy is unsupported. Only allowed prepare/collect callers and full inventory policy are accepted; there is no degraded or feature-off bypass. |
| `expected_account_required`, `configured_role_mismatch`, `actual_ci_caller_mismatch` | Check the configured account, role ARN and actual exported session identity. Do not change the expected identity merely to match an unexpected caller. |
| `aws_credentials_required` | One or more exported temporary credential values are missing. Refresh the approved restricted session; do not restore profiles, credential files or alternate endpoint/provider settings. |
| `expected_image_sha_required`, `expected_web_digest_required`, `invalid_expected_web_digest` | Check the reviewed image SHA, mode-specific pin requirement and approved root digest. Prepare requires an empty image SHA; Deploy Web run requires its pin digest. Do not replace required digest authority with a mutable tag. |
| `invalid_application_target` | The public URL or CloudFront target fails the connection contract. Check the captured HTTPS targets while preserving Host/SNI/TLS validation. |
| `deployment_identity_mismatch`, `web_deployment_mismatch` | Captured schema/account/region/project or web cluster/service/task-role identity is inconsistent. Re-capture the reviewed applied deployment; do not guess resource identities. |
| `invalid_feature_state`, `runtime_not_enabled` | Feature metadata is invalid or collect prerequisites are inactive. Complete the reviewed activation sequence; prepare is not a substitute for full release proof. |
| `inventory_deployment_mismatch`, `known_resource_required` | The captured owned collector name/ARN/hash or known CloudFront identity is missing/invalid. Reconcile the applied runtime contract before invoking collection. |
| `expected_web_image_missing` | ECR returned no usable image set or reported lookup failures. Check the selected repository and reviewed tag/digest; missing evidence cannot authorize another image. |
| `web_image_identity_mismatch`, `web_manifest_digest_mismatch` | Account/repository/tag/digest, alias consistency or the manifest hash disagrees. Verify the approved identity and identical manifest bytes; do not discard conflicting entries to pass. |
| `invalid_web_manifest`, `invalid_web_index`, `web_arm64_image_missing` | Manifest/schema/media or index/ARM64 evidence is unsupported or ambiguous. Use a reviewed Linux/ARM64 image with valid manifest evidence; never rewrite the response to manufacture a match. |
| `web_service_unavailable`, `web_service_not_stable` | The expected ECS service is missing, ambiguous, inactive or not fully stable at the selected revision/count. Inspect the actual rollout before verification. |
| `web_task_definition_mismatch`, `web_container_mismatch` | Task role/platform or the essential web container/image does not match the deployment. Reconcile the reviewed task definition and image rather than weakening identity checks. |
| `web_task_list_incomplete`, `web_tasks_unavailable`, `running_web_mismatch` | Task enumeration is incomplete, task reads failed, or running task health/revision/digest disagrees. Obtain complete matching task evidence; a partial list is not full deployment proof. |
| `web_identity_changed` | Closing validation could not reconfirm the original deployment ID/task definition/count/digest set or required stable/healthy state. Inspect the observed rollout; even a new deployment ID with the same task definition fails. Do not adopt a new baseline or re-resolve the tag to pass. This code is not a history audit. |
| `web_recheck_timeout` | A closing read could not fit its full 15-second allowance, timed out, or exhausted the bounded 50-second closing phase inside the original proof window. Inspect the metadata-read timing before a fresh bounded attempt; do not extend the deadline or accept HTTP proof alone. |
| `aws_throttled`, `aws_timeout`, `aws_request_failed`, `aws_access_denied` | AWS metadata read/recheck failed, including the final collector recheck. These are distinct from remapped invoke failures. Identify the read and investigate throttling, timing/provider failure or access under existing bounds; never treat unavailable metadata as empty or valid. |
| `invalid_collection_catalog` | Missing pinned membership, invalid names/shape or bounds. Reconcile the reviewed collector source, applied hash and catalog; do not pad the response or waive required types. |
| `inventory_code_mismatch` | Configured hash/revision and live collector evidence disagree or cannot be verified. Reconcile the reviewed deployment; discard the attempt's readiness claim. |
| `collection_partial`, `collection_failed`, `inventory_incomplete`, `collection_probe_incomplete` | Owned RPC result is partial/failed, has unknown attributes or has unusable counts. This is an expected hard stop, including limiter/hydrate degradation. Diagnose capacity, reachability and actual denials before an authorized fresh bounded attempt; no automatic partial/unknown retry or degraded acceptance. |
| `collection_probe_busy`, `collection_probe_throttled` | Another attempt could not be admitted after busy/superseded or confirmed invoke-throttling outcomes. Check phase budget and contention, with per-type outcomes when present; do not infer success or suppress the scheduler. |
| `collection_probe_protocol` | The collector payload is not an object with the requested type and a recognized result shape/status. Reconcile the reviewed collector/protocol without printing its raw response. |
| `collection_probe_denied` | The owned invocation was denied. Check its exact operation under the existing identity/session/IAM boundaries; do not restore ambient profiles/endpoints or grant permissions automatically. |
| `collection_probe_timeout`, `collection_probe_failed` | Inspect per-type attempts and known delivery evidence. A timeout may mean uncertain delivery or failed admission; use the structured status rather than assuming a safe blind retry. |
| `host_only_registry_required` | Mapping of the helper's registry check: missing, disabled, wrong or duplicate host; enabled foreign accounts; or malformed/oversized `/api/accounts` data. Check response shape and host registration as well as scope. Use the existing preparation/bootstrap procedure when the host is absent; do not assume foreign accounts are the cause or change scope/accounts automatically. |
| `database_clock_invalid` | The prepared result, canonical DB timestamp or local request/response bracket is invalid. Check authenticated preparation and the 35-second sample bound; do not add lower-bound tolerance or reset the marker. |
| `runtime_proof_required`, `complete_runtime_proof_required` | Returned status/mode or complete inventory/worker evidence is missing or inconsistent. Require the actual expected proof; never synthesize a successful adapter result. |
| `authenticated_runtime_proof_failed` | The proof catch received an exception other than `SmokeError`. This includes direct private-config `RuntimeSmokeError`; inspect local config/clock/file validation before assuming remote authentication failed. |
| `release_timeout` | Controller deadline/admission guard, which can override another failure when the deadline has expired. Inspect available timing and attempt status; do not extend the deadline. |
| `invalid_private_path`, `invalid_private_directory`, `invalid_private_file`, `private_response_too_large`, `configuration_too_large`, `deployment_input_too_large` | Check the owned paths, regular files, 0700/0600 modes and 16 KiB limits. A selected type can fail before an AWS attempt; zero attempts do not mean `not_started`. Do not enlarge limits, follow symlinks or delete unrelated files to pass. |
| `invalid_response` | JSON parsing failed for metadata, captured input or a private collector response. Non-JSON collector output can reach this code without becoming `collection_probe_protocol`; inspect the producer privately, never print the raw payload. |
| `forbidden_aws_operation` | A requested command is outside the controller's closed verb allowlist. Stop and review the caller/code; do not expand permissions or the allowlist as an automatic repair. |
| `private_cleanup_failed` | Cleanup failure surfaced after otherwise-successful work. Inspect only the owned private directory. Cleanup errors on an already-failing path can be suppressed, so absence of this code does not prove removal. |
| `runtime_release_failed` | An exception other than `ReleaseError` reached the release wrapper, including direct config validation/deadline exceptions outside the proof catch. Inspect local setup, private inputs and runtime behavior; this is not proof of an AWS denial. |
| `failed` | The CLI caught an unclassified exception outside typed release handling, for example local capture I/O failure. Preserve the failed outcome and inspect private input/runtime conditions without publishing raw errors. |

The helper examples below describe passed-through `SmokeError` message families,
not an exhaustive list of all helper messages. Direct `RuntimeSmokeError` paths
can instead produce the controller fallbacks above.

| Reason after `Runtime release: ` | Helper phase and bounded operator action |
| --- | --- |
| `Runtime smoke: collection_partial`, `Runtime smoke: collection_failed`, `Runtime smoke: inventory_incomplete` | Authenticated ledger proof failed after collection, independently of RPC outcomes. Inspect `inventory_quality` and current ledger evidence; a successful RPC does not override partial/failed/unknown ledger data. |
| `Runtime smoke: collection_stale`, `Runtime smoke: collection_missing`, `Runtime smoke: collection_timeout`, `Runtime smoke: collection_unavailable` | Ledger freshness, presence, bounded waiting or availability failed. Missing/unavailable evidence is not healthy zero; preserve the marker and inspect the existing bounded observations. |
| `Runtime smoke: release_timeout`, `Runtime smoke: runtime_inventory_contention` | Helper HTTP/proof admission or the single permitted contention retry cannot complete. Inspect timing and collision evidence before a fresh bounded attempt; no new proof window or scheduler suppression. |
| `Runtime smoke: <code>` | Other wrapped configuration, clock, runtime/readiness or worker failures retain the complete helper message. Follow the [reusable probe contract](#reusable-runtime-probe-contract) and [DB-clock contract](#optional-database-clock-sample); do not reduce the message to a suffix or assume every helper exception uses this path. |
| `Authenticated smoke: <phase>` | Login/database, `host_registry_http`, `inventory_http`, `worker_http`, `runtime_http`, or private-request-file phase failure, with optional validated HTTP status. Inspect the target, session, TLS and response contract privately; retain the complete phase text rather than relabeling it as a ledger/RPC code. |

Even a controller `full_verified` result retains
`remaining_prerequisites: "not_assessed"`. It reports this controller's evidence,
not workflow installation, plan/apply approval or completion of every promotion
prerequisite. Future consumers must enforce those separate gates; `prepared` is
never full runtime readiness. The consumers remain unwired in this prerequisite.

<a id="related--관련"></a>

## Related

[Manual deployment observations](deployment-audit.md) separate deployed resources, schedule execution and observed inventory after provisioning.
[CI setup/assets](dev-repo-setup.md) · [SQL reader](agent-sql-reader.md) · [Multi-account](onboard-target-account.md) · [Inventory rollback](steampipe-quota-and-staleness.md).
Sources: `scripts/v2/ci_readiness_plan_summary.py`, `scripts/v2/test_ci_readiness_plan_summary.py`, `scripts/v2/ci_runtime_policy.py`, `scripts/v2/ci_tf_assets.py`, `scripts/v2/ci/prepare-runtime-host.mjs`, `scripts/v2/ci/runtime-release.mjs`, `scripts/v2/ci/runtime-release.test.mjs`, `scripts/v2/runtime-smoke.mjs`, `scripts/v2/authenticated-smoke.mjs`, `web/app/api/db/route.ts`, `terraform/foundation/runtime-read-scope.tf`, `.github/workflows/terraform.yml`.
ADRs: 001, 002, 005, 007, 009, 011, 016, 021. Infrastructure apply is not live readiness proof.
