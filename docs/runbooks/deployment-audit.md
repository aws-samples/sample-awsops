# Development deployment audit

## Symptoms and candidate causes

A deployed web page does not establish collector, schedule or AgentCore readiness.
Missing evidence can mean disabled infrastructure, pending provisioning, missing
reader migration, denied reads or collection that has not completed.

The audit can run after foundation apply, before AgentCore provisioning finishes.
A `PENDING` runtime reports `NOT_READY`; independent event/data reads continue.
Database evidence requires the existing SQL-reader secret and successful private
migration/password sync. An inventory-only stack without that reader reports
`reader_not_configured`, not an empty healthy database.

## Verification

The operator dispatches the manual workflow from `dev` after any saved-apply window
has closed. Do not advance `dev` while a saved apply is bound to its current SHA.

```bash
gh workflow run audit-deployment.yml --repo aws-samples/sample-awsops --ref dev \
  -f expected_project='<exact reviewed development project>'
```

The workflow uses the self-hosted runner label `sample-awsops`, the existing
`development` environment and secrets `AWS_ACCOUNT_ID_DEV`,
`AWS_CI_DEPLOYER_DEV_ROLE_ARN`, and `TF_BACKEND_HCL_DEV`. Account, configured role
and STS caller must agree; there is no local-profile/default-account fallback.
Project, region and resource identities are checked before service reads.

Two 900-second restricted sessions of the existing role separate backend capture
from workload reads; neither grants new role permissions. Before OIDC, the first
policy is built from the existing backend secret's literal bucket/key/region. S3
access is limited to that bucket/state object in the expected account. KMS decrypt
requires the S3 service and that bucket/object encryption context, additionally
using the exact key ARN when configured. The standard flat backend settings are
accepted; interpolation, credential overrides and non-default workspaces fail
closed. Policy publication must succeed before credentials can be assumed.

After capture and backend cleanup, the second session uses validated output
identities and has no backend access. `ecs:ListTasks` requires a wildcard resource
with an exact `ecs:cluster` condition. AgentCore control reads and CloudWatch
metrics use region-bound wildcard authorization, matching the existing control
read policy; SDK requests still select the validated identities. Other reads use
scoped ARNs.
Data API requires `rds-data:ExecuteStatement` on the cluster and IAM
`secretsmanager:GetSecretValue` on the exact captured reader-secret ARN. The helper
never calls the secret API; the password is nevertheless within the session's
credential scope. The current Terraform reader secret uses the AWS-managed
Secrets Manager key, so this workload session grants no KMS access. Fixed SELECTs
and the existing read-only database role bound SQL access. Policy strings and
backend identifiers are masked before being passed between workflow steps.

Only the backend is restored into private scratch. Terraform reads four existing
outputs: `runtime_deployment`, `agentcore`, `agent_sql_reader_secret_arn`, and
`aurora_database`. When the captured runtime flag explicitly confirms AgentCore
is disabled, its nullable output is represented as null without a lookup; all
other output failures stop capture. Backend/data-directory cleanup runs immediately after capture,
on capture failure, and again at job end. No tfvars, plans, state dumps, output
files, secret values or raw exceptions are published.

## Interpret the observations

- **Deployment:** ECS service counts and actual running task revisions/health;
  collector Lambda state/update status and code SHA versus the configured archive
  fingerprint persisted by Terraform apply; own SSM
  runtime followed by AgentCore status/role comparison. Web's best status is
  `OBSERVED`: current tasks match the current live service, but the existing web
  output has no applied task-definition ARN (`target_matches_state: null`).
  Steampipe can report `READY` only when its applied revision also matches.
  AgentCore's best summary is also `OBSERVED`: its literal `runtime_status`, role
  match and version are shown, while DEFAULT endpoint/invocation readiness and
  applied-version matching remain unknown. Unknown health, capped lists and count
  races stay unknown; consistent mixed-revision rollouts are `NOT_READY`.
  Disabled infrastructure reports `DISABLED`.
- **Events:** the own `-inv-sync-ec2` rule, `rate(15 minutes)`, one own Lambda target
  with `{"type":"all"}`, and matching EventBridge grant are checked separately from
  execution. A matching grant does not prove effective permissions. Three metrics
  cover a rolling two-hour window ending at the last minute boundary; recent
  CloudWatch data can lag. Missing/partial/denied metrics are **UNKNOWN**, never zero.
  An observed zero needs a real datapoint. A missing Lambda policy is an absent
  grant (`permission_matches: false`), preserving the rule/target observations.
  Rule attempts and Lambda invocations are not correlated: `type:all` fans out,
  so their counts need not match. Lambda Errors=0 is not collection success:
  the collector can return per-type failures without raising an invocation error.
- **Data:** fixed SELECTs first verify the expected reader identity and direct
  role attributes, then project safe `sql_reader` metadata. The `self` ledger is a
  collector-wide job summary. Resource counts select persisted `self` or host-ID
  rows, including legacy host-ID representations; these are not member-account
  totals. The inventory-enabled flag is explicit. Last-success counts, unknown
  attributes and oldest/newest capture timestamps remain separate; the audit
  supplies **no product freshness verdict**. Assess them using the deployment's
  configured freshness policy. The known CloudFront row is checked separately.
  Up to 256 observed types are shown with truncation disclosed. Required deployed
  type coverage is not derived; completeness always remains **UNKNOWN**.

The expected collector fingerprint is
`runtime_deployment.inventory.sync_code_sha256`, derived from the configured
Lambda `source_code_hash`. It is not the provider's observed `code_sha256`, which
can lag an update or reflect an out-of-band change. Apply the output correction
through a reviewed saved plan before relying on this comparison; a code merge
alone does not refresh persisted Terraform outputs. Compare the live Lambda hash
with that intended fingerprint when investigating a mismatch.

The data-gateway diagnostic reads only `awsops-v2-data-gateway` and its
`rds-mcp-target`. It compares the live role and target Lambda URI with applied
Terraform, publishing only match flags, never ARNs or fingerprints. Provider
`statusReasons` use fixed text-match categories (up to eight reasons); these are
observations, not inferred causes. Drift, failed provider states and missing
targets report `NOT_READY`. Gateway-role evidence survives a denied target read.
The report is public Actions output; no gateway/target update is performed.

## Action

Read/API failures (including per-series Forbidden/InternalError) retain other
groups, use fixed reason codes and fail the job. Unexpected response shapes use
`unexpected_state`; early context/identity failures produce only `audit_failed`.
A programming violation uses `read_only_violation`; stdout emission failure uses
`report_failed`. A summary-file failure warns with `audit_summary_unavailable`
while preserving the stdout report and original verdict.
Missing/partial metrics or `NOT_READY` can still produce a green
reporting job. Green means observations were collected, not deployment readiness.

Resolve provisioning, migration or access issues through their separate reviewed
operator procedures, then rerun. This workflow never launches/stops tasks, invokes
workloads, updates policies/schedules, applies Terraform or repairs resources.
Session policies cannot supply a permission missing from the underlying role.
No identity-policy grant is part of this change; access changes belong to the IAM
owner's reviewed least-privilege configuration, not an automatic deployer expansion.

## Privilege review

The existing CI role must already allow the following reads. Session policies
only restrict those grants; they cannot create a missing permission. Verify the
external, owner-managed role rather than assuming that a repository-managed
application role covers the audit. In particular, the web status role's
`GetAgentRuntime`/`List*` grant does not establish CI access to `GetGateway` or
`GetGatewayTarget`. A denied read is a failed audit with retained partial evidence.

| Phase | Required actions | Scope checked by the audit/session |
|---|---|---|
| Identity | `sts:GetCallerIdentity` | Expected development account and configured role |
| Backend | `s3:GetObject`, `s3:ListBucket`, `s3:GetBucketLocation` | Configured bucket/state key and resource-owner account |
| Encrypted backend | `kms:Decrypt` when required by S3 | Configured key when supplied; S3 service, resource-owner account and bucket/object encryption context |
| ECS | `ecs:ListTasks`, `ecs:DescribeServices`, `ecs:DescribeTasks` | Project cluster condition and service/task ARN scope |
| Collector | `lambda:GetFunctionConfiguration`, `lambda:GetPolicy` | Own inventory-sync function |
| Schedule | `events:DescribeRule`, `events:ListTargetsByRule` | Own inventory-sync rule |
| Metrics | `cloudwatch:GetMetricData` | Deployment region; fixed rule/function dimensions |
| Runtime parameter | `ssm:GetParameter` | Own runtime-ARN parameter |
| AgentCore control | `bedrock-agentcore:ListGateways`, `GetAgentRuntime`, `GetGateway`, `ListGatewayTargets`, `GetGatewayTarget` (all with the `bedrock-agentcore:` prefix) | Region-bound authorization; validated runtime/data-gateway/RDS-target selection |
| Database metadata | `rds:DescribeDBClusters` | Own Aurora cluster |
| Fixed SQL reads | `rds-data:ExecuteStatement` | Own cluster, fixed SELECTs and the restricted SQL-reader DB role |
| Data API credential use | `secretsmanager:GetSecretValue` | Exact captured SQL-reader secret ARN; no direct secret-value API call by the helper |

The current trust model is reviewed workflow code on a trusted runner using
restricted sessions of the existing role. It does not isolate against malicious
future workflow code or a compromised runner that can request another OIDC
session. A dedicated audit role is a separate IAM-owner hardening follow-up, not
an added grant or an ADR-005 exception in this workflow. Do not infer immutable
IAM isolation from the audit's read-only behavior.

Offline prerequisites: Python 3.12, Node.js 20 and bash. Install
`python3 -m pip install -r scripts/v2/requirements-test.txt`, then run
`python3 -m pytest -q scripts/v2/test_ci_deployment_audit.py` and
`python3 -m pytest -q scripts/v2/test_ci_verifier_sessions.py`. The audit shares
only backend parsing with the [development verification policy helper](runtime-verifier-sessions.md);
its own policy grants and no-invocation behavior are unchanged. Test SDK versions
match the existing `agentcore/requirements-provision.txt` pin; the workflow
installs that existing hash-locked SDK source.

## Related

[Runtime activation](runtime-foundation.md) · [SQL reader](agent-sql-reader.md) ·
[CI setup](dev-repo-setup.md) · [Inventory freshness](steampipe-quota-and-staleness.md).

Sources: `.github/workflows/audit-deployment.yml`, `scripts/v2/ci_deployment_audit.py`,
`scripts/v2/test_ci_deployment_audit.py`, `scripts/v2/ci_runtime_policy.py`,
`scripts/v2/ci_verifier_sessions.py`, `scripts/v2/test_ci_verifier_sessions.py`,
`terraform/foundation/runtime-read-scope.tf`.
ADRs: 001, 005, 010, 021. This is not an ADR-005 carve-out; read-only observations
are not live readiness proof.
