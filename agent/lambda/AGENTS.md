<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 5ed83183ba09 · generated-at: 2026-09-15 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

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
- SQL-reader `topology_nodes.meta` is a named-key allowlist, currently owned by
  `01M27B0000C6QWJ50NRJ8YAH9D_trace_queue_claim_provenance.sql`. Materialized flow target nodes
  carry ownership_evidence/targetCapturedAt and applicable VPC/subnet/ambiguity data, excluded
  by the view. Configuration-only IP targets also carry ownership_reason; other target kinds
  need not. The targetCapturedAt field dates only the target-group row, not ownership evidence.
  Candidate is page-only, not materializer output, and also excluded. Exposed
  region/cluster/ecsService/task fields are not complete
  scope or live-ownership proof. Host ECS snapshot target labels remain cached configuration.
  Unlisted keys need a reviewed additive migration to be exposed.
- Flow/infra labels are cached configuration, not live ownership. Trace account/region or
  Kubernetes metadata, when present, is telemetry attribution; database `infra_ref` is a
  host-name/prefix inference. Trace queues explicitly use `identityProvenance='telemetry_claim'`
  and nullable destination-ARN claims, never verified AWS ownership. Missing fields prove nothing.
- Node `captured_at` is materialization time, not inventory/event time. Use
  `sql_reader.topology_graph_state` for trace status/window/retained evidence; its current
  writer supplies trace only, not flow/infra coverage.
- `test_inventory_view_contract.py` reads the original reader-role migration for topology
  assertions, not the current projection owner. Do not claim it enforces that owner; inspect
  the current migration and `scripts/v2/workers/test_graph_collection.py` separately.
- `execute_sql` is host-account AND single-cluster only — any other target fails closed (400).
- The agent Lambda's IAM role has no `GetSecretValue` on the master secret, so bypassing the
  lexical guard (`sql_readonly_guard.py`) only reaches an unprivileged session — the guard is
  defense-in-depth, not the boundary.
- The ClickHouse connector has no equivalent DB-role boundary yet — there the lexical guard is
  still the primary defense.

## External query completion
- Producers compute `collectionStatus`; only validated complete ok/empty certifies an empty query result.
  Tempo uses synchronous HTTP 200 proof with negative-signal vetoes, not mandatory job counters.
  A byte-omitted child is partial; an all-empty partial attempt retains the saved graph.
- Prometheus/Mimir scalar/string results are explicitly unsupported; malformed records use
  fixed markers, never raw passthrough. Output byte limits remain enforced.
- Run the three completion suites in `agent/lambda/CLAUDE.md`. Shared fixtures bind actual
  mocked HTTP outputs to web adapters and PostgreSQL publication/retention tests. Lambda code
  and Gateway descriptions require separate deployment steps; no source merge activates them.

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

## ENI configuration evidence

`get_eni_details` reports configuration, not connectivity. Missing or malformed `Groups`,
`IpPermissions`, `IpPermissionsEgress`, `Entries` or `Routes` is partial evidence, with the
affected resource and field in `unknown`. Actual empty lists remain distinct. Per-group
completeness includes both rule lists and their peers; preserve other returned evidence.

Require established route-association state and sanitized codes for every component read.
SG output is bounded to 200 peer rows per group with explicit metadata and 100-character
descriptions; truncation is partial evidence. Validate the ENI test suite, then deploy
Lambda, AgentCore prompt and live Gateway catalog through the existing operator flow.
