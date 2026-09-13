<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: e080165686c7 · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Agent Module — Reviewer Context

Strands Agent (Python) for AgentCore Runtime. Connects to 9 domain gateways (network,
container, iac, data, security, monitoring, cost, ops, external-obs) via MCP protocol.
`agent.py` is the entrypoint; Gateway selection is dynamic via the `payload.gateway`
parameter.

## Build · Test
```bash
cd agent && python3 -m pytest test_agent.py test_readiness.py -q
```
Docker image must be arm64 (`docker buildx --platform linux/arm64`), Python 3.11-slim,
port 8080.

## Architectural boundaries
- `readiness.py` requires `DEPLOYMENT_READINESS_ENABLED=true` (default off; never payload-controlled).
  Provision it only from the applied `ci_readiness_enabled` boolean; shell overrides are ignored.
  A deterministic 500-row sample cannot prove absence: use `known_resource_unverified`.
  Its `deployment_readiness` mode verifies runtime STS identity,
  curated inventory tools through the existing Ops gateway, a known fresh CloudFront record
  and a bounded model call. Return nonce/account-bound evidence, never normal chat/fallback
  success. Do not send inventory data to this model probe or equate non-discovery with absence.
- Workload inventory reads go through MCP tools. The bounded readiness probe directly
  checks execution identity and model permission without sending inventory to the model.
- The gateway/tool inventory and the chat routing-key list are **not** hand-maintained in this
  module's docs (they've drifted stale there before) — the actual sources are
  `scripts/v2/agentcore/catalog.py` (provisioner catalog), `ai.tf`'s `local.agent_lambdas`, and
  `web/lib/route.ts`'s `RULES`.
- The system prompt is role-specific, one per domain gateway.
- Normal chat fallback: if the MCP connection fails, run without tools through a direct
  Bedrock call. Deployment readiness instead returns failed evidence.

## Do-not-"fix" traps
- **Gateway key-derivation mismatch** (`_resolve_gateway_key`): key discovery can yield a
  `v2-<x>` prefixed variant while the env-based fallback and the `observability`→`external-obs`
  alias use the canonical unprefixed key. `_resolve_gateway_key` deliberately tries both — don't
  collapse it to one lookup, that reopens a silent-fallback-to-`ops` bug.
- **Cross-account self-assume trap**: when the chat target account is the host account, do not
  "fix" credential resolution back to self-assuming a role on the host — that role only exists
  in v1 *target* accounts and causes an `AccessDenied` misdiagnosed as "cross-account blocked."
  The exec role is used directly for the host case by design.

## Review checklist
1. No new AWS-mutating call, IAM change, or hardcoded secret/account-ID/ARN/domain (ADR-005
   FROZEN boundary — flag any new tool performing create/update/delete/run-arbitrary-command).
2. Any new gateway/tool wiring goes through the v2 provisioner
   (`scripts/v2/agentcore/{catalog,provision}.py`), not the older `create_targets.py` (v1/dark —
   only 8 gateways, missing `external-obs`). Do not promote a dark v1 tool into v2 wiring.
3. New routing keys or gateway aliases must be reflected in `web/lib/route.ts`'s `RULES`, not
   just in `agent.py`.
4. Docker/Lambda images stay arm64.

## Known false-positives
- `create_targets.py` existing in the tree is fine — it's retained as dark v1 code, not dead
  code to delete. Flag only if something re-wires it live.
- A gateway lookup trying both a canonical and a `v2-`-prefixed key is intentional (see
  do-not-"fix" traps above), not redundant code.
