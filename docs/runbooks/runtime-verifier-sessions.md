# Runtime verifier session policies

## Symptoms

A manual development verifier cannot create its session policy, or its deployer
credentials permit operations beyond the controller's command allowlist.
Application-level allowlists do not restrict the underlying AWS session.

The manual [collection workflow](../../.github/workflows/collect-runtime.yml) uses
these policies for existing-web preparation and runtime verification. Policy creation
is not a deployment, an IAM grant or proof of readiness.

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
The size test confirms policies with maximum-length project names fit STS's
2,048-character limit; it does not exercise oversized-policy rejection.
These are offline policy-boundary
checks, not an assertion of effective live access under every IAM/SCP policy.

## Action and integration contract

Retain the existing operator-owned deployer role and obtain two separate OIDC
sessions. No role, trust policy or persistent IAM attachment is added here.

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
Backend policies accept only same-repository manual dev dispatches from
`collect-runtime.yml@refs/heads/dev`. Workload policies also accept
`deploy-web.yml@refs/heads/dev` on push/dispatch, only in collect mode.
`CI_ROLE_ARN` is the configured deployer role and
`BACKEND_B64` is the private encoded backend input used only by the backend phase.

The manual workflow must:

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

Deploy Web retains deployment privileges for image pinning and ECS rollout.
After stability, it derives the workload policy from the private captured state
and refreshes credentials with that nonempty restriction before verification.
Missing policies fail before the verifier executes; cleanup remains always-run.
Deploy Web cannot request a backend policy through this helper.

The CLI publishes `policy_file` and `session_policy`. It masks the complete policy,
Resource ARNs, bare S3 bucket and bucket/key forms, and configured account first.
It fails outside
Actions, on invalid context/state, oversized policies, missing publication,
symlink/public/non-regular input files, or an existing output policy file.

### Collection effects and proof

The `collect` consumer uses `RequestResponse` on the pinned function's
unqualified ARN, without a version or alias qualifier.
Each event must explicitly contain exactly `{"type":"catalog"}` or
`{"type":"cloudfront"}`. **An absent `type` defaults to `all`**, which triggers
asynchronous fan-out; empty events, `type=all`, other types and `Event` invocation
are forbidden in this verifier. **IAM cannot constrain the Lambda event body**;
the reviewed workflow/controller must enforce these exact payloads.

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
| `cloudfront` | `status: "succeeded"`, `type: "cloudfront"`, nonnegative integer `row_count`, and `unknown_attribute_count: 0` |

`busy`, `failed` (including superseded), `partial`, unknown-type errors and
malformed results never prove collection. A bounded retry of explicit contention
— invocation-level throttling or a busy/superseded result — may succeed only
through a later valid owned response; scheduled work cannot substitute for
that owned CloudFront proof. Use a 450-second catalog budget and a 900-second
CloudFront budget, including waits and retries. Disable automatic SDK/CLI invoke retries; for collection use
a read timeout longer than the verified function timeout (currently at most
420 seconds), inside an explicit controller deadline.

Capture the release time marker before the owned collection invocation, then
require the `cloudfront` job ledger row's durable `last_success_at` at or after
that marker. This job-level ledger is keyed under the host `self` sentinel, not
the host's numeric AWS account ID. Require fresh known-host CloudFront evidence
as well; caller/runtime identity separately verifies the expected AWS account.
This demonstrates advancement past the
pre-invoke marker; an old ledger success, or a scheduled success accompanying a
`busy` owned response, is insufficient. Full readiness additionally requires the
authenticated BFF/AgentCore and owned worker HTTP proofs. A successful invoke
alone never establishes it.

The catalog lists registered types, not acknowledged invocations. For the
controller's **release mode**, read every returned type's host job ledger
over HTTP within a bounded 1,200-second wait. CloudFront needs durable success
after the owned pre-invoke marker. Other types need durable success within the
last 30 minutes; the existing scheduler may supply that evidence. A later running,
failed, partial, or succeeded-with-unknowns attempt is reported as degraded when
that durable success remains fresh. Missing or stale success fails with a fixed
diagnostic; these budgets do not guarantee a full scheduled sweep will finish.
The helper neither invokes the other types nor repairs their producer failures.

Report aggregate collection as current/degraded with completeness unknown.
Keep the owned CloudFront result, fresh known-host record, actual AgentCore/model
proof and owned-worker proof mandatory. This release-mode contract is implemented by the controller; the existing standalone strict smoke's requirement
for clean post-marker results is unchanged. Do not infer complete AWS inventory
coverage or trigger attribution from either path.

Verifier-triggered collection changes freshness timestamps. Do not label those
observations as EventBridge execution or schedule attribution. The separate
[deployment audit](deployment-audit.md) remains observation-only and invokes no
workloads; sharing its backend parser does not alter its policy grants or calls.

The trust boundary remains reviewed workflow code on a trusted runner. Session
restrictions do not prevent malicious future workflow code from requesting a
different OIDC session under the existing role. A dedicated role is separate
IAM-owner work, outside these session restrictions.

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
