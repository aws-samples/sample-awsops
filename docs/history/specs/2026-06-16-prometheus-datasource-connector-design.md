# Prometheus Datasource Connector (PromQL, read-only) — v1 family sibling #2

**Date:** 2026-06-16
**Branch:** `fix/v2-upgrade-snapshot-id` (worktree `gap-impl-wave1`)
**Status:** Design — approved by user direction (`/co-agent:consensus`, "Prometheus부터 하나씩 계속").
**Builds on:** `2026-06-16-clickhouse-datasource-connector-design.md` — reuses the shared
`agent/lambda/datasource_http.py` foundation (SSRF guard, auth, no-redirect HTTP, per-slug credential
load) and the multi-field Connectors UI. This is the **second** v1 datasource-family connector.

## Goal
A read-only Prometheus connector: an admin connects a Prometheus endpoint (+ optional auth) in the
Connectors UI; the connector Lambda runs **PromQL** instant/range queries via the HTTP query API and
returns the result. On the **monitoring** gateway (alongside CloudWatch logs + OpenSearch → one agent
correlates metrics and logs for incident triage).

## Why this is much simpler than ClickHouse (no SQL-style guard)
Prometheus `/api/v1/query[_range]` only **evaluates PromQL** — it is read-only by construction (the
query API cannot write, and PromQL cannot invoke server-side fetches / table-functions). So there is
**no `_assert_read_only` / table-function denylist** needed (unlike ClickHouse SQL). The only attack
surface is the **endpoint SSRF**, already handled by `datasource_http.assert_host_allowed` (always-block
metadata/loopback/...; private allowed) + endpoint validation on credential save. PromQL is passed as a
URL-encoded query parameter.

## Key decisions
- **Credential** stored under slug `prometheus` in the single secret: `{endpoint, username?, password?, token?}`.
  `datasource_http.auth_headers` already maps username/password→Basic, token→Bearer, none→no auth
  (Prometheus is often unauthenticated in-cluster).
- **Reachability:** Prometheus is almost always in-cluster → flag `prometheus_vpc_enabled` (default
  false) extends the dynamic `vpc_config` + the compound ENI gate, same pattern as
  opensearch/clickhouse. (A future cleanup could fold the three per-connector VPC flags into one
  list-valued var; out of scope here — keep per-flag for consistency.)
- **Secret IAM:** reuses the existing `agent_lambda_integrations_secret` GetSecretValue grant — no new IAM.
- **Live test:** likely none (no Prometheus instance) → code + tests; document live needs a reachable
  endpoint (+ `prometheus_vpc_enabled` for in-cluster) + the admin gate open.

## Architecture (data flow)
```
[Admin UI] Connectors → Prometheus card (endpoint + optional auth) → PUT /api/integrations/credential
   {slug:'prometheus', secret:{endpoint, …auth}}   (endpoint SSRF-validated on save)
[chat] monitoring gateway → prometheus-mcp Lambda → load_datasource('prometheus')
   → assert_host_allowed(endpoint) → GET <endpoint>/api/v1/query[_range]?query=…  (auth headers)
   → {status,data:{resultType,result}} → bounded rows → agent
```

## Components
### (a) `agent/lambda/prometheus_mcp.py` — read-only PromQL MCP Lambda (uses datasource_http)
- **Tools:**
  - `prometheus_query(query, time?)` → GET `/api/v1/query?query=<enc>&time=<ts>` (instant; default now).
  - `prometheus_query_range(query, start?, end?, step?)` → GET `/api/v1/query_range` (default last 1h,
    step 60s; `start`/`end` accept `1h`/`30m`/ISO/unix → unix seconds; clamp step ≥ 1s).
  - `prometheus_labels()` → GET `/api/v1/labels` (label-name discovery).
  - `prometheus_series(match)` → GET `/api/v1/series?match[]=<enc>` (series discovery; required `match`).
- PromQL + match passed via `urllib.parse.urlencode` (no manual string building). Parse the JSON
  envelope: `status!='success'` → structured error with `data.error`/`errorType`; else return
  `resultType` + a **bounded** result (cap series/samples, e.g. ≤ 100 series, truncate, surface a
  `truncated` flag — keep well under the 6 MB Lambda limit).
- Mirrors the MCP contract (`tool_name`+`arguments`, pop `target_account_id`, `ok`/`err`); uses
  `datasource_http.{load_datasource('prometheus'), assert_host_allowed, auth_headers, http_json}`.

### (b) `web/lib/integration-credentials.ts` + `web/app/customization/page.tsx`
- Add `prometheus` to `KNOWN_CONNECTOR_SLUGS`. Add a `CONNECTORS` entry with fields
  `endpoint` + optional `username`/`password`/`token` (secret fields masked). Endpoint SSRF-validated
  on save by the existing `assertDatasourceEndpointAllowed` path (no route change — it already fires
  for any slug whose `secret.endpoint` is set).

### (c) `scripts/v2/agentcore/catalog.py`
- `TARGETS["prometheus-mcp-target"]` → gateway `monitoring`, 4 tools.

### (d) `terraform/foundation/ai.tf`
- Add `"prometheus-mcp"` to `local.agent_lambdas` **integ_count branch** (reads the secret) + its
  `INTEGRATIONS_SECRET_NAME` env. Add var `prometheus_vpc_enabled` (default false); extend the dynamic
  `vpc_config` condition and the `agent_lambda_vpc_eni` compound count to include `prometheus-mcp`.
  No new IAM.

## Error handling
- Not connected / missing endpoint → "prometheus not connected".
- SSRF block → "endpoint blocked".
- `status != success` → structured error (`errorType: error`); HTTP 4xx/5xx → structured error.
- Empty/no-data result → ok with an empty result + a note.

## Testing
- `agent/lambda/test_prometheus_mcp.py`: instant vs range URL/params (query URL-encoded, time/start/end/
  step defaults + relative-window parsing); labels/series; `status!=success` → error; not-connected →
  error; SSRF block → error; `target_account_id` popped; result truncation.
- `web/lib/integration-credentials.test.ts`: `prometheus` slug allowed + multi-field store/merge.
- TF `fmt` + `validate` (flag off & on). Full web vitest green.

## Scope / YAGNI
- One datasource (Prometheus), 4 read tools. No NL→PromQL generation, no recording-rule/alert writes,
  no exemplars. Loki/Tempo/Mimir are the next siblings (Mimir is Prometheus-API-compatible → will
  largely reuse this connector's query logic).

## ADR note
External read-only metrics datasource (ADR-011 lineage). Read-only by construction; SSRF handled by the
shared guard. No mutation/autonomy. (ADR numbering per `docs/decisions/CLAUDE.md`.)
