# Runtime verifier session policies

## Symptoms

A development verifier cannot create its session policy, or its deployer
credentials permit operations beyond the controller's command allowlist.
Application-level allowlists do not restrict the underlying AWS session.

The helper supplies session policies for manual collection and Deploy Web's
development verification phase. It does not assume a role or wire workflows.
Review each consumer's credential-assumption steps separately; helper availability
alone does not establish that a workflow uses a restricted session.

**Current wiring:** `collect-runtime.yml` provides manual prepare/collect.
Every dev Deploy Web push or dispatch captures `runtime_deployment`, prepares
authenticated proof credentials, and requires full verification after rollout.
The helper generates the session policies consumed by both workflows.

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

## Action and integration contract

Retain the existing operator-owned deployer role. For manual collection, apply
the backend and workload policies in separate OIDC sessions. Deploy Web
verification uses only the workload policy; the earlier deployment phase
retains the existing credential contract. Consumers must pass the generated
policy to the credential-assumption step. No role, trust policy or persistent
IAM attachment is added here.

| Phase | Allowed AWS operations | Boundary |
| --- | --- | --- |
| Both | STS caller identity | Configured account/role is checked; region is fixed |
| Backend capture | S3 object read and bucket location | One configured default-workspace state object and its bucket, bound to the owner account |
| Backend listing | S3 bucket listing | Exact state-key/listing prefixes; Terraform 1.15.7 lists the configured workspace prefix even for default workspace |
| Backend decryption | KMS decrypt | Configured key if present; otherwise account/region constrained, only via S3 and the bound bucket/object encryption context |
| Workload, both modes | ECR manifest read | Only the project's web repository |
| Workload, both modes | ECS service/task reads and task listing | Only the web service and project-cluster task resources; DescribeTasks and ListTasks both require the cluster condition |
| Workload, both modes | ECS task-definition read | AWS does not support resource-level scope for this action; region restricted, with consumer-side family validation |
| Workload, collect only | Lambda configuration read and invocation | Exactly the owned inventory-sync function |

`prepare` receives no Lambda invocation permission. Neither workload session has
S3/KMS backend access, direct SSM/Secrets Manager/Bedrock/SQS/Step Functions/DB/log
access, nor infrastructure deployment permissions. SSM/model/worker proof belongs
to the authenticated HTTP/BFF path, not direct CI service calls. The backend
session cannot write state or lock files; it supports private initialization,
console/output capture, not Terraform plan/apply.

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
  steps and cleanup cover push and manual dev runs, independently of the legacy
  `verify_database` input.
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
the existing 15-minute schedule, with the narrower explicit payloads below.

The CLI publishes `policy_file` and `session_policy`. It masks the complete policy,
Resource ARNs, bare S3 bucket and bucket/key forms, and configured account first.
It fails outside
Actions, on invalid context/state, oversized policies, missing publication,
symlink/public/non-regular input files, or an existing output policy file.

### Collection effects and proof

Collect consumers must use `RequestResponse` on the pinned function's
unqualified ARN, without a version or alias qualifier.
Each event must contain exactly one explicit `type`: `catalog` for discovery or
a member of the code-verified catalog for collection. **An absent `type` defaults
to `all`**, which triggers asynchronous fan-out; empty payloads, `type=all`,
unregistered types and `Event` invocation are forbidden. **IAM cannot constrain
the Lambda event body**; the reviewed controller enforces these payloads and the
at-most-four concurrent collector limit.

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
| `catalog` | Exactly `status: "catalog"` and a bounded, nonempty, unique `types` list containing `cloudfront`; no result `type` or counts are expected |
| Each returned catalog type | `status: "succeeded"`, matching `type`, nonnegative integer `row_count` and `unknown_attribute_count: 0` |

The release controller invokes every returned type synchronously with at most four collectors. It never invokes `type=all`, unknown types or asynchronous Event batches. IAM restricts the function ARN, not the event body; reviewed controller code must enforce these payloads.

Busy/superseded and confirmed invocation throttling may retry within bounded windows. Denied, uncertain-delivery, partial, failed, unknown and malformed responses never prove collection. Disable automatic SDK/CLI invoke retries. Catalog discovery is capped at 450 seconds. All type attempts share the remaining global collection budget, with 450 seconds needed to admit the at-most-420-second function; no per-type fifteen-minute window is reserved. See the [collection contract](runtime-foundation.md#collection-contention--수집-경합).

The release marker precedes every collection call. Every catalog type needs an authenticated ledger row under host `self` with `succeeded`, post-marker start and last-success timestamps, known counts and zero unknown attributes. A scheduled success cannot substitute for a failed owned RPC; a recent pre-marker success cannot pass. Caller/runtime identity separately binds the expected AWS account. A fresh known-host CloudFront record, nonce-bound AgentCore/model response and both owned worker completions remain mandatory.

The full-policy quality result describes the complete supplied catalog, with categorized gaps and observation timestamps. RPC attempt outcomes are distinct from ledger proof. Failed, partial, stale, missing or unknown evidence blocks acceptance; no rolling-success or degraded mode is allowed. Release mode changes only the shared bounded collection wait, not these data criteria. The single proven-contention retry must revalidate every type before the next AgentCore probe. All work stays within the absolute proof deadline and remaining request/model/worker allowances.

These checks establish the configured catalog's evidence contract, not universal AWS-resource coverage or trigger attribution. The policy generator itself invokes no workloads and changes no flags, scheduler or IAM grants.

Verifier-triggered collection changes freshness timestamps. Do not label those
observations as EventBridge execution or schedule attribution. The separate
[deployment audit](deployment-audit.md) remains observation-only and invokes no
workloads; sharing its backend parser does not alter its policy grants or calls.

The trust boundary remains reviewed workflow code on a trusted runner. Session
restrictions do not prevent malicious future workflow code from requesting a
different OIDC session under the existing role. A dedicated role is separate
IAM-owner work, outside this policy helper.

## Related files and decisions

- `.github/workflows/collect-runtime.yml`, `.github/workflows/deploy-web.yml`, and `scripts/v2/ci/runtime-release.mjs`

- `scripts/v2/ci_verifier_sessions.py` and `scripts/v2/test_ci_verifier_sessions.py`
- `scripts/v2/ci_deployment_audit.py` and `scripts/v2/test_ci_deployment_audit.py`
- `scripts/v2/ci_runtime_policy.py`
- [Runtime foundation](runtime-foundation.md) and [deployment audit](deployment-audit.md)
- [AWS ECS authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html)
- Terraform v1.15.7: `internal/backend/remote-state/s3/backend_state.go`, workspace listing.

ADRs: 002 (authenticated application access), 005 (no product mutation/autonomy
relaxation), 021 (quota-limited inventory collection).
This change is not an ADR-005 exception.
