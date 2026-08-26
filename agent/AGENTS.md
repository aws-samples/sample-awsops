<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 15e2078b4d9e · generated-at: 2026-06-18 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are Codex, an external reviewer — project context below.

# Agent Module (`agent/`)

## What this is
A Strands Agent for AgentCore Runtime. It connects to role-based **section gateways** over the MCP protocol and is a v2 asset (reused by `web/` + `terraform/`, not the v1 `src/` monolith). This is a **read-only diagnostic** module: tools query AWS/observability state; no AWS-resource mutation or autonomous action belongs here.

## Layout / boundaries
- `agent.py` — main entrypoint. Picks the gateway dynamically from the `payload.gateway` parameter against a `GATEWAYS` dict. Role-specific system prompts (network/container/iac/data/security/monitoring/cost/ops).
- `streamable_http_sigv4.py` — MCP StreamableHTTP transport with AWS SigV4 signing. Keep signing concerns here, not in `agent.py`.
- `lambda/` — MCP tool Lambda sources (one function per logical tool group) plus the target-creation script. Tool logic lives in the Lambda sources; the agent only routes/orchestrates.
- `Dockerfile` / `requirements.txt` — Python 3.11-slim, **arm64**, strands-agents + boto3 + bedrock-agentcore + psycopg2-binary.

## Gateways & routing (what a reviewer should sanity-check)
- 8 section gateways: network, container, iac, data, security, monitoring, cost, ops. Tool counts per gateway are documented in CLAUDE.md; flag drift between the table and the actual Lambda set.
- The router classifier returns 1–3 routes; multiple gateways may be called in parallel and their results synthesized. Responses stream via SSE. Routes also cover Code Interpreter (`code`), external datasources (`datasource`), Steampipe inventory (`aws-data`), and a Bedrock `general` fallback.

## Conventions / banned patterns to enforce in review
- **arm64 is mandatory** for the image (`docker buildx --platform linux/arm64`). Reject x86 builds.
- Gateway URLs must be selected dynamically from the `GATEWAYS` dict via payload — no hardcoded per-call URLs.
- System prompts are role-specific; a change to one role's prompt should not silently affect others.
- **Fallback contract:** if the MCP connection fails, the agent runs without tools (direct Bedrock call). Don't let a tool/connection failure hard-error the whole invocation.
- Never embed secrets, AWS account IDs, ARNs, or live domains in source — they belong in SSM/Secrets Manager and runtime env.
- Keep cross-account assume logic correct: targeting the host account must not force a target-account-only role self-assume (that path mis-reports as a cross-account block).
