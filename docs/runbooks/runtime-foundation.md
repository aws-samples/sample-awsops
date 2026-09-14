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
2. This controller adopts an already-running web stack with working foundation, migrations and login. A brand-new stack needs a separate reviewed first-web bootstrap procedure before using it. `CI_READONLY_RUNTIME_DEV=true` enables core runtime, without enabling the separate readiness capability; manual full plan/apply require real login/DB and an enabled host registry with no enabled foreign rows.
3. `runtime-ecr-bootstrap` creates only three repositories. Build ARM64 images and set verified `STEAMPIPE_IMAGE_DIGEST_DEV` / `WORKER_IMAGE_DIGEST_DEV` before a full plan.
4. Dev/preview private discovery requires full-plan `runtime_rollout=true` and DNS permission; dev also requires the profile. Keep `domain_rollout=false`. Profile/rollout require remediation, RCA write-back, integrations write and diagnosis notifications off; governed external writes are not reclassified as FROZEN.
5. Review/apply the same branch/SHA plan and encrypted assets. Preserve public DNS, certificates and network topology; unchanged owned ECS registration still requires DNS permission. Missing/mismatched bundles require a new plan. `CI_ASSETS_READY=true` selects layer verification, not rebuilding.

```bash
# After the profile, base application and verified digests are configured:
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev -f mode=plan -f plan_scope=full -f runtime_rollout=true -f allow_dns_changes=true
```
Host-only removes only collector AssumeRole; Agent MCP grants remain. IAM includes known regions regardless of current opt-in; newly launched AWS regions require a fresh apply. IAM narrowing also applies to already-enabled main/preview stacks independently of the dev profile.
S3 steady denials remain unknown: rows carry `attributes_unknown`, the ledger increments `unknown_attribute_count`, and freshness is `degraded`. The release discloses this degradation and keeps completeness `unknown`; its owned CloudFront proof still requires zero unknown attributes. Other catalog types must retain recent successful collection as defined in the [collection contract](#collection-contention--수집-경합).
The digest/host-preflight profile is dev-only. Preview retains operator-configured mutable tags or digests and multi-account scope, without dev host verification; account/role and private-DNS ownership checks still apply.

## Collector catalog prerequisite

Deploy the collector's read-only `type=catalog` mode before enabling the full-release
controller. It returns the registered type names without collecting resources or
scheduling work. Catalog acknowledgement alone never proves collection completeness;
the controller must still check fresh complete results for every returned type.

## Readiness capability

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

Every dev Deploy Web release now verifies the running web role/revision/digest, the owned
inventory Lambda code, a fresh owned CloudFront probe and recent catalog collection,
actual SSM/AgentCore/model access and
owned Lambda/Fargate job completion. `verify_database` cannot disable this gate.
Before this gate, explicitly set `CI_READINESS_ENABLED_DEV=true` (or explicitly set
`ci_readiness_enabled=true` in operator Terraform inputs with the override unset), review/apply
the readiness and runtime configuration, and provision AgentCore from the applied output.
`CI_READONLY_RUNTIME_DEV` alone does not enable readiness. Terraform creates only the
verifier application group when readiness and AgentCore are enabled; managed-demo membership
also requires `create_demo_user=true`. Public CI rejects enabled readiness outside dev;
no admin/IAM role is granted. See [capability and token lifetime](#readiness-capability).

For an **already-running web stack with inactive backends**, first apply the reviewed base plan so runtime_deployment exists; never disable an active profile to repeat bootstrap. Prepare verifies that existing web image/service/login and host registry. It does not create the first web deployment. Bootstrap/build the three runtime repositories and verified images, then review/apply the full private-DNS runtime plan. Provision AgentCore after its private migration, then deploy. A brand-new stack without a working web service needs a separate reviewed bootstrap procedure before using these commands; this controller supplies no first-web bootstrap or health-only bypass.

```bash
gh workflow run collect-runtime.yml -R aws-samples/sample-awsops --ref dev -f mode=prepare
# After verified images, explicit readiness opt-in and the reviewed full runtime apply:
gh workflow run deploy-agentcore.yml -R aws-samples/sample-awsops --ref dev -f smoke=false
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f build=true
# To verify an already-deployed reviewed image without rolling web, substitute its full 40-character SHA:
gh workflow run collect-runtime.yml -R aws-samples/sample-awsops --ref dev -f mode=collect -f image_sha="<deployed-web-commit-sha>"
```

Prepare accepts disabled backends and reports `prepared`, not `ready`. Its `image_sha` must
remain empty; collect requires the exact deployed 40-character image SHA. Keep credentials unchanged; never reset a password or
promote the user to admin. Runtime retirement remains unsupported by this workflow. Terraform plan/private host preparation,
Deploy Web preparation and manual collect-runtime preparation each bind the shared
`TF_VAR_DEMO_PASSWORD` secret as step-scoped `TF_VAR_demo_password`. Protected stack tfvars
retain Terraform precedence; only private credential-file paths cross steps.

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

The group import ID uses a slash; membership uses comma-separated pool/group/username, per the pinned AWS provider's resource import contracts. Import is a reviewed state adoption, not authorization for additional privileges. The release
controller does not provision the group or membership. Removing either on a later reviewed apply
does not rewrite already-issued ID-token group claims; follow the
[readiness capability and revocation guidance](#readiness-capability) for their remaining 12-hour lifetime.

<a id="collection-contention--수집-경합"></a>

### Collection contention

Collector code verification uses the configured archive fingerprint:
`runtime_deployment.inventory.sync_code_sha256` comes from the Lambda
`source_code_hash`, and the controller compares it with the live `CodeSha256` before
invocation. A lagging provider observation must not reject a matching rollout or bless
code changed outside the reviewed configuration. Apply the reviewed configuration to
persist the output; changing a repository variable or producing a plan is insufficient.

The controller reads the complete catalog from the code-checked inventory Lambda, then invokes only the owned CloudFront collector synchronously. It does not enqueue another all-type sweep or run a stale-terminal batch queue. Ledger rows no longer control RPC retry admission. Only the bounded owned probe is retried; all other catalog types still require fresh successful evidence from the existing scheduled collector.

Catalog admission has a 450-second budget and retries only confirmed Lambda throttling. The CloudFront probe has a 900-second budget; each invocation needs at least 450 seconds remaining for the verified function timeout of at most 420 seconds plus transport overhead. Confirmed throttling, `busy`, and the producer's exact superseded result wait ten seconds before another bounded attempt. Denied, uncertain-delivery, partial, failed, and invalid-protocol outcomes fail distinctly. A successful RPC alone is not readiness proof.

The release marker is recorded after catalog discovery and **before** the first CloudFront
probe, and survives retries. The synchronous owned response must itself report `succeeded`,
a valid row count and zero unknown attributes. The known record must be captured after the
marker. The AgentCore probe separately requires that exact record and the producer's configured
freshness policy. Capture this actual runtime/known-record proof before the longer catalog wait;
failures while obtaining it still block. Neither an old known record nor a successful RPC alone passes.

The later catalog read requires durable CloudFront `last_success_at` at or after the marker.
Its singleton ledger row may now describe a newer scheduled attempt: running/partial/failed
or unknown-attribute results are disclosed as degraded, without revoking the owned proof
already obtained. Failed/running attempts report attribute coverage as unassessed rather than
reusing an earlier attempt's zero. A pre-marker success never satisfies this check.

Every other catalog type requires `last_success_at` within thirty minutes of the collection
observation, independently of the release marker. The producer preserves this timestamp when a
later attempt is running, partial or failed. Such attempts, and succeeded rows with unknown or
unassessed attributes, are reported in `collection.degraded_types`; they do not erase recent
success evidence or establish complete data. Missing or stale last-success evidence continues
polling and ultimately fails as `collection_missing` or `collection_stale`. Malformed evidence
fails as `collection_protocol`. A failed/partial CloudFront probe still blocks immediately.

Release output uses `catalog_types` and `collection.status` (`current` or `degraded`);
`collection.completeness` is always `unknown`. These are observations of the complete deployed
type catalog, not proof of every resource or attribute. `expectedQueuedTypes` remains the private
wire-field name for that catalog, not an acknowledgement that CI dispatched every type.
Standalone smoke without `collectionMode: "release"` retains strict post-marker collection checks.

Release-mode collection polling allows twenty minutes after account/login checks; standalone verification retains ten minutes. The authenticated collection-only summary avoids inventory-wide aggregations. A deadline bounds the start of a poll, and a valid successful response from an admitted request is retained even if it arrives just after that deadline. No new poll begins after expiry. The runtime and both five-minute worker checks remain mandatory: one owned `noop` Lambda job
and one owned `noop-heavy` Fargate job must reach `succeeded` with the expected job identity,
runtime and successful result. Enqueue acknowledgement alone cannot pass.

The release does not wait for a whole new scheduled sweep after every push. It still requires
recent success for every deployed catalog type, so dropped or persistently failing types
eventually fail the rolling freshness bound. Inspect collector execution and persisted data
separately; a timeout does not identify dropped events. Capacity or permission repairs remain
separate reviewed operations. No type is omitted to make the gate pass.

Both verification steps have a 55-minute workflow cap with a fresh one-hour session for the same configured role; the manual job allows 75 minutes including setup. These are outer limits, not promises that every combination of slow calls will fit. Restored Terraform inputs are deleted immediately after capture, with final cleanup retained as a fallback. No schedule, feature flag or infrastructure setting is changed by the verifier.

<a id="deployer-verification-permissions--deployer-검증-권한"></a>

### Deployer verification permissions

The configured dev deployer needs these scopes before the first gated release. They supplement the existing build/pin/roll permissions; this controller does not grant IAM. Replace placeholders with the independently configured account, deployment region and project. Never grant wildcard Lambda invocation to pass the gate.

| Action | Resource / condition |
|---|---|
| `ecr:BatchGetImage` | `arn:aws:ecr:<region>:<account>:repository/<project>-web` |
| `ecs:DescribeServices` | `arn:aws:ecs:<region>:<account>:service/<project>/<project>-web` |
| `ecs:DescribeTasks` | `arn:aws:ecs:<region>:<account>:task/<project>/*` |
| `ecs:ListTasks` | `Resource: "*"`; `ArnEquals` `ecs:cluster` = `arn:aws:ecs:<region>:<account>:cluster/<project>` and deployment `aws:RequestedRegion` |
| `ecs:DescribeTaskDefinition` | `Resource: "*"` with deployment `aws:RequestedRegion`; AWS defines no task-definition resource scope for this action |
| `lambda:GetFunctionConfiguration`, `lambda:InvokeFunction` | `arn:aws:lambda:<region>:<account>:function:<project>-inv-sync` only, for catalog discovery and the bounded CloudFront probe |

ListTasks is constrained by its cluster condition for this Fargate/service query; do not substitute task-definition ARNs for unsupported resource scoping. STS caller verification remains mandatory. An API failure means access is unverified, not permission to broaden grants. Scope references: `https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html` and `https://docs.aws.amazon.com/service-authorization/latest/reference/list_lambda.html`.

<a id="related--관련"></a>

## Related

[Manual deployment observations](deployment-audit.md) separate deployed resources, schedule execution and observed inventory after provisioning.
[CI setup/assets](dev-repo-setup.md) · [SQL reader](agent-sql-reader.md) · [Multi-account](onboard-target-account.md) · [Inventory rollback](steampipe-quota-and-staleness.md).
Sources: `scripts/v2/ci_runtime_policy.py`, `scripts/v2/ci_tf_assets.py`, `scripts/v2/ci/prepare-runtime-host.mjs`, `scripts/v2/ci/runtime-release.mjs`, `terraform/foundation/runtime-read-scope.tf`, `terraform/foundation/controller-readiness.tf`, `.github/workflows/terraform.yml`, `.github/workflows/collect-runtime.yml`, `.github/workflows/deploy-web.yml`.
ADRs: 001, 002, 005, 007, 011, 016, 021. Infrastructure apply is not live readiness proof.
