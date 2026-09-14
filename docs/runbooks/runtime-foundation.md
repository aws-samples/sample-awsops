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
5. Review/apply the same branch/SHA plan and encrypted assets. Preserve public DNS, certificates and network topology; unchanged owned ECS registration still requires DNS permission. Missing/mismatched bundles require a new plan. `CI_ASSETS_READY=true` selects layer verification, not rebuilding.

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

## Reusable runtime probe contract

Every supplied type requires post-marker success, known counts and zero unknown attributes.
Verify accepts optional `inventoryPolicy: "full"` for structured quality/gap return values;
omission retains strict checks and other policies fail. These payloads are programmatic:
the CLI keeps fixed status/error messages. The caller supplies the intended catalog; the
helper does not discover it. Gap categories can overlap and must not be summed as disjoint counts.

Optional `collectionMode: "release"` allows a 20-minute collection poll window instead of
10 minutes. Both the initial poll and a contention recheck share that original window.
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

<a id="related--관련"></a>

## Related

[Manual deployment observations](deployment-audit.md) separate deployed resources, schedule execution and observed inventory after provisioning.
[CI setup/assets](dev-repo-setup.md) · [SQL reader](agent-sql-reader.md) · [Multi-account](onboard-target-account.md) · [Inventory rollback](steampipe-quota-and-staleness.md).
Sources: `scripts/v2/ci_readiness_plan_summary.py`, `scripts/v2/test_ci_readiness_plan_summary.py`, `scripts/v2/ci_runtime_policy.py`, `scripts/v2/ci_tf_assets.py`, `scripts/v2/ci/prepare-runtime-host.mjs`, `terraform/foundation/runtime-read-scope.tf`, `.github/workflows/terraform.yml`.
ADRs: 001, 005, 007, 011, 016. Infrastructure apply is not live readiness proof.
