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

The existing role assumption receives a 900-second **restrictive session policy**,
not new role grants. It permits the audit reads and backend access, with workload
ARNs scoped to the selected account/project. Resource-less metrics/metadata reads
retain account/region conditions; backend reads retain existing role permissions.
KMS decrypt is limited to S3/Secrets Manager service use. No mutation action is
permitted except the required `rds-data:ExecuteStatement`, whose database access
uses the read-only SQL-reader role. Data API requires IAM
`secretsmanager:GetSecretValue` on the one named reader secret as well as
`rds-data:ExecuteStatement` on the cluster. The helper never calls the secret API;
the reader password is nevertheless within the session's authorized credential
scope. The fixed SELECT allowlist provides the additional in-process SQL boundary.

Only the backend is restored into private scratch. Terraform reads four existing
outputs: `runtime_deployment`, `agentcore`, `agent_sql_reader_secret_arn`, and
`aurora_database`. Backend/data-directory cleanup runs immediately after capture,
on capture failure, and again at job end. No tfvars, plans, state dumps, output
files, secret values or raw exceptions are published.

## Interpret the observations

- **Deployment:** ECS service counts and actual running task revisions/health;
  collector Lambda state/update status and code SHA versus applied state; own SSM
  runtime followed by AgentCore status/role comparison. Web's best status is
  `OBSERVED`: current tasks match the current live service, but the existing web
  output has no applied task-definition ARN (`target_matches_state: null`).
  Steampipe can report `READY` only when its applied revision also matches.
  Unknown health, capped lists and rolling-deployment snapshot mismatches stay
  unknown. Disabled infrastructure reports `DISABLED`.
- **Events:** the own `-inv-sync-ec2` rule, `rate(15 minutes)`, one own Lambda target
  with `{"type":"all"}`, and matching EventBridge grant are checked separately from
  execution. A matching grant does not prove effective permissions. Three metrics
  cover a rolling two-hour window ending at the last minute boundary; recent
  CloudWatch data can lag. Missing/partial/denied metrics are **UNKNOWN**, never zero.
  An observed zero needs a real datapoint. Rule attempts and Lambda invocations
  are not correlated: `type:all` fans out, so their counts need not match.
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

## Action

Read/API failures (including per-series Forbidden/InternalError) retain other
groups, use fixed reason codes and fail the job. Unexpected response shapes use
`unexpected_state`; early context/identity failures produce only `audit_failed`.
A programming violation uses `read_only_violation`; emission failure uses
`report_failed`. Missing/partial metrics or `NOT_READY` can still produce a green
reporting job. Green means observations were collected, not deployment readiness.

Resolve provisioning, migration or access issues through their separate reviewed
operator procedures, then rerun. This workflow never launches/stops tasks, invokes
workloads, updates policies/schedules, applies Terraform or repairs resources.
Session policies cannot supply a permission missing from the underlying role.
No identity-policy grant is part of this change; access changes belong to the IAM
owner's reviewed least-privilege configuration, not an automatic deployer expansion.

Offline prerequisites: Python 3.9+, pytest, PyYAML, boto3/botocore (CI uses Python
3.12 and the pinned SDK). Run `python3 -m pytest -q scripts/v2/test_ci_deployment_audit.py`.

## Related

[Runtime activation](runtime-foundation.md) · [SQL reader](agent-sql-reader.md) ·
[CI setup](dev-repo-setup.md).

Sources: `.github/workflows/audit-deployment.yml`, `scripts/v2/ci_deployment_audit.py`,
`scripts/v2/test_ci_deployment_audit.py`, `terraform/foundation/runtime-read-scope.tf`.
ADRs: 001, 005, 007, 010. Read-only observations are not live readiness proof.
