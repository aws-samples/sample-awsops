<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 1106da60a2a0 · generated-at: 2026-07-08 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Lambda Module (AgentCore MCP tools)

## What this is
Lambda functions (one per AWS service area) plus a shared `cross_account.py`. Each Lambda implements the MCP tools exposed by an AgentCore Gateway. Gateways are role-based: network, container, iac, data, security, monitoring, cost, ops (+ v2 adds `external-obs`). `create_targets.py` registers every Gateway Target via boto3.

## Architectural boundaries
- One Lambda ≈ one AWS service domain (VPC, EKS, IAM, CloudWatch, Cost Explorer, …). Keep service logic inside its own Lambda file; do not cross-wire tools between service files.
- Cross-account access goes through `cross_account.py` only (STS AssumeRole, credential caching ~50min, ExternalId, audit logging). Do not hand-roll AssumeRole in individual tool Lambdas.
- VPC-attached Lambdas (`steampipe-query`, Istio) reach Aurora/Steampipe over the network; non-VPC Lambdas use AWS SDK calls directly.

## Conventions a reviewer must enforce
- **Read-only is absolute in v2 — no exceptions.** Any tool that mutates AWS state must not be reachable in v2. Mutating v1 tools stay "dark", replaced by describe-only equivalents:
  - `reachability.py` (creates a network-insights path = write) → `reachability_read_mcp.py` (describe-only, computed connectivity, static SG/NACL/route).
  - `aws_core_mcp.py` `call_aws` (arbitrary CLI = mutation vector) → `core_helpers_mcp.py` (prompt_understanding + suggest_aws_commands only; no `call_aws`).
  - `aws_istio_mcp.py` (needs live Steampipe) → `istio_read_mcp.py` (Istio CRDs via EKS k8s API, presigned-STS token, stdlib urllib/ssl).
  - Flag any new tool performing create/update/delete/run-arbitrary-command — it does not belong here.
- **Gateway Targets must be created via Python/boto3** — the CLI has inlinePayload problems.
- **Every target requires `credentialProviderConfigurations: GATEWAY_IAM_ROLE`.**
- **VPC Lambdas use `pg8000`, not `psycopg2`** (steampipe-query, istio).
- Tool schema shape: `inlinePayload: [{name, description, inputSchema: {type, properties, required}}]`.

## v1 vs v2 scope
Reused from v1 (`src/`) into v2 (`web/`, `terraform/`). v2 tightens the contract: strictly read-only; `*_read_mcp.py` / `core_helpers_mcp.py` variants are the v2 path, originals stay dark. v2 is single-account by default — only the explicit `cross_account.py` path assumes a different account. Do not promote a dark v1 tool into v2 wiring.
