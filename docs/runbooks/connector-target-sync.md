# Connector target sync

## Purpose and scope

`connector_target_sync_enabled` (default `false`) makes a just-registered ClickHouse, Prometheus,
Loki, Tempo or Mimir datasource callable from chat without waiting for the next `make agentcore`
run. When an administrator adds one of those datasources, `POST /api/datasources/manage` enqueues a
`connector_target_sync` worker job. The job synchronously invokes the dedicated
`<project>-connector-target-sync` Lambda (`scripts/v2/workers/connector_targets.py`), which creates
or updates exactly one awsops-owned target, `<kind>-mcp-target`, on the kind's catalog gateway:
`awsops-v2-external-obs-gateway` for ClickHouse/Prometheus and `awsops-v2-monitoring-gateway` for
Loki/Tempo/Mimir. The target configuration is the same one the provisioner writes (packaged
`catalog.py`).

This is ADR-023 (`docs/decisions/023-connector-target-registration.md`), the ADR-005 owner-override exception of 2026-11-05, the second after ADR-015. The exact
write action set is `bedrock-agentcore:CreateGatewayTarget` and `bedrock-agentcore:UpdateGatewayTarget`
on the two gateway ARN patterns above, plus the read calls `ListGateways`, `GetGateway`,
`ListGatewayTargets` and `GetGatewayTarget`. The grant sits only on the dedicated
`<project>-connector-target-sync` function role; the shared worker role holds only
`lambda:InvokeFunction` on that one function. The job never deletes, never repoints another stack's
target, and accepts only this stack's connector Lambda ARNs supplied by Terraform
(`CONNECTOR_TARGET_LAMBDAS`).

## Prerequisites

- `workers_enabled`, `agentcore_enabled` and `integrations_enabled` are all `true` (Terraform
  rejects `connector_target_sync_enabled=true` otherwise).
- The provisioner has already run (`make agentcore`), so both catalog gateways exist. The job never
  creates a gateway.
- **Enable the flag on at most one awsops stack per account (ADR-023 limit 7).** Before enabling,
  confirm no other awsops stack in the account runs `make agentcore`. Gateway names are account-wide (not
  `var.project`-scoped), and `provision.py ensure_gateways` rewrites a gateway's `roleArn` to the
  AgentCore role of whichever stack last ran `make agentcore`. The job's `GetGateway` check therefore
  accepts whichever stack currently owns the gateway, not a fixed stack. With two stacks in one
  account, the stack that most recently ran the provisioner is the one whose datasource
  registrations can write targets; IAM cannot separate the stacks because the gateway ARN patterns
  are shared.

## Enable

1. Set `connector_target_sync_enabled = true` in the stack's tfvars.
2. Produce a saved plan, review it, then apply that plan (`terraform apply tfplan`). Never use
   `-auto-approve` on shared infrastructure.
3. The reviewed apply creates the function, its role, log group and the worker invoke grant, and
   redeploys the web and worker with the flag set. No separate deploy step is needed.

## Verify

1. Sign in as an administrator and add a connector datasource in `/integrations`.
2. Open `/jobs` and find the `connector_target_sync` job for that kind. A `succeeded` row carries
   the result (`status`, optional `reason`, `target`); a `failed` row carries the error.
3. Read the function log group `/aws/lambda/<project>-connector-target-sync`. Each invocation
   writes one JSON line per outcome with `status`, `reason`, `kind`, `target` and `gateway` (no ARNs):

   ```bash
   aws logs tail /aws/lambda/<project>-connector-target-sync --since 1h
   ```

4. List the gateway's targets:

   ```bash
   aws bedrock-agentcore-control list-gateways
   aws bedrock-agentcore-control list-gateway-targets --gateway-identifier <gateway-id>
   ```

5. `created` and `updated` mean the request was accepted, not that the target is READY. Wait for
   the target to reach READY before expecting chat to see the connector tools.

## Reason codes

Read the outcome from the job row or the function log line, then act as follows.

| Status | Reason | Meaning | Action |
|---|---|---|---|
| `created` | — | Missing target creation request accepted | Wait for READY |
| `updated` | — | This stack's target had drift (schema/credential) and the update was accepted | Wait for READY |
| `exists` | — | Target already matches the expected configuration | None |
| `exists` | `concurrent_create` | A racing create produced the target, and its Lambda, credentials and schema match | None |
| `skipped` | `concurrent_create_mismatch` | A racing create produced a target whose configuration differs | Find the other writer (another stack or a provisioner run); run `make agentcore` from the owning stack |
| `skipped` | `disabled` | `CONNECTOR_TARGET_SYNC_ENABLED` is not `true` in the runtime | Enable per this runbook, or ignore |
| `skipped` | `invalid_kind` | Payload kind is missing or malformed | Check the datasource kind; report if it came from the product |
| `skipped` | `not_a_connector_kind` | Kind is outside ClickHouse/Prometheus/Loki/Tempo/Mimir, or has no catalog target | Expected for other kinds; none |
| `skipped` | `gateway_not_supported` | The catalog target exists but is not on the external-obs or monitoring gateway | Out of scope; run `make agentcore` |
| `skipped` | `connector_lambda_not_deployed` | No connector Lambda ARN for the kind in `CONNECTOR_TARGET_LAMBDAS` | Apply the stack so the connector Lambda exists, then re-add the datasource |
| `skipped` | `gateway_role_unknown` | `CONNECTOR_TARGET_GATEWAY_ROLE_ARN` is unset or malformed | Re-apply the reviewed plan; report if it persists |
| `skipped` | `gateway_owned_by_another_stack` | Gateway `roleArn` is not this stack's AgentCore role | Another stack last ran the provisioner; see the one-stack-per-account caveat |
| `skipped` | `gateway_auth_not_iam` | Gateway inbound auth is not `AWS_IAM` | Manual gateway replacement per `docs/reference/05-agentcore.md`; never automatic |
| `skipped` | `target_owned_by_another_stack` | Existing target invokes a Lambda that is not one of this stack's connectors | Leave it; resolve through the owning stack or the operator process |
| `skipped` | `target_points_at_another_connector` | Existing target invokes another of this stack's connector Lambdas | Run `make agentcore` to reconcile |
| `skipped` | `function_not_configured` | Worker has no `CONNECTOR_TARGET_SYNC_FUNCTION` | Re-apply the reviewed plan so the worker env is set |
| `failed` | `gateway_unavailable` | Catalog gateway missing or ambiguous (not exactly one by name) | Run `make agentcore` |
| `failed` | `target_id_missing` | Listed target has no `targetId` | Re-add the datasource; if it repeats, run `make agentcore` and report |
| `failed` | `sdk_model_missing` | The Lambda runtime SDK lacks the `bedrock-agentcore-control` model or a required operation (detail = botocore version) | Run `make agentcore` instead and report the runtime SDK version |
| `failed` | AWS error class name (for example `ClientError`) | A control-plane call failed (access denied, throttling, conflict without a listed target) | Inspect the log and the IAM grant; re-add the datasource or run `make agentcore` |

## Emergency stop

Stop new writes without a Terraform apply by setting the function's reserved concurrency to 0
(ADR-023 limit 8). Jobs then fail instead of writing; restore by deleting the concurrency setting.

```bash
aws lambda put-function-concurrency --function-name <project>-connector-target-sync \
  --reserved-concurrent-executions 0
aws lambda delete-function-concurrency --function-name <project>-connector-target-sync   # restore
```

## Disable and rollback

Set `connector_target_sync_enabled = false` and apply a reviewed saved plan. The apply removes the
function, its role and the worker invoke grant. Disabling revokes this job's write authority; it
does **not** delete targets the job already wrote or remove chat's access to them. To withdraw that
access, an operator checks these targets, which carry no ownership tag distinguishing them from
provisioner-written ones: `clickhouse-mcp-target` and `prometheus-mcp-target` on
`awsops-v2-external-obs-gateway`; `loki-mcp-target`, `tempo-mcp-target` and `mimir-mcp-target` on
`awsops-v2-monitoring-gateway`. Remove a target only through the provisioner or the operator
process, never from the product (ADR-005, ADR-023).

## Catalog revision (accepted risk)

The function packages `catalog.py` at `terraform apply` time. If `make agentcore` later writes a
newer tool schema from a newer checkout, the next registration on this stack can rewrite that target
to the packaged schema (ADR-023 Consequences). Keep Terraform applies and `make agentcore` on the
same reviewed revision; after a catalog change, apply the stack before or together with the
provisioner run.

## Retries

The job does not retry control-plane errors. Re-adding the datasource enqueues a new job, and
`make agentcore` remains the full reconciler.

## Related files

- `scripts/v2/workers/connector_targets.py` — function logic and reason codes
- `scripts/v2/workers/handlers.py` — `connector_target_sync` job handler and invoke
- `terraform/foundation/workers.tf` — dedicated function, role and worker invoke grant
- `terraform/foundation/variables.tf` — `connector_target_sync_enabled`
- `docs/reference/05-agentcore.md` — connector target sync reference

Related ADRs: ADR-023 (this exception, owner 2026-11-05), ADR-005, ADR-015, ADR-007.
