# Runtime verifier session policies

## Symptoms

A development verifier cannot create its session policy, or its deployer
credentials permit operations beyond the controller's command allowlist.
Application-level allowlists do not restrict the underlying AWS session.

The helper supplies session policies for manual collection and Deploy Web's
development verification phase. It does not assume a role or wire workflows.
Review each consumer's credential-assumption steps separately; helper availability
alone does not establish that a workflow uses a restricted session.

**Current wiring:** this checkout does not contain `collect-runtime.yml`.
Deploy Web verifies login/database access for every dev release, including pushes;
its compatibility `verify_database` input cannot disable those checks. This web
proof does not capture `runtime_deployment` or wire the broader runtime verifier.
The integration requirements below do not describe already-wired verification
steps. The helper change does not install either consumer path.

## Candidate causes

- Omitting or publishing an empty `inline-session-policy` leaves the existing
  deployer session unrestricted.
- Combining backend and workload access retains state-read privileges throughout
  a long verification run.
- Trusting arbitrary resource names from captured JSON can broaden a generated
  policy beyond the configured account/region and the captured state's project.
  Project identity comes from that state, not an independent configured value.
- Missing inventory, AgentCore or workers enablement, the owned collector
  fingerprint, or the known CloudFront ID prevents collect-policy creation.

## Verification commands

From the repository root, without AWS credentials:

```bash
python3 -m pip install -r scripts/v2/requirements-test.txt
python3 -m pytest scripts/v2/test_ci_verifier_sessions.py -q
python3 -m pytest scripts/v2/test_ci_deployment_audit.py -q
python3 -m pytest scripts/v2/test_ci_runtime_policy.py -q
node --test scripts/v2/ci/runtime-release.test.mjs scripts/v2/deployment-smoke.test.mjs
```

Tests cover allowed operations, denied sibling resources/regions/actions,
backend parsing, KMS conditions, private files, immediate FIFO rejection,
masking and publication failures.
The caller matrix covers both Deploy Web events, collect-only workload access,
backend denial for Deploy Web, and preservation of manual prepare/collect behavior.
The size test confirms policies with maximum-length project names fit STS's
2,048-character limit; it does not exercise oversized-policy rejection.
These are offline policy-boundary
checks, not an assertion of effective live access under every IAM/SCP policy.
The Node fixtures require the tools listed in the
[controller CLI contract](runtime-foundation.md#controller-cli-contract).

## Action and integration contract

Retain the existing operator-owned deployer role. For manual collection, apply
the backend and workload policies in separate OIDC sessions. When adding Deploy Web
verification, use only the workload policy; the earlier deployment phase
retains the existing credential contract. Consumers must pass the generated
policy to the credential-assumption step. No role, trust policy or persistent
IAM attachment is added here.

| Phase | Allowed AWS operations | Boundary |
| --- | --- | --- |
| Both | STS caller identity | Configured account/role is checked; region is fixed |
| Backend capture | S3 object read and bucket location | One configured default-workspace state object and its bucket, bound to the owner account |
| Backend listing | S3 bucket listing | Exact state-key/listing prefixes; Terraform 1.15.7 lists the configured workspace prefix even for default workspace |
| Backend decryption | KMS decrypt | Supplied key only when `encrypt=true` and `kms_key_id` is present; otherwise the existing account/region-constrained wildcard, only via S3 and the bound bucket/object encryption context |
| Workload, both modes | ECR manifest read | Only the project's web repository |
| Workload, both modes | ECS service/task reads and task listing | Only the web service and project-cluster task resources; DescribeTasks and ListTasks both require the cluster condition |
| Workload, both modes | ECS task-definition read | AWS does not support resource-level scope for this action; region restricted, with consumer-side family validation |
| Workload, collect only | Lambda configuration read and invocation | Exactly the owned inventory-sync function |

The backend `encrypt` option is a strict boolean and defaults to false when absent,
matching Terraform and the private-plan/audit parsers. A declared `kms_key_id` is
inactive with false/omitted `encrypt`; it is not proof of the actual state key or
bucket encryption posture. State-read and KMS service/context restrictions remain.

`prepare` receives no Lambda invocation permission. Neither workload session has
S3/KMS backend access, direct SSM/Secrets Manager/Bedrock/SQS/Step Functions/DB/log
access, nor infrastructure deployment permissions. SSM/model/worker proof belongs
to the authenticated HTTP/BFF path, not direct CI service calls. The backend
session cannot write state or lock files; it supports private initialization,
console/output capture, not Terraform plan/apply.

The controller isolates the AWS CLI environment as well as restricting IAM: only
explicitly allowlisted credentials/settings reach a pinned CLI path. It disables
AWS config/shared-credential files and instance metadata, ignores configured endpoints,
and drops ambient profile, provider, endpoint, CA/proxy and command-hook overrides.
Those safeguards do not replace the configured/actual caller or nonempty session-policy checks.

The workload input is the private Terraform `runtime_deployment` document
(`schema_version`, account/region/project, web identity and feature/resource
fields). This is distinct from the later smoke configuration
(`schemaVersion`, `prepare`/`verify`, host/freshness options). The policy helper
uses `RUNTIME_MODE=prepare|collect`; it does not reinterpret the smoke protocol.
`PIN_SHA` is the reviewed deployed web-image commit: the helper checks its format
only; the consumer binds the image to ECR and running tasks. It need not equal
the workflow's `GITHUB_SHA`, and it must be empty in prepare mode.
Accepted callers are limited to this repository and `refs/heads/dev`. The full
`GITHUB_WORKFLOW_REF` must use this repository's prefix and the exact path/ref
below. `TARGET=dev`, account/role, source SHA, image-pin, region and default-workspace checks
apply to every row.

| Policy phase | Workflow path/ref | Event | `RUNTIME_MODE` |
| --- | --- | --- | --- |
| Backend | `.github/workflows/collect-runtime.yml@refs/heads/dev` | `workflow_dispatch` | `prepare` or `collect` |
| Workload | `.github/workflows/collect-runtime.yml@refs/heads/dev` | `workflow_dispatch` | `prepare` or `collect` |
| Workload | `.github/workflows/deploy-web.yml@refs/heads/dev` | `push` or `workflow_dispatch` | `collect` only |

Deploy Web cannot request a backend policy or use prepare mode.
`CI_ROLE_ARN` is the configured deployer role and
`BACKEND_B64` is the private encoded backend input used only by the backend phase.

Manual collection integration must:

1. Validate the manual dev source, configured role/account and mode before AWS
   access. Use fresh per-run private directories and files with 0700/0600 permissions.
2. Build the backend policy before the first credential assumption, require a
   nonempty policy output, and pass that exact output as `inline-session-policy`.
   A missing/failed output must fail the job, never fall back to a full session.
3. Verify the actual caller, prepare HTTP credentials privately, and capture
   validated runtime state while only the backend session is active.
4. Generate the workload policy from that private state. Set `--directory` to
   the credential producer's private directory and pass its captured state as
   `--deployment-file`; the state file must be directly inside that directory.
   Backend policy files can use a separate per-run directory. Remove captured
   Terraform inputs, require the second nonempty output, then refresh credentials
   with that policy. The consumer verifies the fresh caller again.
5. Clean the owned policy and credential files in always-run cleanup, including
   failure/cancellation paths. Do not sweep unrelated runner temporary files.

Deploy Web integration must establish these prerequisites before using the
workload policy:

- Scope all added preparation/capture/verification steps to
  `github.ref == 'refs/heads/dev'`; the workflow also serves other branches.
  Set `TARGET=dev`, `AWS_REGION=ap-northeast-2`, `RUNTIME_MODE=collect`, and the
  configured `AWS_ACCOUNT_ID_DEV`/`CI_ROLE_ARN`. Use the actual Actions
  `GITHUB_*` context and output file, not fabricated caller metadata.
- Collect requires an activated runtime profile: captured
  `features.inventory`, `features.agentcore` and `features.workers` must all be
  true in applied state, with the owned collector code hash and known CloudFront
  identity. Complete reviewed runtime/readiness activation before deployment
  mutations and mandatory verification. The consumer must validate those captured
  fields and abort before image re-pinning or service rollout if any is missing;
  the later workload-policy build is not a substitute for this pre-mutation check.
  Feature-off bootstrap uses the
  [first-web procedure](first-web-bootstrap.md) and manual prepare path; collect
  is not its fallback. Missing activation or proof must fail closed, not silently
  skip verification or restore an unrestricted session.
- Prepare the existing configured HTTP proof credentials and capture validated
  `runtime_deployment` privately in the same run, before deployment mutations,
  under the existing deployment credentials and backend/account guards. These
  steps and cleanup must cover push as well as manual dev runs. Current dev
  credential preparation already covers both; runtime-deployment capture and
  scoped runtime verification still require this separate integration.
- Resolve `PIN_SHA` exactly as the image-promotion step:
  `${{ inputs.image_sha || github.sha }}`. Require a full lower-case 40-character
  commit SHA; reject invalid values rather than substituting a different image.

After deployment, immediately before verification's credential refresh, build
the workload policy from that captured file. Deploy Web must not request a
backend policy from this helper. The same 0700 directory/0600 file binding,
nonempty-policy requirement, fresh-caller check and always-run owned-file cleanup
apply. Missing policy output must fail the job, never retain or recreate an
unrestricted verification session. Full authenticated runtime/model/worker proof
remains mandatory; policy generation or database smoke alone does not establish it.
Use the bounded busy/superseded handling and release-mode proof contract below;
they do not authorize skipping missing or failed proof. Push-triggered verification
uses the same owned collector's application-data effects already automated by
the existing 15-minute schedule, through the explicit per-type payloads below.

The CLI publishes `policy_file` and `session_policy`. It masks the complete policy,
Resource ARNs, bare S3 bucket and bucket/key forms, and configured account first.
It fails outside
Actions, on invalid context/state, oversized policies, missing publication,
symlink/public/non-regular input files, or an existing output policy file.

### Collection effects and proof

Collect consumers must use `RequestResponse` on the pinned function's
unqualified ARN, without a version or alias qualifier.
The [owner acceptance condition dated 2026-09-14](https://github.com/aws-samples/sample-awsops/pull/67#issuecomment-5663692939)
requires complete post-marker collection of all 43 current catalog types. The
strict controller therefore sends exactly `{"type":"catalog"}`, followed by
`{"type":"<catalog member>"}` for every validated returned type. This supersedes
the earlier catalog/CloudFront-only consumer proposal; IAM scope is unchanged.
**An absent `type` defaults to `all`**, which triggers asynchronous fan-out.
Empty events, `type=all`, types outside the verified catalog and `Event` invocation
are forbidden. **IAM cannot constrain the Lambda event body**; the reviewed
controller must enforce the explicit payloads. The catalog is read from the
hash-verified owned function, with hash/RevisionId rechecked after collection.

There is at least one catalog request plus at least one request per type, not four calls in total.
At most four owned invocations are **concurrent and in flight**. Catalog throttling
can retry too; busy/superseded or throttled retries add calls within the same finite budget. The controller is
unwired in this prerequisite; integrating it does not authorize changing schedule,
reserved concurrency, feature flags or IAM without their separate reviewed procedures.

The existing collector can upsert/prune application inventory and ledger rows in
Aurora and replace that day's inventory snapshot rows. This is explicitly
authorized operator CI collection, not product
autonomy or an ADR-005 AWS-resource-mutation exception. It does not provision or
remediate AWS resources. The helper itself makes no AWS calls.

Observability does not require new CI log, CloudWatch or DB permissions. First
verify the function identity, configured code fingerprint and active ARM64
configuration. Project only validated fixed fields from AWS responses;
never echo Lambda/task-definition responses, environment maps, HTTP bodies or
raw AWS errors. Each synchronous response must have `StatusCode=200`, no
`FunctionError`, and `ExecutedVersion: "$LATEST"`. That envelope is insufficient:

| Payload | Required result |
| --- | --- |
| `catalog` | Exactly `status: "catalog"` and a unique catalog containing every pinned baseline member (currently 43), with valid growth allowed up to 128 total. The source-AST test binds baseline membership to the checked-in collector. No result `type` or counts are expected. |
| Each catalog member | `status: "succeeded"`, exact requested `type`, nonnegative safe-integer `row_count`, and `unknown_attribute_count: 0` |

`busy`, `failed` (including superseded), `partial`, unknown-type errors and
malformed results never prove collection. A bounded retry of explicit contention
— invocation-level throttling or a busy/superseded result — may succeed only
through a later valid owned response; scheduled work cannot substitute for
any required successful owned RPC. Catalog discovery has a 450-second total budget,
including retries: each request has a process cap of at most 150 seconds, a CLI read
timeout of at most 120 seconds, and a 15-second admission floor. Remaining time can
shorten those request limits; catalog discovery does no resource collection.
Per-type calls and retries share the remaining global collection window, with a full
450-second allowance required before each admission. Their 440-second CLI read timeout
exceeds the verified function timeout of at most 420 seconds; that comparison applies
only to per-type collection, not catalog discovery. There is no separate 900-second
per-type budget. Disable automatic SDK/CLI invoke retries.

Both prepare and collect require the enabled host only, rejecting enabled foreign
accounts as `host_only_registry_required`; generic multi-account smoke behavior is
outside this controller's scope. After web/configuration/catalog checks and before
any per-type invocation, collect's authenticated prepare verifies login, DB and that
host-only registry and obtains the DB-clock sample. An unsupported registry is
rejected at this preflight, before spending the collection window on type calls.
Use that DB timestamp as the marker and calibrate subsequent time at request
start, shifting the existing deadline by the same offset. Then require every
catalog type's ledger `started_at` and durable `last_success_at` at or after
the marker, succeeded status, known counts and zero unknown attributes.
This job-level ledger is keyed under the host `self` sentinel, not
the host's numeric AWS account ID. Require fresh known-host CloudFront evidence
as well; caller/runtime identity separately verifies the expected AWS account.
This demonstrates advancement past the
pre-invoke marker; an old ledger success, or a scheduled success accompanying a
`busy` owned response, is insufficient. Full readiness additionally requires the
authenticated BFF/AgentCore and owned worker HTTP proofs. A successful invoke
alone never establishes it.

The catalog lists registered types, not acknowledged invocations. The controller
must complete each owned RPC and the authenticated verifier must independently
observe strict post-marker evidence for every returned type. The shared helper's
nominal 1,200-second release-mode poll cap is clipped by the existing deadline;
it does not extend the marker's 30-minute lifetime or the controller's 50-minute cap.
The controller reserves 18 minutes: the single-pass proof, collector recheck and
50-second closing web check total 1,060 seconds, leaving 20 seconds of margin.
Authentication/model/workers must finish 50 seconds before the original proof deadline.
Closing service/list-tasks/describe-tasks reads each have a 15-second cap, with five
seconds of overhead, and stay inside the original deadline. They reuse the initial
deployment ID, immutable task-definition proof, count and ECR digest set without a
new tag lookup. Matching start/end observations do not prove continuous identity or
exclude an unseen intermediate restore. Prepare has no closing recheck.
Collection has at most 720 seconds; the 450-second admission floor leaves a latest
start of 270 seconds, reduced by clock preparation and earlier deadlines. An extra
35-second read needs at least 15 seconds saved. A full retry adds at least 215 seconds
(35-second confirmation, 65-second cooldown, 35-second recheck, 80-second probe),
requiring at least 195 seconds saved. The helper checks the remaining 180 seconds
plus worker allowances only after confirmation; workers are not counted twice.
Extra reads/waits/overhead need more time, and no extras are guaranteed.
See [the controller budget and operational acceptance contract](runtime-foundation.md#strict-release-controller-capability).

There is no rolling prior-success substitute or degraded-release acceptance.
Operational collection can preserve partial/last-good data for diagnosis, but
partial or unknown outcomes are intentional terminal hard stops even when shared
limiter pressure or hydrate/reachability failures cause them. Diagnose capacity,
connectivity or actual denials before an authorized fresh bounded rerun; do not
automatically retry those outcomes, widen permissions or disable the schedule.
The first chronological terminal failure stops new type admission; all already-admitted
operations settle before cleanup. Unassigned types remain `not_started` with zero
attempts in the structured report. The six status-based counts (`succeeded`, `partial`,
`failed`, `unknown`, `deadline`, `not_started`) partition `expected`. A selected type
whose first call is blocked by the 450-second floor is `deadline` with zero attempts, not `not_started`;
attempt counts alone do not classify status. This does not make the separate inventory
quality gap categories disjoint. Partial, failed, stale, missing or unknown
evidence blocks release. A current
running attempt waits within the shared window. The singleton ledger is not
owned by this verifier's run token: a later scheduled failed/partial/unknown result
can also block release, even after the owned RPC succeeded. The schedule remains
enabled, and no scheduler attribution is inferred from verifier-produced freshness.
Fresh known-host CloudFront, actual AgentCore/model proof and both owned workers
remain mandatory. The policy generator neither invokes types nor repairs failures;
the strict controller supplies the collection orchestration when wired.
Its `remaining_prerequisites: "not_assessed"` result does not approve the separate
workflow/plan/promotion gates; see the [fixed diagnostics](runtime-foundation.md#fixed-diagnostics-and-remaining-prerequisites).
That table distinguishes controller reasons from passed-through `SmokeError` messages.
Direct `RuntimeSmokeError` config failures can become controller fallbacks. For example,
`collection_partial` is an RPC reason, while `Runtime smoke: collection_partial`
is a ledger reason; do not normalize them by stripping the prefix.

Verifier-triggered collection changes freshness timestamps. Do not label those
observations as EventBridge execution or schedule attribution. The separate
[deployment audit](deployment-audit.md) remains observation-only and invokes no
workloads; sharing its backend parser does not alter its policy grants or calls.

The trust boundary remains reviewed workflow code on a trusted runner. Session
restrictions do not prevent malicious future workflow code from requesting a
different OIDC session under the existing role. A dedicated role is separate
IAM-owner work, outside this policy helper.

## Related files and decisions

- `scripts/v2/ci/runtime-release.mjs` and `scripts/v2/ci/runtime-release.test.mjs`;
  [controller CLI inputs and combined tests](runtime-foundation.md#controller-cli-contract)
- `scripts/v2/ci_verifier_sessions.py` and `scripts/v2/test_ci_verifier_sessions.py`
- `scripts/v2/ci_deployment_audit.py` and `scripts/v2/test_ci_deployment_audit.py`
- `scripts/v2/ci_runtime_policy.py`
- [Runtime foundation](runtime-foundation.md) and [deployment audit](deployment-audit.md)
- [AWS ECS authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html)
- Terraform v1.15.7: `internal/backend/remote-state/s3/backend_state.go`, workspace listing.

ADRs: 002 (authenticated application access), 005 (no product mutation/autonomy
relaxation), 009 (worker ownership), 021 (quota-limited inventory collection).
This change is not an ADR-005 exception.
