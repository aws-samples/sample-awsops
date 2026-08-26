# Plan: Notion read connector — first concrete integration (Lambda→API MCP)

> Spec: `docs/superpowers/specs/2026-06-14-notion-read-connector-design.md`. First end-to-end
> concrete connector on the **M1 gateway-target** pattern (the `aws_*_mcp` pattern), NOT the M2
> egress path. Read-only Notion MCP tool on the **external-obs** gateway, flag-gated by
> `integrations_enabled`. Prometheus/Loki are the next increment on the identical pattern.
> Branch `fix/v2-upgrade-snapshot-id` (worktree `gap-impl-wave1`).

## Goal
A chat user selecting the `external-obs` gateway can ask the agent to search / fetch Notion
content; the agent calls read-only Notion MCP tools backed by a Lambda that hits the Notion REST
API with a Secrets-Manager token. No writes, no egress (M2), no public Function URL.

## Critical design points (carried from the spec)
- **Read-only only.** Three tools: `notion_search`, `notion_fetch_page`, `notion_query_database`.
  No mutation (consistent with the 2026-06-11 high-risk reversal — read-only ops + AI diagnosis).
- **Flag = `integrations_enabled`** (already default-`true` in worktree tfvars + emitted by
  `configure.mjs`; the TF local `integ_count = agentcore_enabled && integrations_enabled`). When
  off → the Lambda/secret/IAM don't exist and `provision.py` gracefully skips the target.
- **No VPC attach** on the Notion Lambda (matches all `agent_lambdas`) → it has internet egress to
  reach `api.notion.com`. The token is read at runtime from Secrets Manager (never in TF/env).
- **Handler contract** mirrors `agent/lambda/network_mcp.py`: event carries `tool_name` +
  `arguments`; dispatch on tool name; return via an `ok()`/`err()`-style helper (mirror that file's
  response shape). `cross_account.py` is bundled by `archive_file` but unused (harmless).
- **Admin gate** is opened in PARALLEL (a live SSM write the user runs via `!`), DECOUPLED from this
  tool — the Notion tool works without it; the admin gate is for the future integration-management
  UX. Not an autonomous code task.

## Non-goals (this increment)
- Other connectors (Prometheus/Loki/ClickHouse/Tempo/Datadog) — later increments, same pattern.
- Any write/mutation tool; any DLP (DLP is egress-write only).
- Aurora `integrations` row dependency for the tool to function (static M1 wiring + flag only).
- Integration-management UI.

## P2 consensus gate — round 1 findings & resolutions (panel: kiro/opus-4.8, kiro/kimi-k2.5; codex timed out, agy/glm did not deliver)
- **CRITICAL — provision.py is NOT skip-when-absent (verified at `scripts/v2/agentcore/provision.py:117-120,285`).** `ensure_targets` logs `ERR` and `main()` does `sys.exit(1 if errs else 0)` when `lambda_key not in lambda_arns`. The spec/old-plan "graceful skip / no provision.py change" claim was FALSE → a flag-off config would fail `make agentcore`. **Resolution: new Task 4 patches `ensure_targets` to log `SKIP` (not `ERR`) when the Lambda is absent — degrade-safe for all targets.**
- **CRITICAL — Secrets grant must be on the `agent_lambda` exec role, not the `agentcore` runtime role** (the existing `aws_iam_role_policy.agentcore_integrations` is on the runtime role only). **Resolution: Task 3 adds a NEW `aws_iam_role_policy.agent_lambda_notion_secret` (count=integ_count) granting only `secretsmanager:GetSecretValue` on the notion secret ARN to `aws_iam_role.agent_lambda[0]`.**
- **MAJOR — `notion_fetch_page` block-children fetch is unbounded** (`/v1/blocks/{id}/children` returns up to 100 with `has_more`). **Resolution: Task 1 passes `page_size` on the children call, does NOT auto-follow `has_more`, and truncates — bounded payload (Lambda hard limit 6 MB).**
- **MAJOR/resolved — gating.** Keep Lambda+secret+IAM ALL gated on `local.integ_count` (= `agentcore_enabled && integrations_enabled`) as ONE unit (all-present or all-absent — never a tool without its credentials). `integ_count` requires `agentcore_enabled` so `agent_lambda[0]`/`integrations[0]` indices are safe (no index error). The "target without Lambda" risk is closed by the Task 4 SKIP fix. (`integrations_enabled` = "external integrations enabled" — Notion is an external integration even though its mechanism is M1, not M2 egress.)
- **MAJOR/resolved — KMS.** The notion secret uses the **default `aws/secretsmanager` key (NO custom CMK)** → `GetSecretValue` needs no `kms:Decrypt` grant on the lambda role.
- **MINOR — `target_account_id`.** `provision._inject_account` adds `target_account_id` to every tool's `inputSchema`, so the gateway may put it in `arguments`. **Resolution: Task 1 handler pops `target_account_id` (like `network_mcp.py`) + a test asserts it is ignored.**
- **MINOR — catalog_check.** It only prints `lambda_keys` (does not read ai.tf). Task 2 wording corrected; the lambda_key↔ai.tf match is exercised by live provision (now SKIP-safe).

## Tasks (TDD; per-task commit; `python3 -m unittest` + catalog_check + `terraform validate` green each task)

### Task 1: Notion read MCP Lambda (TDD)
**Files:**
- Create: `agent/lambda/notion_mcp.py`
- Test: `agent/lambda/test_notion_mcp.py`
- [ ] Failing tests (mirror `agent/lambda/test_cross_account.py` stub-import style; mock `urllib`
  HTTP + `boto3` Secrets Manager — NO network, NO real boto3 calls):
  - `notion_search`: builds `POST https://api.notion.com/v1/search` with body `{"query":...,"page_size":<clamped>}`, headers `Authorization: Bearer <token>` + `Notion-Version: 2022-06-28` + `Content-Type: application/json`; returns `ok` with the parsed results.
  - `notion_fetch_page`: `GET /v1/pages/{page_id}` then `GET /v1/blocks/{page_id}/children`; merges page + blocks into the result.
  - `notion_query_database`: `POST /v1/databases/{database_id}/query` with clamped `page_size`.
  - `page_size` clamp: a request with `page_size=500` is sent as ≤ 25 (safe ceiling); missing → default (e.g. 10).
  - Missing/blank token (Secrets Manager returns empty / raises) → structured error (no exception escapes the handler).
  - Notion API non-2xx (e.g. 401/404/429) → structured tool error carrying the status + Notion message (no crash).
  - Dispatch: `tool_name` routes to the right function; unknown `tool_name` → structured error.
  - Token secret schema: accepts `{"token":"secret_x"}` JSON AND a raw string; cached per warm container (second call does not re-fetch — assert the SM client is called once).
  - **`target_account_id` ignored:** `arguments` carrying `target_account_id` (provision injects it into every tool's inputSchema) is popped and ignored — the handler does NOT choke and makes no cross-account call (Notion is account-agnostic).
  - **`notion_fetch_page` bounded:** the `/v1/blocks/{id}/children` call passes `page_size` and does NOT auto-follow `has_more`; the merged result is truncated to a safe ceiling (assert a page with >ceiling blocks is truncated, `has_more`/`truncated` surfaced).
- [ ] Implement `agent/lambda/notion_mcp.py`: `lambda_handler(event, context)` parsing
  `tool_name`/`arguments` like `network_mcp.py` (incl. `args.pop('target_account_id', None)`);
  `_get_token()` (Secrets Manager `ops/awsops-v2/integrations/notion`, env `NOTION_SECRET_NAME`
  overridable, module-cached); `_notion_request(method, path, body=None)` via stdlib
  `urllib.request` (timeout, JSON); `_clamp_page_size()` (accepts str|int, default 10, ceiling 25);
  the 3 tool functions (`notion_fetch_page` bounds children as above); `ok()`/`err()` helpers
  mirroring `network_mcp.py`. Stdlib + `boto3` only (no third-party HTTP lib — zip-packaging
  constraint). Total response stays well under the 6 MB Lambda limit.
- [ ] Run `cd agent/lambda && python3 -m unittest test_notion_mcp -v` → green.
- [ ] Commit: `feat(agent-platform): Notion read MCP Lambda — notion_search/fetch_page/query_database (read-only)`.

### Task 2: register the Notion target on the external-obs gateway
**Files:**
- Modify: `scripts/v2/agentcore/catalog.py`
- [ ] Add `TARGETS["notion-mcp-target"]` = `{gateway:"external-obs", lambda_key:"notion-mcp",
  description, tools:[3 specs]}` using the `_p(...)` helper:
  - `notion_search` — props `query` (string, required), `page_size` (string/int, optional)
  - `notion_fetch_page` — props `page_id` (string, required)
  - `notion_query_database` — props `database_id` (string, required), `page_size` optional
  - NO `target_account_id` prop (provision.py injects; catalog_check forbids it).
- [ ] Broaden the `external-obs` GATEWAYS description to
  `"External Observability & Integrations (Notion now; Prometheus/Loki next)"`.
- [ ] Run `cd scripts/v2/agentcore && python3 catalog_check.py` → prints `OK` and lists
  `notion-mcp` among the lambda_keys. (catalog_check validates intra-catalog invariants only; the
  lambda_key↔ai.tf match is exercised at live provision — now SKIP-safe via Task 4.)
- [ ] Commit: `feat(agent-platform): register notion-mcp-target on external-obs gateway`.

### Task 3: provision the Notion Lambda + secret + IAM (flag-gated, one unit)
**Files:**
- Modify: `terraform/foundation/ai.tf`
- [ ] Restructure `local.agent_lambdas` to `merge(<existing agentcore_enabled ? {...} : {}>,
  local.integ_count > 0 ? { "notion-mcp" = { file = "notion_mcp.py", handler =
  "notion_mcp.lambda_handler" } } : {})` — Lambda exists only when `agentcore_enabled &&
  integrations_enabled`. `integ_count` requires `agentcore_enabled`, so `agent_lambda[0]` is safe
  (no index error). `lambda_arns` output auto-includes it.
- [ ] Add `aws_secretsmanager_secret "notion"` (`count = local.integ_count`,
  `name = "ops/${var.project}/integrations/notion"`). **Use the DEFAULT `aws/secretsmanager` key —
  NO custom `kms_key_id`** (so `GetSecretValue` needs no `kms:Decrypt` grant). Value injected
  out-of-band — NO `aws_secretsmanager_secret_version` with a literal token.
- [ ] Add a NEW `aws_iam_role_policy "agent_lambda_notion_secret"` (`count = local.integ_count`,
  role = `aws_iam_role.agent_lambda[0].id`) granting ONLY `secretsmanager:GetSecretValue` on
  `aws_secretsmanager_secret.notion[0].arn` (exact ARN, not a prefix wildcard). No `0.0.0.0/0`, no
  `Principal:"*"`. (The existing `agentcore_integrations` policy is on the runtime role, NOT this
  lambda role — must add a separate one.)
- [ ] Run `terraform -chdir=terraform/foundation fmt` and
  `terraform -chdir=terraform/foundation validate` → green. (Full `plan` is not possible in the
  worktree — `.build` Lambda-layer artifacts are absent; the 0-destroy guarantee is verified by the
  controller at apply time, NOT here.)
- [ ] Commit: `feat(agent-platform): provision notion-mcp Lambda + secret(default-key) + scoped IAM (integ-gated)`.

### Task 4: make provision.py skip an absent-Lambda target (degrade-safe)
**Files:**
- Modify: `scripts/v2/agentcore/provision.py`
- Test: `scripts/v2/agentcore/test_provision_skip.py`
- [ ] Failing test (stub the controller/boto3): a `TARGETS` entry whose `lambda_key` is NOT in
  `ac["lambda_arns"]` is recorded as `SKIP` (not `ERR`), so `main()`'s `errs` stays empty and the
  exit code is 0 — `make agentcore` does not fail when `integrations_enabled=false`.
- [ ] Implement: in `ensure_targets`, when `not lambda_arn`, `log(f"target:{tname}", "SKIP",
  f"lambda {spec['lambda_key']} not in tf output (flag off?)")` then `continue` (was `ERR`). No
  other behavior change; a genuine gateway/create error stays `ERR`.
- [ ] Run `cd scripts/v2/agentcore && python3 -m unittest test_provision_skip -v` → green.
- [ ] Commit: `fix(agentcore): provision skips absent-Lambda target (SKIP not ERR) — degrade-safe`.

## Manual / live steps (NOT autonomous — controller/user runs; documented for completeness)
1. Create/seed the secret value (real Notion integration token, shared with the target pages):
   `aws secretsmanager put-secret-value --secret-id ops/awsops-v2/integrations/notion --secret-string '{"token":"secret_xxx"}'`
2. Open the admin gate (parallel, decoupled — security-sensitive, user runs via `!`):
   `aws ssm put-parameter --name /ops/awsops-v2/admin_emails --value "ojs0106@gmail.com" --overwrite`
3. `terraform -target` apply for the Lambda + secret + IAM (shared infra → controller/user).
4. `make agentcore` — build/push arm64 agent image + idempotent provision of the external-obs target.
5. Live positive-path: chat (external-obs) "search my Notion for X" → confirm a real call in
   CloudWatch logs with a **unique** `runtimeSessionId` per invocation (WARNING/ERROR are decisive;
   warm containers pin to old images on a reused sessionId).
6. Persist `integrations_enabled=true` in the LIVE source-of-truth (already in `configure.mjs` +
   tfvars — verify, no change expected) so a later full apply does not destroy the secret/IAM/Lambda.
