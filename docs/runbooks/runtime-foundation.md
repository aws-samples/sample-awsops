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
2. This controller adopts an already-running web stack with working foundation, migrations and login. A brand-new stack must first follow the [reviewed first-web bootstrap procedure](first-web-bootstrap.md). `CI_READONLY_RUNTIME_DEV=true` enables core runtime, without enabling the separate readiness capability; manual full plan/apply require real login/DB and an enabled host registry with no enabled foreign rows.
3. `runtime-ecr-bootstrap` creates only three repositories. Build ARM64 images and set verified `STEAMPIPE_IMAGE_DIGEST_DEV` / `WORKER_IMAGE_DIGEST_DEV` before a full plan.
4. Dev/preview private discovery requires full-plan `runtime_rollout=true` and DNS permission; dev also requires the profile. Keep `domain_rollout=false`. Profile/rollout require remediation, RCA write-back, integrations write and diagnosis notifications off; governed external writes are not reclassified as FROZEN.
5. Review/apply the same branch/SHA plan and encrypted assets. Preserve public DNS, certificates and network topology; unchanged owned ECS registration still requires DNS permission. Missing/mismatched bundles require a new plan. `CI_ASSETS_READY=true` selects layer verification, not rebuilding.

```bash
# After the profile, base application and verified digests are configured:
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev -f mode=plan -f plan_scope=full -f runtime_rollout=true -f allow_dns_changes=true
```
Host-only removes only collector AssumeRole; Agent MCP grants remain. IAM includes known regions regardless of current opt-in; newly launched AWS regions require a fresh apply. IAM narrowing also applies to already-enabled main/preview stacks independently of the dev profile.
S3 steady denials remain unknown: rows carry `attributes_unknown`, the ledger increments `unknown_attribute_count`, and freshness is `degraded`. This incomplete evidence blocks release readiness for the affected catalog type, as defined in the [collection contract](#collection-contention--수집-경합).
The digest/host-preflight profile is dev-only. Preview retains operator-configured mutable tags or digests and multi-account scope, without dev host verification; account/role and private-DNS ownership checks still apply.

## Collector catalog prerequisite

Deploy the collector's read-only `type=catalog` mode before enabling the full-release
controller. It returns the registered type names without collecting resources or
scheduling work. Catalog acknowledgement alone never proves collection completeness;
the release controller requires fresh, complete post-marker evidence for every returned
type as specified in the [collection contract](#collection-contention--수집-경합).

## Readiness capability

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
or timeout is advisory and does not fail the later encrypted-artifact steps.
An unavailable, incomplete or unsupported summary requires
[private exact-plan inspection](dev-repo-setup.md#private-exact-plan-inspection).
The original encrypted artifacts, provenance and exact-saved-plan apply gates
remain required; no check or credential boundary is bypassed.

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

<a id="required-development-release-check--개발-배포-필수-검증"></a>

## Required development release check

Every dev Deploy Web release verifies web role/revision/digest, collector code, complete post-marker collection for every current catalog type, a fresh known CloudFront record, SSM/AgentCore/model access and owned Lambda/Fargate completion. `verify_database` cannot disable this gate.

Before release, explicitly set `CI_READINESS_ENABLED_DEV=true` (or `ci_readiness_enabled=true` in operator inputs with the override unset), review/apply runtime and readiness, then provision AgentCore from applied output. `CI_READONLY_RUNTIME_DEV` alone does not enable readiness. The [capability contract](#readiness-capability) defines dev-only enablement, verifier group and managed-demo conditions, token lifetime and the absence of admin/IAM grants.

For an **already-running web stack with inactive backends**, first apply the reviewed base plan so runtime_deployment exists; never disable an active profile to repeat bootstrap. Prepare verifies that existing web image/service/login and host registry. It does not create the first web deployment. Bootstrap/build the three runtime repositories and verified images, then review/apply the full private-DNS runtime plan. Provision AgentCore after its private migration, then deploy. A brand-new stack without a working web service follows [first-web bootstrap](first-web-bootstrap.md) before these commands; this controller supplies no first-web bootstrap or health-only bypass.

```bash
gh workflow run collect-runtime.yml -R aws-samples/sample-awsops --ref dev -f mode=prepare
# After verified images, explicit readiness opt-in and the reviewed full runtime apply:
gh workflow run deploy-agentcore.yml -R aws-samples/sample-awsops --ref dev -f smoke=false
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f build=true
# To verify an already-deployed reviewed image without rolling web, substitute its full 40-character SHA:
gh workflow run collect-runtime.yml -R aws-samples/sample-awsops --ref dev -f mode=collect -f image_sha="<deployed-web-commit-sha>"
```

Prepare accepts disabled backends and reports `prepared`; keep its `image_sha` empty. Collect requires the exact deployed 40-character image SHA. Neither mode retires runtime, resets passwords or promotes users to admin.

Terraform plan/private host preparation, Deploy Web and manual collection bind `TF_VAR_DEMO_PASSWORD` as step-scoped `TF_VAR_demo_password`. Protected tfvars retain Terraform precedence; only private credential-file paths cross steps.

<a id="existing-stacks-and-rollback--기존-스택과-롤백"></a>

### Existing stacks and rollback

Before the first gated release, apply the reviewed runtime/readiness configuration, complete private migrations and provision the matching AgentCore image. This applies to existing stacks too. `Capture development runtime contract` validates feature flags **before** the image pin and ECS rollout; absent runtime features fail there. Actual access/data/worker proof still runs after rollout. Roll back to a reviewed prior image with these runtime prerequisites intact; there is no health-only escape or password reset.

<a id="adopting-an-existing-verifier-group--기존-검증-그룹-채택"></a>

### Adopting an existing verifier group

Before the first readiness apply, check whether `deployment-verifiers` already exists in this stack's user pool and whether Terraform already manages it. Do not delete/recreate the group or change passwords to resolve an import conflict. If a separately created group exists, include a reviewed import block in the saved plan before the apply; likewise import an existing managed-demo membership only when that resource's conditions are true. Verify the plan imports the exact intended group/membership, grants no IAM role/admin membership, and does not replace the pool or user. Use the actual pool ID and configured username; examples below are placeholders. If the existing group has an IAM role or unexpected membership, stop for an owner-reviewed adoption decision instead of silently changing its privileges. Remove the temporary import blocks after successful adoption.

```hcl
import {
  to = aws_cognito_user_group.deployment_verifiers[0]
  id = "<pool-id>/deployment-verifiers"
}
# Only when the managed demo membership already exists and its count is enabled:
import {
  to = aws_cognito_user_in_group.demo_readiness[0]
  id = "<pool-id>,deployment-verifiers,<configured-demo-username>"
}
```

Group import uses a slash; membership uses comma-separated pool/group/username. These imports adopt state without authorizing additional privileges. The controller does not provision either resource. Later removal does not rewrite issued ID-token group claims; follow the [revocation guidance](#readiness-capability) for their remaining 12-hour lifetime.

<a id="collection-contention--수집-경합"></a>

### Mandatory full collection

Before invocation, the controller compares live `CodeSha256` with `runtime_deployment.inventory.sync_code_sha256`, derived from configured `source_code_hash`. Apply reviewed configuration to persist this expected fingerprint; provider observations cannot authorize unreviewed code. The controller also captures the Lambda revision and rechecks the hash and revision after all owned collection calls settle, before authenticated acceptance. A concurrent code/configuration change rejects that evidence, including a change restored to the same hash with a different revision.

Every current catalog type (43 in this version) must have succeeded after the release marker, with known counts and zero unknown attributes. Partial, failed, stale, missing or unknown evidence blocks the release. A recent success from before the marker cannot substitute. The controller obtains the complete catalog from the verified Lambda and synchronously invokes each type through at most four concurrent collectors. It never submits `type=all` or asynchronous Event batches; existing scheduled work can still contend with its calls.

After catalog discovery, authenticated preparation verifies login, DB and host registration and samples Aurora's UTC clock. That `server_time` becomes the marker before all collection calls and remains fixed across retries. The controller calibrates later clock reads from the DB sample and local request-start timestamp, conservatively, and shifts the existing overall deadline by the same offset. It never anchors at response end or allows pre-marker data. DB-request and host-check elapsed time consume the marker window; malformed or missing clock evidence stops collection. Catalog admission allows up to 450 seconds. All type attempts and their retries share the remaining collection admission window; there is no separate fifteen-minute allowance per type. An invocation needs 450 seconds remaining for the verified function timeout of at most 420 seconds plus transport. Only confirmed throttling, busy and exact superseded outcomes retry, after ten seconds. Denied, uncertain-delivery, partial, failed, unknown and malformed outcomes cannot prove collection. All admitted workers settle before private files are cleaned.

The controller has a fifty-minute overall deadline. The authenticated proof uses the earlier of that deadline and marker plus thirty minutes, as defined in the [shared probe contract](#reusable-runtime-probe-contract). Collection admission reserves seventeen minutes inside this proof deadline for login, data, model and worker checks, leaving at most thirteen minutes after a fresh marker, reduced by the clock-sampling and host-check elapsed time. Poll windows are caps rather than promises that every slow operation can finish. Missing capacity, time or permissions legitimately fail with type-specific diagnostics.

The seventeen-minute reserve is for the minimum no-retry success path: five 35-second HTTP calls, one 80-second readiness probe, two 370-second worker paths and a 15-second collector revision read total 1,010 seconds, leaving ten seconds. One contention retry adds at least 180 seconds (65-second cooldown, 35-second ledger read and another 80-second probe); it reuses the same not-yet-started worker allowances rather than adding them twice. Earlier operations must finish faster than their full allowances to make that retry available. Insufficient time fails before cooldown; no second proof window is created.

`collection_attempts` records per-type attempts, last outcomes, nullable counts and aggregate outcomes. Its `collector_rpc` source is not ledger proof; zero attempts mean a type was not admitted. Failed batches keep inventory quality unverified and cannot reach runtime/worker acceptance. Successful batches must still pass strict authenticated ledger checks for every catalog type, the fresh known CloudFront record, the nonce-bound SSM/AgentCore/model response and both owned `noop` Lambda and `noop-heavy` Fargate jobs before reporting `full_verified`. Enqueue acknowledgement is insufficient.

A proven CloudFront running-sweep collision can permit one cooldown/revalidation retry only when its remaining-budget checks pass; it is not guaranteed after the maximum collection window. Every type must be complete again before the next AgentCore probe. No degraded fallback or weaker inventory policy is available. Full-policy quality/gaps describe the supplied catalog and available evidence; they are not an independent guarantee that every AWS resource or attribute exists in that catalog.

Deploy Web passes the pin step's digest as `EXPECTED_WEB_DIGEST`. The verifier queries ECR by this approved digest and accepts only that root or its verified Linux/ARM64 child, so later movement of the source tag cannot redefine the approved image. Manual observational collect and prepare retain explicit tag selection when no expected digest is supplied.

Verification steps have a 55-minute cap; manual setup has a 75-minute job cap and separate restricted 30-minute backend/one-hour workload sessions. Restored Terraform inputs and backend metadata are removed after capture, with final cleanup retained. Process or runner loss can prevent cleanup. Verification changes no scheduler, concurrency setting, feature flag or IAM grant.

### Operational data and release acceptance

The collector can finish while disclosing unknown attributes, or retain last-good rows after partial/failed work. Those are supported operational data states for diagnosis; they do not satisfy the owner's stricter release condition. Every current catalog type must have succeeded after the marker with known counts and zero unknown attributes. An IAM/SCP denial or hydrate fallback therefore blocks release until its cause is addressed. There is no tolerance override, automatic permission widening or scheduler-disable path.

The existing fifteen-minute schedule remains active. The controller requires both its successful RPC results and strict ledger evidence at the verification observation. It does not attribute the singleton ledger to its own run token. A later scheduled partial/failed/unknown result can intentionally block acceptance, because current incomplete data is not eligible; a current running attempt waits within the shared window. The bounded retry policy never substitutes older success or suppresses the schedule to produce a green result.

The time budget is a fail-closed admission policy, not a guarantee for every workload size. With a fresh marker, the thirteen-minute collection window and 450-second full-invocation allowance mean a new type must start within the first 330 seconds. The verified 420-second Lambda timeout sets that conservative allowance; the same function serves all types. Deployments whose volume, throttling or contention cannot fit must stop for capacity/permission investigation instead of shortening proof checks or accepting incomplete inventory.

A 2026-09-14 operator measurement used the reviewed deployed collector, all 43 catalog types, four synchronous lanes and the same admission floor: all RPCs succeeded with known counts/zero unknown attributes in **57.461 seconds**, with the last admitted call at **39.802 seconds**. A following SQL-reader check verified post-marker ledger evidence for all 43 types. The schedule was enabled before and after the measurement; that alone does not establish an overlapping scheduled invocation or a latency guarantee. This demonstrates feasibility for that measured development workload, not web-role/model/worker readiness or approval of other deployments.

<a id="deployer-verification-permissions--deployer-검증-권한"></a>

### Deployer verification permissions

The [session contract](runtime-verifier-sessions.md#action-and-integration-contract) defines S3/KMS backend and ECS/ECR/owned-Lambda workload permissions with resource/region conditions. Manual verification requires both nonempty policies; Deploy Web requires the workload restriction after rollout. Both require STS caller verification and reject unrestricted fallback. The controller grants no IAM; denied reads require investigation.

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

The reusable helper's optional `collectionMode: "release"` selects a nominal collection-wait cap of twenty minutes rather than ten. The controller does not reserve or promise that whole wait after its synchronous collection phase. Both the initial poll and a contention recheck share the original cap, further constrained by the remaining absolute deadline and proof-admission checks.
Every runtime entry point has a finite deadline: verify expires 30 minutes after
`collectionStartedAt`, while prepare gets at most 30 minutes from entry. A caller deadline
can only shorten it. Authentication, HTTP, cooldowns and workers share the bound. Admitted
poll responses still must arrive before the overall deadline to pass. Start promptly after
the marker; an older marker shortens the available collection and worker budget.

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

<a id="related--관련"></a>

## Related

[Manual deployment observations](deployment-audit.md) separate deployed resources, schedule execution and observed inventory after provisioning.
[CI setup/assets](dev-repo-setup.md) · [SQL reader](agent-sql-reader.md) · [Multi-account](onboard-target-account.md) · [Inventory rollback](steampipe-quota-and-staleness.md).
Sources: `scripts/v2/ci_readiness_plan_summary.py`, `scripts/v2/test_ci_readiness_plan_summary.py`, `scripts/v2/ci_runtime_policy.py`, `scripts/v2/ci_tf_assets.py`, `scripts/v2/ci/prepare-runtime-host.mjs`, `scripts/v2/ci/runtime-release.mjs`, `terraform/foundation/runtime-read-scope.tf`, `terraform/foundation/controller-readiness.tf`, `.github/workflows/terraform.yml`, `.github/workflows/collect-runtime.yml`, `.github/workflows/deploy-web.yml`.
ADRs: 001, 002, 005, 007, 011, 016, 021. Infrastructure apply is not live readiness proof.
