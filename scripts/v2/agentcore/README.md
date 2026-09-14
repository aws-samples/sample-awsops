# AgentCore provisioner reconciliation

Run the provisioner through the existing reviewed AgentCore deployment workflow.
The development path retains its independent account/role checks, private
migration prerequisite, pinned SDK and verified ARM64 image digest. Initial
provisioning with `smoke=false` does not prove tool invocation or overall runtime
readiness.

For exact catalog gateway names, `ensure_gateways` reads the full `GetGateway`
snapshot and reconciles the applied execution role and catalog description.
Updates copy the existing inbound authorizer, protocol configuration and optional
security settings. Missing auth/protocol identity cannot default to `NONE`.
Gateway names and create-time defaults are unchanged.

A rejected description-only update remains a warning if the existing gateway is
ready and its role already matches. A role-update or readiness failure is an
error, and that gateway is withheld from dependent target work.

Managed Lambda targets reconcile the applied Lambda ARN, gateway-IAM credential
configuration, target description and tool definitions (name, description and
input schema). Existing metadata and private-endpoint configuration are preserved.
Service-echoed optional tool fields and empty credential-provider defaults do not
cause drift. Curated MCP-server ownership/skip rules remain separate.

Gateway and Lambda-target updates wait for `READY` and read back the requested
managed values. An older `READY` snapshot is insufficient. Gateway waits are
bounded to 60 seconds; target waits to 30 seconds, polling every two seconds.
An existing `UPDATE_UNSUCCESSFUL` gateway/target or `SYNCHRONIZE_UNSUCCESSFUL`
target gets one managed update attempt per run, even if its stored fields already
match. This permits recovery from a prior asynchronous failure. Failed retries,
terminal post-update failures and timeouts remain errors, never successful updates.

Public diagnostics contain catalog keys and fixed codes, including:

| Typed failure | Public code |
| --- | --- |
| `ValidationException` | `aws_validation_failed` |
| `ConflictException` | `aws_conflict` |
| `ResourceNotFoundException` | `aws_resource_not_found` |
| SDK `ParamValidationError` | `sdk_validation_failed` |

Raw messages, credentials, configuration and ARNs are not printed. An older
`operation_failed` event cannot establish the original AWS exception or live
root cause. Separately authorized read-only gateway/target metadata or a typed
control-plane audit event is needed for attribution.

Offline regression checks, from the repository root:

```bash
python3 -m pytest -q scripts/v2/agentcore scripts/v2/ci/test_setup_provision_python.py
node --test scripts/v2/ci/runtime-build.workflow.test.mjs
```

These tests use mocked service responses and do not provision AWS resources.
API contracts: [UpdateGateway](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_UpdateGateway.html)
and [UpdateGatewayTarget](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_UpdateGatewayTarget.html).
