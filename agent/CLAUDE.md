# Agent Module

## Role
Strands Agent for AgentCore Runtime. Connects to 9 domain gateways via MCP protocol.

## Key Files
- `agent.py` — Main entrypoint: dynamic Gateway selection via the `payload.gateway` parameter;
  `_resolve_gateway_key`/`_GATEWAY_ALIAS` handle the `observability`→`external-obs` chat-key
  alias and the canonical-vs-`v2-`-prefixed key coexistence shim (see the do-not-"fix" note in
  root `AGENTS.md`).
- `streamable_http_sigv4.py` — MCP StreamableHTTP with AWS SigV4 signing
- `Dockerfile` — Python 3.11-slim, arm64, port 8080
- `requirements.txt` — strands-agents, boto3, bedrock-agentcore, psycopg2-binary
- `lambda/` — Lambda source files (see `agent/lambda/CLAUDE.md` for the current provisioner and
  tool-inventory sources)

## Gateways and routes — don't hand-count them here
The gateway count, per-gateway tool counts, and the chat routing-key list have drifted stale in
this file before (9 domain gateways incl. `external-obs`; 16 chat-section keys). Rather than
re-introduce a hand-maintained table that goes stale again, read the actual source:
- Gateway/tool inventory: `scripts/v2/agentcore/catalog.py` (the live v2 provisioner catalog)
  and `ai.tf`'s `local.agent_lambdas`.
- Chat routing keys: `web/lib/route.ts`'s `RULES` (regex fast-path, first-match-wins) — the
  `observability` key aliases to the `external-obs` gateway per ADR-004.
- Root `CLAUDE.md`'s "AI (AgentCore)" bullet has the current-truth summary of both.

## Multi-Route Support
- The classifier can return 1–3 candidate routes, but actually fanning out to multiple
  gateways and synthesizing their answers requires **two independent Terraform flags, both
  default false, ANDed at runtime** (`web/app/api/chat/route.ts`'s
  `doFanout = synthOn && hybridOn && ...`) — both governed by the same consolidated
  **ADR-003** (current numbering; the two flags trace to different legacy pre-consolidation
  ADRs, `[legacy 038]` for hybrid classifier routing and `[legacy 044]` for the cross-domain
  merge step, but neither is a separate live ADR today): `hybrid_routing_enabled` (sets
  `HYBRID_ROUTING_ENABLED`) and `multi_route_synthesis_enabled` (the cross-domain merge step,
  its own IAM `bedrock:InvokeModel` grant; sets `MULTI_ROUTE_SYNTHESIS_ENABLED`). Neither flag
  implies the other — don't assume parallel gateway calls + synthesis run unconditionally, and
  don't collapse these into a single flag.
- Real-time response delivery via SSE streaming.

## Rules
- Docker image must be arm64 (`docker buildx --platform linux/arm64`).
- Gateway URL is selected dynamically from the `GATEWAYS` dict based on the payload.
- The system prompt is role-specific, one per domain gateway.
- Fallback: if the MCP connection fails, run without tools — direct Bedrock call.
- Never embed secrets, AWS account IDs, ARNs, or live domains in source — they belong in
  SSM/Secrets Manager and runtime env.
