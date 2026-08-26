# Plan: Prometheus datasource connector (PromQL, read-only) — v1 family sibling #2

> Spec: `docs/superpowers/specs/2026-06-16-prometheus-datasource-connector-design.md`. Reuses the
> shared `agent/lambda/datasource_http.py` (SSRF/auth/no-redirect HTTP/credential load) + multi-field
> Connectors UI. PromQL is read-only by construction → NO SQL-style guard. monitoring gateway.
> Branch `fix/v2-upgrade-snapshot-id`.

## Grounding (verified)
- v1 `queryPrometheus` (src/lib/datasource-client.ts): instant `GET /api/v1/query?query=&time=`; range
  `GET /api/v1/query_range?query=&start=&end=&step=`; envelope `{status, data:{resultType, result}}`;
  `status!='success'` → error. Port to Python. Port 9090; placeholder `http://prometheus:9090`.
- `datasource_http` provides `load_datasource(slug)`, `assert_host_allowed(endpoint)`, `auth_headers(creds)`,
  `http_json(method,url,headers,body)` (no-redirect). `clickhouse_mcp.py` is the sibling template.
- Single integrations secret + `agent_lambda_integrations_secret` GetSecretValue grant already exist
  (no new IAM). `INTEGRATIONS_SECRET_NAME` env wired per integ-branch lambda. `clickhouse_vpc_enabled`
  + dynamic `vpc_config` + `agent_lambda_vpc_eni` compound gate is the VPC pattern to extend.
- Connectors UI: `CONNECTORS[].fields` schema + `KNOWN_CONNECTOR_SLUGS` (web/lib/integration-credentials.ts);
  endpoint SSRF-validated on save by `assertDatasourceEndpointAllowed` (fires for any slug with secret.endpoint).

## Non-goals
- Loki/Tempo/Mimir (next siblings). No NL→PromQL, no writes, no exemplars/recording rules.

## P2 consensus gate — round 1 findings & resolutions (panel: kiro opus-4.8 / kimi-k2.5 / glm-5)
- **MAJOR (opus, valid) — bound total SAMPLES, not just series count.** A `query_range` matrix can be
  ~100 series × ~11k points → tens of MB, blowing the 6 MB Lambda response limit even when series count
  is capped. **Resolution: Task 1 caps points-per-series AND a global sample budget (truncate `values[]`,
  set `truncated:true`); a test asserts a many-samples-per-series matrix is truncated under budget.**
- **kimi's three Task-4 "CRITICAL/MAJOR" (env list / ENI gate / vpc_config missing prometheus) — NOT
  defects:** these are exactly what Task 4 already prescribes to ADD (kimi read the current ai.tf, where
  prometheus isn't wired yet, and restated the plan's own steps). No plan change; Task 4 stands.
- glm: NO BLOCKING.

## Tasks (TDD; per-task commit; `python3 -m unittest` / vitest / catalog_check / `terraform validate` green)

### Task 1: Prometheus read-only MCP Lambda (TDD)
**Files:**
- Create: `agent/lambda/prometheus_mcp.py`
- Test: `agent/lambda/test_prometheus_mcp.py`
- [ ] Failing tests (mock `datasource_http.load_datasource` + `assert_host_allowed` + `urlopen`/`http_json`):
  - `prometheus_query('up', time='...')`: GET `<endpoint>/api/v1/query`; query string has `query=up`
    URL-ENCODED (test a query with spaces/`{}`/`=` e.g. `rate(http_requests_total{code="500"}[5m])`
    encodes correctly) + `time`; returns parsed `data.result`.
  - `prometheus_query_range('up', start='1h', step='60')`: GET `/api/v1/query_range` with `start/end/step`;
    default window last 1h + step 60 when omitted; relative `1h`/`30m` → unix seconds.
  - `prometheus_labels()` → GET `/api/v1/labels`; `prometheus_series(match='up')` → `/api/v1/series?match[]=up`
    (match URL-encoded; missing match → error).
  - envelope `status!='success'` → structured error carrying `data.error`/`errorType`.
  - not connected (load_datasource raises NotConnected) → structured error; SSRF block (assert_host_allowed
    raises) → "endpoint blocked"; HTTP 4xx/5xx → structured error.
  - `target_account_id` popped; result bounding: cap SERIES count AND points-per-series AND a global
    sample budget — a matrix with many samples-per-series is truncated (`values[]` trimmed) + `truncated:true`
    (test the many-samples case explicitly, not just the series-count case).
- [ ] Implement `agent/lambda/prometheus_mcp.py`: `lambda_handler` (mirror clickhouse dispatch);
  `load_datasource('prometheus')` → `assert_host_allowed(endpoint)` → build URL with
  `urllib.parse.urlencode` → `http_json('GET', url, headers=auth_headers(creds))`; `_parse_time`
  (now default / `1h`/`30m`/`2d` → now-delta unix / ISO / passthrough unix); 4 tools; `ok`/`err`;
  bound/truncate result. Stdlib + boto3 only (reuses datasource_http).
- [ ] `cd agent/lambda && python3 -m unittest test_prometheus_mcp` → green.
- [ ] Commit: `feat(agent-platform): Prometheus read-only MCP Lambda (PromQL instant/range/labels/series) on datasource_http`.

### Task 2: Connectors UI — prometheus slug + field schema
**Files:**
- Modify: `web/lib/integration-credentials.ts`
- Test: `web/lib/integration-credentials.test.ts`
- Modify: `web/app/customization/page.tsx`
- [ ] Add `prometheus` to `KNOWN_CONNECTOR_SLUGS`. Failing test: store/merge `{endpoint,token}` (or
  username/password) under `prometheus` (other slugs preserved).
- [ ] `page.tsx`: add a `CONNECTORS` entry `prometheus` with fields `endpoint` + optional `username`,
  `password` (secret), `token` (secret); help text ("http://prometheus:9090; auth optional"). Reuses
  the existing per-field render + save (endpoint SSRF-validated on save, no route change).
- [ ] `cd web && npx vitest run lib/integration-credentials.test.ts` → green; `npx tsc --noEmit` adds no
  new errors in changed files.
- [ ] Commit: `feat(integrations): Prometheus connector card (endpoint + optional auth) + slug`.

### Task 3: register the Prometheus target on the monitoring gateway
**Files:**
- Modify: `scripts/v2/agentcore/catalog.py`
- [ ] `TARGETS["prometheus-mcp-target"]` → `{gateway:"monitoring", lambda_key:"prometheus-mcp", tools:[4]}`:
  `prometheus_query` (req `query`; opt `time`), `prometheus_query_range` (req `query`; opt `start`/`end`/`step`),
  `prometheus_labels` (none), `prometheus_series` (req `match`).
- [ ] `cd scripts/v2/agentcore && python3 catalog_check.py` → `OK` + `prometheus-mcp` in lambda_keys.
- [ ] Commit: `feat(agent-platform): register prometheus-mcp-target on monitoring gateway`.

### Task 4: provision the Prometheus Lambda + prometheus_vpc_enabled flag (TF)
**Files:**
- Modify: `terraform/foundation/ai.tf`
- [ ] Add `"prometheus-mcp"` to the `local.agent_lambdas` **integ_count branch** (reads the secret) and
  include it in the `INTEGRATIONS_SECRET_NAME` env condition (the `contains([...], each.key)` list).
- [ ] Add var `prometheus_vpc_enabled` (bool, default false). Extend the dynamic `vpc_config` condition to
  also match `(each.key == "prometheus-mcp" && var.prometheus_vpc_enabled)`, and the
  `agent_lambda_vpc_eni` count to `var.agentcore_enabled && (var.opensearch_vpc_enabled ||
  var.clickhouse_vpc_enabled || var.prometheus_vpc_enabled) ? 1 : 0`.
- [ ] `terraform -chdir=terraform/foundation fmt` (revert out-of-scope drift) + `validate` (flag off AND
  `-var prometheus_vpc_enabled=true`) → green.
- [ ] Commit: `feat(agent-platform): provision prometheus-mcp Lambda (integ-gated) + prometheus_vpc_enabled flag (off)`.

## Manual / live steps (NOT autonomous)
1. `terraform -target` apply: prometheus Lambda (+ VPC if `prometheus_vpc_enabled=true`).
2. `make deploy` (Connectors card) + `make agentcore` (prometheus-mcp target on monitoring).
3. Connectors → Prometheus: endpoint (+auth) → chat (monitoring) "PromQL: rate of 5xx last 1h".
   (In-cluster Prometheus needs `prometheus_vpc_enabled=true` + persist in live tfvars.)
