# Development deployment audit

After a reviewed foundation apply, successful private migration and AgentCore
provisioning, run this manual observation workflow from `dev`:

```bash
gh workflow run audit-deployment.yml --repo aws-samples/sample-awsops --ref dev \
  -f expected_project='<exact reviewed development project>'
```

The operator owns dispatch. Do not advance `dev` while a saved apply is bound to its
current SHA. A workflow's presence does not mean that it has run.

The workflow uses `sample-awsops`, the existing `development` environment and secrets
`AWS_ACCOUNT_ID_DEV`, `AWS_CI_DEPLOYER_DEV_ROLE_ARN`, and `TF_BACKEND_HCL_DEV`.
The account secret must be the reviewed development account; there is no local-profile
or default-account fallback. Existing configured-role and actual STS-caller guards
run before reading deployment outputs. Expected project, account, region and exact
resource names/ARNs are checked before the service reads.

Only the backend is restored, privately. Terraform reads four named outputs:
`runtime_deployment`, `agentcore`, `agent_sql_reader_secret_arn`, and `aurora_database`.
Backend files and Terraform's private data directory are removed immediately after
capture, with a trap and an always-cleanup fallback. No tfvars, plan, state dump,
secret value or raw API exception is published. The Actions summary contains only
validated observations; it does not upload the private output files.

Read the three evidence groups separately:

- **Deployment:** ECS service counts plus actual running task revisions and health;
  collector Lambda state/update status and code SHA compared with applied state;
  own SSM runtime ARN followed by AgentCore status and role comparison. Target ECS
  revision alone is not running-revision proof. Unknown health or capped/incomplete
  task enumeration stays unknown.
- **Events:** the exact `-inv-sync-ec2` rule must be enabled with `rate(15 minutes)`,
  one own Lambda target and `{"type":"all"}`, plus its matching EventBridge resource
  policy grant. The grant is not proof of effective permissions. CloudWatch reports
  the last two complete hours of rule target attempts, Lambda invocations and errors.
  Missing, partial or denied metrics are **UNKNOWN**, never zero. These independent
  series cannot attribute a Lambda execution to the schedule or prove collection
  success. A reported zero requires an actual metric datapoint.
- **Data:** fixed SELECTs through RDS Data API use only the existing
  `ops/<project>/agent/sql-reader` secret ARN. The helper never calls `GetSecretValue`.
  It first verifies `awsops_sql_reader` and non-elevated role attributes, then reads
  safe `sql_reader` views: aggregate `self` ledger, host/self resource counts, and the
  known CloudFront distribution's count/timestamp. The ledger is a collector-wide
  job summary, not per-account execution proof. Up to 256 **observed** types are
  shown with truncation disclosed. Required deployed-type coverage is not derived;
  completeness always remains **UNKNOWN**. Timestamps and unknown-attribute counts
  must be assessed alongside status and counts.

Read failures retain the other groups, use fixed reason codes and fail the audit
job. Missing metrics or a `NOT_READY` observation can still produce a successful
reporting job; green Actions means the observations were collected, not that the
deployment is ready. The workflow cannot launch/stop tasks, invoke Lambda/AgentCore,
change schedules/policies, run migrations, or repair resources. Denied reads require
separately reviewed operator action; this change grants no IAM permissions.

Offline check: `python3 -m pytest -q scripts/v2/test_ci_deployment_audit.py`.
See [runtime activation](runtime-foundation.md) and [SQL reader](agent-sql-reader.md).
