# Lambda Module

## Role
Lambda functions + shared modules for AgentCore Gateway MCP tools. +3 v2 read-only sources
added 2026-06-18: `core_helpers` / `reachability_read` / `istio_read` — see the per-gateway
lists below.

## Key Files
- `create_targets.py` — **v1/dark**: an older, hand-written Gateway Target creator (8 gateways,
  no `external-obs`). The live v2 provisioner is `scripts/v2/agentcore/{catalog,provision}.py`
  (9 gateways) — read those, not this file, for the current provisioning path.
- `cross_account.py` — Cross-account STS AssumeRole helper (50-minute credential cache,
  ExternalId, audit logging).

Per-gateway tool inventories (which Lambda backs which tool, dark-in-v2 markers, EKS Access
Entry requirements) are catalogued in `ai.tf`'s `local.agent_lambdas` and the Lambda source
files themselves — read those rather than this file for current tool counts.

**`execute_sql`'s read-only guarantee rests on DB-level role permissions**, not a lexical
guard — see the section below.

## Rules
- Gateway Targets: must use Python/boto3 — the CLI has inlinePayload issues.
- `credentialProviderConfigurations: GATEWAY_IAM_ROLE` is required on every **Lambda-backed**
  target. (Not universal: the live ADR-017 `mcpServer` targets — datadog/dynatrace/newrelic in
  `catalog.py`'s `MCP_SERVER_TARGETS` — use `API_KEY` credential providers instead.)
- pg8000, not psycopg2, is the Lambda-compatible Postgres driver in this codebase. Within this
  module the only live user is the v1/dark `aws_istio_mcp.py` (Steampipe-backed, superseded).
  The current v2 pg8000 user is the flag-gated batch inventory sync,
  `scripts/v2/steampipe/sync_lambda.py` (D1, `steampipe_enabled`) — a different module, not an
  AgentCore Gateway tool. `istio_read_mcp.py` (the live v2 replacement for `aws_istio_mcp.py`)
  uses neither pg8000 nor psycopg2 — stdlib-only (urllib + ssl) against the EKS k8s API, no
  Steampipe/third-party k8s client at all (`test_istio_read_mcp.py` asserts this).
- **Read-only is absolute in v2 — no exceptions.** Any tool that mutates AWS state must not be
  reachable. Mutating v1 tools stay dark, replaced by describe-only v2 equivalents:
  - `reachability.py` (creates a network-insights path = write) → `reachability_read_mcp.py`
    (describe-only, computed connectivity, static SG/NACL/route).
  - `aws_core_mcp.py`'s `call_aws` (arbitrary CLI = a mutation vector) → `core_helpers_mcp.py`
    (`prompt_understanding`/`suggest_aws_commands` only — no `call_aws`).
  - `aws_istio_mcp.py` (needs live Steampipe) → `istio_read_mcp.py` (Istio CRDs via the EKS k8s
    API, presigned-STS token, stdlib urllib/ssl).
  - **Flag any new tool that performs create/update/delete/run-arbitrary-command** — it does
    not belong here. **Do not promote a dark v1 tool into v2 wiring** (i.e. into `ai.tf`'s
    `local.agent_lambdas`).
- Cross-account access goes through `cross_account.py` **only** (STS AssumeRole, ~50-min
  credential cache, ExternalId, audit logging) — do not hand-roll AssumeRole in an individual
  tool Lambda.
- Never embed secrets, AWS account IDs, ARNs, or live domains in source — they belong in
  SSM/Secrets Manager and runtime env.
- Tool schema format: `inlinePayload: [{name, description, inputSchema: {type, properties, required}}]`.

## `execute_sql` — the read-only boundary is a DB role

**TL;DR: the lexical guard (`sql_readonly_guard.py`) is defense-in-depth, NOT the boundary.**

- `aws_rds_mcp.py`'s `execute_sql` and `inventory_read_mcp.py` connect to the app's own Aurora
  via the RDS Data API. The credential is **not the Aurora master secret** but the dedicated
  least-privilege role's **`awsops_sql_reader`** secret (`AURORA_SQL_READER_SECRET_ARN` /
  `AURORA_SECRET_ARN` env, injected by `ai.tf`). A caller-supplied `secret_arn` argument is
  **ignored** and has been removed from the tool schema — credential selection is a server
  config, not a model input. An unset env **fails closed** (never falls back to a higher
  privilege).
- Role privileges: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  `CONNECT`(awsops) + `USAGE`(**`sql_reader`**) + **`SELECT` on that schema's views only**,
  `default_transaction_read_only=on`, zero EXECUTE grants to this role, zero predefined-role
  memberships.
- **Round 10 pivot — table allowlist → view-only grant. The default was inverted.** This role
  has **no privilege on any table/column in `public`**. Data is exposed only through read-only
  views in the dedicated `sql_reader` schema, and each view lists **explicit columns**
  (`SELECT *` is forbidden).
  - Why: round 8's blanket grant missed `eks_registrations.auth` (a k8s bearer token), and
    round 9's ~38-**table** allowlist missed `worker_jobs.task_token` — that isn't data, it's a
    **capability** (holding a Step Functions task token lets you `SendTaskSuccess/Failure` on a
    running workflow). A table-level allowlist **fails open per column**, so the same failure
    recurred.
  - **JSONB blobs are exposed only through named-key projections** (`inventory_resources.data`,
    `topology_nodes.meta`). Putting raw JSONB in the column list **fails open again, per JSON
    key** — `data` carries CloudFront origin CustomHeaders (an origin secret), and `meta.row`
    carries a full raw copy of the row. Conversely, simply **dropping the column breaks the
    connector at runtime** (PR #197 review CRITICAL — wiped out `find_unused_resources`/
    `query_inventory`/`get_topology`). So it's allowlist projection, and the `data` allowlist
    must be a superset of `inventory_read_mcp.PROJECTIONS` —
    `agent/lambda/test_inventory_view_contract.py` fails the build on drift.
  - Effect: a new base-table column is **invisible** until someone adds it to a view (silently
    absent instead of silently exposed — the right direction for a model-invocable tool).
  - `search_path = sql_reader, pg_catalog` → an unqualified `FROM worker_jobs` written by the
    model resolves to the view. Writing `public.worker_jobs` explicitly is **denied** (no
    grant). `search_path` and `default_transaction_read_only` are convenience only — the role
    can change them itself — the actual boundary is the **grant**.
  - Mechanism: the view owner is the migration role (master user) and `security_invoker = false`
    (the default), so the view body runs with the **owner's** privileges → a role with zero
    base-table privileges can still read the view.
  - **Adding a column or a view here is a security-relevant change and must be reviewed.** Never
    grant anything to `public`.
  → `terraform/foundation/migrations/01KYVY9J2E8AMF35WR4J7036A3_agent_sql_reader_role.sql`
- Because the credential is scoped to the host account + a **single cluster**, `execute_sql`
  has **no cross-account support** (a different-account target fails closed with 400), and even
  within the same account it fails closed with 400 if the target isn't the foundation cluster
  (`AURORA_CLUSTER_ARN` comparison — round 10 MAJOR: previously an unhandled Data API exception
  surfaced as an unhandled 500 with a stack trace). The rest of the rds-mcp tools' cross-account
  path is unchanged.
- The agent Lambda's IAM role has **no** `GetSecretValue` on the master secret
  (`ai.tf`'s `agent_lambda_inventory`) — bypassing the lexical guard only reaches an
  unprivileged session.
- **Why this design**: PR #197 review rounds 3–7 found a new bypass every round. The root cause
  is a class a denylist can't enumerate — a core function that takes SQL as a *string argument*
  and executes it (`query_to_xml('SELECT pg_cancel_backend(...)')`) is invisible to a guard that
  strips string literals before matching, and `SET TRANSACTION READ ONLY` only blocks data
  writes while still allowing control-plane calls.
- **So do not try to "complete" this by adding more DANGER entries to these files.** A new
  lexical hole isn't privilege escalation (the ClickHouse connector has no DB-role boundary yet,
  so there the guard is still the primary defense — a backslash-escape hardening idea for it is
  noted as a follow-up, out of scope here).

Detail: ADR-004 §7 amendment (2026-07-31).
