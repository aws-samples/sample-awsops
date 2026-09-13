<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: bc9915c2871b · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Lambda Module — Reviewer Context

Lambda functions + shared modules backing AgentCore Gateway MCP tools. Per-gateway tool
inventories live in `ai.tf`'s `local.agent_lambdas` and the Lambda source files themselves —
that's the source of truth for tool counts, not this doc.

## Rules
- Exact `query_inventory.resource_id` is CloudFront-only: validate before SQL, bind the ID,
  return at most one identity-only row, and disclose the projection plus validated ID.
  It uses existing sql_reader columns/grants without schema, permission or AWS mutation changes.
  Zero-row identity results explicitly disclose that synced-inventory absence is not AWS absence.
  Roll out Lambda before gateway schema; consumers must match projection and echoed ID or report unverified.
- Gateway Targets must use Python/boto3 — the AWS CLI has inlinePayload issues.
- Every **Lambda-backed** target requires `credentialProviderConfigurations: GATEWAY_IAM_ROLE`
  (not universal — live ADR-017 `mcpServer` targets use `API_KEY` instead).
- pg8000, not psycopg2, is this codebase's Lambda-compatible Postgres driver. The only live
  user in this module is the v1/dark `aws_istio_mcp.py` (Steampipe-backed, superseded); the
  current v2 pg8000 user is the flag-gated batch inventory sync,
  `scripts/v2/steampipe/sync_lambda.py` — a different module. `istio_read_mcp.py` (the v2
  replacement) uses neither pg8000 nor psycopg2 — stdlib-only.
- **Read-only is absolute in v2 — no exceptions.** Mutating v1 tools stay dark, replaced by
  describe-only v2 equivalents: `reachability.py` (writes a network-insights path) →
  `reachability_read_mcp.py`; `aws_core_mcp.py`'s `call_aws` (arbitrary-CLI mutation vector) →
  `core_helpers_mcp.py`; `aws_istio_mcp.py` (needs live Steampipe) → `istio_read_mcp.py`. Flag
  any new tool performing create/update/delete/run-arbitrary-command — it does not belong here.
  Do not promote a dark v1 tool into v2 wiring (`ai.tf`'s `local.agent_lambdas`).
- `create_targets.py` is **v1/dark** (8 gateways, no `external-obs`) — the live v2 provisioner
  is `scripts/v2/agentcore/{catalog,provision}.py` (9 gateways). Don't cite `create_targets.py`
  as the current provisioning path.
- Cross-account access goes through `cross_account.py` **only** — do not hand-roll AssumeRole in
  an individual tool Lambda.
- Never embed secrets, AWS account IDs, ARNs, or live domains in source.

## `execute_sql` — the read-only boundary is a DB role, not a lexical guard
- Credentials come from the dedicated least-privilege `awsops_sql_reader` secret, never the
  Aurora master secret. A caller-supplied `secret_arn` is ignored. Unset env fails closed.
- The role has **no privilege on any table/column in `public`** — data is exposed only through
  explicit-column, read-only views in a dedicated `sql_reader` schema (never `SELECT *`).
  Adding a column or view here is a security-relevant change requiring review; never grant
  anything to `public`.
- `execute_sql` is host-account AND single-cluster only — any other target fails closed (400).
- The agent Lambda's IAM role has no `GetSecretValue` on the master secret, so bypassing the
  lexical guard (`sql_readonly_guard.py`) only reaches an unprivileged session — the guard is
  defense-in-depth, not the boundary.
- The ClickHouse connector has no equivalent DB-role boundary yet — there the lexical guard is
  still the primary defense.

## Review checklist
1. Any new `execute_sql`/`inventory-read` capability must go through the `sql_reader` view
   layer, never a direct table grant in `public`.
2. New gateway/tool wiring goes through the v2 provisioner, not `create_targets.py`.
3. Don't try to make the lexical DANGER-string guard "exhaustive" — a function that executes a
   string argument is an unbounded class; the DB-role boundary is what actually matters.

## Known false-positives
- `create_targets.py` existing in the tree is fine (dark v1 code) — flag only if it's wired
  live again.
- The lexical guard missing some SQL construct is not itself a finding as long as the DB role's
  view-only grant boundary holds.
