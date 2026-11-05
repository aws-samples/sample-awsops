# ADR-023: Connector Target Registration Exception

## Status

**Accepted — explicit, dated owner-override exception to ADR-005 (the second, after ADR-015).**

- **Panel evidence: 2026-11-05**, Claude chair, Codex (gpt-6.1-sol), kiro-opus (claude-opus-5.5) and
  kiro-minimax (minimax-m2.5) reviewed the draft of this ADR and its implementation (PR #231). All
  three peers returned ACCEPT-WITH-CHANGES. Their required changes are applied here: the exception is
  stated as a partial reversal limited to the enumerated writes; the one-stack-per-account rule is a
  decision limit; the IAM description says what IAM does not enforce; dates and framing in code and
  docs cite this ADR; an emergency stop is named. Dissent: kiro-opus proposed create-only (drop
  `UpdateGatewayTarget`) to remove catalog-skew rollback; Codex required skew to be bounded; kiro-minimax
  accepted skew as an operational window. The owner kept create **and** update and accepts that
  risk explicitly (Consequences).
- **Owner sign-off: Junseok Oh, 2026-11-05**, after the panel. Authorizes this narrow gateway-target
  registration only.
- In this repository this ADR amends **ADR-005 Decisions 1 and 4**. It partially reverses the
  2026-06-11 freeze **solely** for the writes enumerated below; every other ADR-005 prohibition stands.
  It does not create a general "awsops-owned resources" category and is not a scoping clarification.
- Recorded in this public repository (`docs/decisions/`) because the change ships here; ADRs 001–021
  remain in the private upstream register and are cited by number.

## Context

Registering a ClickHouse, Prometheus, Loki, Tempo or Mimir datasource stores its endpoint in Aurora,
but the chat agent reaches connectors only through AgentCore gateway targets that `make agentcore`
(`scripts/v2/agentcore/provision.py`) creates. A connector Lambda created by a later Terraform apply
therefore had no target until the next provisioner run, and chat reported zero connector tools for a
datasource an administrator had just added (observed on dev, 2026-11-04).

ADR-005 Decision 3 requires a new ADR, a multi-AI panel and a dated owner override to change the
freeze; documentation edits and self-scoping reinterpretations cannot substitute. An earlier draft of
this change described own-resource writes as "outside the freeze"; AI review rejected that framing for
the same reason ADR-015's panel did. This ADR therefore names an exception.

## Decision

The **only** additional authorized autonomous AWS write is creating or updating one gateway target for
a just-registered datasource kind, under all of these limits:

1. `connector_target_sync_enabled` defaults to **false** and requires `workers_enabled`,
   `agentcore_enabled` and `integrations_enabled`. **Enable it on at most one awsops stack per AWS
   account** (see limit 7).
2. Trigger: an administrator **adding** a datasource through the admin-gated
   `POST /api/datasources/manage`. Editing a datasource does not enqueue the job, and the generic
   `/api/jobs` route never accepts this job type (its allowlist is `noop`/`noop-heavy`).
3. Actions: `bedrock-agentcore:CreateGatewayTarget` and `UpdateGatewayTarget`, plus the reads
   `GetGateway`, `ListGatewayTargets`, `GetGatewayTarget` and `ListGateways`. No delete action, no
   gateway create/update, no other service.
4. IAM: a **dedicated** `<project>-connector-target-sync` Lambda role with two statements:
   `ListGateways` on `"*"` with the runtime region condition (the action has no resource type), and the
   other five actions on the gateway ARN patterns `gateway/awsops-v2-external-obs-gateway-*` and
   `gateway/awsops-v2-monitoring-gateway-*` (Service Authorization Reference: resource type `gateway`,
   `gateway/${GatewayId}`). The shared worker role holds only `lambda:InvokeFunction` on that function.
   **IAM does not enforce** which target name is written, its Lambda ARN, its tool schema, which
   awsops stack owns the gateway, or whether another target on those gateways (for example a vendor
   MCP preset) is touched. Those limits are enforced only by `scripts/v2/workers/connector_targets.py`
   (`CONNECTOR_KINDS`, `CONNECTOR_TARGET_LAMBDAS`, the `GetGateway` check, the update guards). This
   leaves a deliberately narrow but real write capability on those two gateways.
5. Scope enforced in code: the five catalog connector kinds, one target `<kind>-mcp-target` on the
   kind's catalog gateway, pointing only at this stack's own connector Lambda (ARNs supplied by
   Terraform), with the configuration the provisioner writes (catalog packaged at apply time).
6. Before writing, the function confirms via `GetGateway` that the gateway runs as this stack's
   AgentCore role with `AWS_IAM` inbound auth; otherwise it writes nothing. An existing target is
   updated only when it already points at this kind's own Lambda; another stack's or another
   connector's target is never repointed. A concurrent-create conflict is reported as `exists` only
   after the target is listed.
7. One stack per account: gateway names are account-wide and `provision.py ensure_gateways` rewrites a
   gateway's role to whichever stack last ran it, so the `GetGateway` check is not atomic with the write
   and identifies the stack that currently owns the gateway. Operators confirm no other awsops stack in
   the account runs the provisioner before enabling the flag.
8. Emergency stop without an apply: set the function's reserved concurrency to 0
   (`aws lambda put-function-concurrency --function-name <project>-connector-target-sync
   --reserved-concurrent-executions 0`); disabling the flag through a reviewed apply removes it.

The exception does not cover deleting targets, creating or changing gateways, other AgentCore
resources, other services, observed workloads, or customer infrastructure. A list-shaped
implementation, comment or document is not authority to widen it. ADR-005's frozen remediation,
arbitrary BYO-MCP and mutating tools remain unchanged; ADR-015 remains the only other exception.

## Consequences

Chat can use a newly registered connector without an operator rerunning the provisioner. Accepted
residual risks, documented in `docs/runbooks/connector-target-sync.md`:

- **Stack boundary** (limit 7): in an account with several awsops stacks, the stack that last ran the
  provisioner owns the gateways; IAM cannot separate stacks.
- **Catalog skew (accepted by the owner):** the catalog is packaged at `terraform apply` time. If the
  provisioner later writes a newer tool schema from a newer checkout, the next datasource registration
  on this stack can rewrite that target to the packaged (older) schema until the stack is re-applied or
  the provisioner runs again. Keep Terraform applies and `make agentcore` on the same reviewed revision.
- **Disable leaves targets:** disabling the flag revokes this job's write authority but does not remove
  targets it wrote or chat's access to them. Withdrawing access is an operator action: check the five
  targets `clickhouse-mcp-target`, `prometheus-mcp-target` (external-obs) and `loki-mcp-target`,
  `tempo-mcp-target`, `mimir-mcp-target` (monitoring); they carry no ownership tag distinguishing them
  from provisioner-written targets.
- `created`/`updated` mean request acceptance, not READY.

## Six Pillars

Security: two write actions on a dedicated role, pinned gateways and kinds, no delete, admin trigger,
and an explicit statement of what IAM does not enforce. Operational Excellence: dated panel and owner
evidence instead of an own-resource reinterpretation; a kill-switch without an apply. Reliability:
idempotent, delete-free, and `make agentcore` remains the full reconciler.

## Evidence

`terraform/foundation/workers.tf` (`connector_target_sync` resources),
`scripts/v2/workers/connector_targets.py`, `scripts/v2/workers/handlers.py`,
`web/lib/connector-targets.ts`, `web/app/api/datasources/manage/route.ts`,
`docs/runbooks/connector-target-sync.md`, PR #231, ADR-005, ADR-015.
