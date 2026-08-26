# Notion Read Connector — First Concrete Integration (Lambda→API MCP)

**Date:** 2026-06-14
**Branch:** `fix/v2-upgrade-snapshot-id` (worktree `gap-impl-wave1`)
**Status:** Design — approved by user direction (`/co-agent:consensus`), entering plan→build.

## Problem / Context

The v2 integration framework is fully scaffolded but no concrete connector has ever
run end-to-end. Two mechanisms exist:

- **M1 — gateway-target Lambda** (`scripts/v2/agentcore/catalog.py` `TARGETS` +
  `terraform/foundation/ai.tf` `local.agent_lambdas` + `scripts/v2/agentcore/provision.py`):
  static, gateway-native MCP tools. Every `aws_*_mcp` tool uses this. **This is the chosen form.**
- **M2 — egress integration** (Aurora `integrations` row + `web/lib/agent-resolver.ts` +
  `agent/agent.py` per-request connect to an external MCP): the inc2 path. Live-verified only on
  the *negative* path (SSRF blocks); positive path never exercised. **Not used here** (egress to a
  real external MCP is impractical right now).

The user wants the observability axis ultimately to target **datasources** (Prometheus/Loki/
ClickHouse/Tempo…) via their HTTP API, exactly as v1's `datasource-*` feature did (7 types, direct
HTTP API, AI-generated queries). But those datasources are typically **private/in-cluster** and not
reachable today, so the **first live-verifiable** concrete connector is **Notion** (public REST API,
single token), built on the same M1 mechanism. Prometheus/Loki are the next increment on the
identical pattern once network reachability is arranged.

Notion is a **knowledge** connector (read docs), orthogonal to observability, but it proves the
exact Lambda→API MCP path the datasource connectors will reuse.

## Goal

Ship a **read-only Notion MCP tool** as an M1 gateway target on the **external-obs** gateway,
live-verified against a real Notion workspace, flag-gated by `integrations_enabled`. Open the admin
gate (decoupled, parallel) for future integration-management UX.

## Non-Goals

- No write/mutation tools (read-only only — consistent with the 2026-06-11 high-risk ADR reversal:
  AWSops is a read-only ops dashboard + AI diagnosis).
- No egress (M2) usage; no public Function URL.
- No integration-management UI in this increment.
- No Aurora `integrations` row dependency for the tool to function (static M1 wiring + flag only).
- Prometheus/Loki/other datasource connectors — deferred to the next increment (same pattern).

## Architecture (data flow)

```
chat → select external-obs gateway (slash /external-obs or auto-route)
     → AgentCore Runtime → external-obs gateway
     → notion-mcp-target Lambda (awsops-v2-agent-notion-mcp; py3.11/arm64; NOT VPC-attached → internet egress)
     → Notion REST API (https://api.notion.com/v1/*; Bearer token from Secrets Manager; Notion-Version header)
     → results → agent synthesizes answer
```

## Components (single-responsibility units)

### (a) `agent/lambda/notion_mcp.py` — Notion read MCP Lambda
- **What it does:** exposes 3 read-only MCP tools, calls the Notion REST API, returns structured results.
- **Tools:**
  - `notion_search(query, page_size?)` → `POST /v1/search`
  - `notion_fetch_page(page_id)` → `GET /v1/pages/{id}` + `GET /v1/blocks/{id}/children` (page body)
  - `notion_query_database(database_id, page_size?)` → `POST /v1/databases/{id}/query`
- **Auth:** `Authorization: Bearer <token>`, `Notion-Version: 2022-06-28`. Token read at runtime from
  Secrets Manager `ops/awsops-v2/integrations/notion` (cached per warm container). Secret schema:
  `{"token":"secret_xxx"}` (also accept a raw string).
- **Handler contract:** mirror the existing MCP Lambda contract exactly (`flowmonitor.py` /
  `network_mcp.py`) — gateway event carries the tool name + arguments; dispatch on tool name.
  `cross_account.py` is bundled by the `archive_file` but unused by Notion (harmless).
- **Page size cap:** clamp `page_size` to a safe ceiling (e.g. ≤ 25) to bound response size.
- **Dependencies:** stdlib `urllib`/`json` + `boto3` (Secrets Manager). No third-party HTTP lib
  (matches the no-extra-deps zip-packaging constraint).

### (b) `terraform/foundation/ai.tf`
- Add `"notion-mcp"` to `local.agent_lambdas`, **gated on `integrations_enabled`** (not just
  `agentcore_enabled`):
  `merge(<base map>, var.integrations_enabled ? { "notion-mcp" = { file = "notion_mcp.py", handler = "notion_mcp.lambda_handler" } } : {})`
- `aws_secretsmanager_secret "notion"` (`count = local.integ_count`,
  `name = "ops/${var.project}/integrations/notion"`). Value injected out-of-band by admin (never in TF).
- Grant the shared `agent_lambda` exec role `secretsmanager:GetSecretValue` scoped to the notion
  secret ARN (`count = local.integ_count`).
- `output "agentcore".lambda_arns` auto-includes `notion-mcp` (map comprehension) when present.

### (c) `scripts/v2/agentcore/catalog.py`
- Add `TARGETS["notion-mcp-target"] = { "gateway": "external-obs", "lambda_key": "notion-mcp",
  "description": ..., "tools": [<3 inputSchema specs>] }`.
- Broaden the `external-obs` description to `"External Observability & Integrations (Notion now;
  Prometheus/Loki next)"`.
- `provision.py` needs **no change** (idempotent; `ensure_targets` gracefully skips a target whose
  `lambda_key` is absent when `integrations_enabled=false`).

### (d) Admin gate open — parallel, decoupled deliverable
- `aws ssm put-parameter --name /ops/awsops-v2/admin_emails --value "ojs0106@gmail.com" --overwrite`
  (or create a Cognito `admins` group and add the user). `web/lib/admin.ts` `isAdmin()` = Cognito
  group OR SSM email.
- **Security-sensitive + shared prod** → present the exact command; the user runs it via `!`
  (the auto-mode classifier blocks agent-run apply/SSM-write on shared prod infra).
- Not on the critical path for the Notion tool — it is for future integration-management UX.

## Error Handling
- Missing/invalid token → Lambda returns a structured tool error (no crash).
- Notion API 4xx/5xx → surfaced as a tool error; the agent explains it to the user.
- Read-only → no DLP/redaction needed (DLP is egress-write only).

## Testing
- **Python unittest** (`agent/lambda/test_notion_mcp.py` or co-located): tool dispatch, request URL/
  method/headers, `page_size` clamp, error mapping. Mock the Notion HTTP calls + Secrets Manager
  (stub-import pattern used by the existing lambda tests).
- **Terraform** `fmt` + `validate` (the worktree cannot full-plan — `.build` layers absent; the
  0-destroy guarantee is verified by the controller at apply time).
- **Live positive-path:** inject a real Notion token into the secret → `terraform -target` apply
  (Lambda + secret + IAM) → `make agentcore` (arm64 image + provision external-obs target) → open
  admin gate → chat: "search my Notion for X" → confirm a real call in CloudWatch logs (use a
  **unique** `runtimeSessionId` per invocation; WARNING/ERROR are the decisive signal — warm
  containers pin to old images on a reused sessionId).

## Deployment / Flag
- `integrations_enabled = true` in **both** the worktree `terraform.tfvars` **and** the LIVE
  source-of-truth `scripts/v2/configure.mjs` (so a later full apply does not destroy the
  secret/IAM/Lambda — prior learning).
- `terraform -target` apply for Lambda + secret + IAM (shared infra → controller/user runs it).
- `make agentcore` to build/push the arm64 agent image and provision the external-obs target.

## Scope / YAGNI
- One connector (Notion), three read tools. No write, no management UI.
- Prometheus/Loki = next increment, identical pattern (`prometheus_mcp.py`, same catalog/ai.tf/
  external-obs wiring).

## ADR note
Read-only external **knowledge** tool → does not violate the high-risk reversal (mutation/autonomy/
BYO-MCP remain do-not-pursue). No new ADR strictly required; an optional ADR-039 addendum could
record the "external read integration via M1 gateway target" pattern. Out of scope for this spec.
