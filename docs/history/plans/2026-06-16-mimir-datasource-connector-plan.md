# Plan: Mimir datasource connector (PromQL, read-only) — v1 family sibling #5 (final)

> Spec: `docs/superpowers/specs/2026-06-16-mimir-datasource-connector-design.md`. Mimir is
> Prometheus-API-compatible under a `/prometheus` prefix + multi-tenant `X-Scope-OrgID`. Reuses
> `datasource_http.py`; mirrors `prometheus_mcp.py` (query logic/bounding) + `loki_mcp.py` (org_id).

## Grounding (verified)
- `prometheus_mcp.py`: 4 tools, envelope `{status,data:{resultType,result}}`, unix-seconds `_parse_time`,
  `_bound` (series/points/total). Mimir = same API at base `/prometheus/api/v1/...` + X-Scope-OrgID.
- `loki_mcp.py` `_headers` = `{**auth_headers(creds), **({'X-Scope-OrgID': creds['org_id']} if creds.get('org_id') else {})}`.
- Single secret + grant + INTEGRATIONS_SECRET_NAME env exist; extend `mimir_vpc_enabled` into vpc_config + ENI gate.

## Tasks (TDD; per-task commit; unittest / vitest / catalog_check / `terraform validate` green)

### Task 1: Mimir read-only MCP Lambda (TDD)
**Files:** Create `agent/lambda/mimir_mcp.py`; Test `agent/lambda/test_mimir_mcp.py`
- [ ] Failing tests (mock load_datasource/assert_host_allowed/http_json):
  - `mimir_query('up')` → GET URL contains **`/prometheus/api/v1/query`** (assert the `/prometheus` prefix),
    PromQL URL-encoded, `time` present.
  - `mimir_query_range('up', start='1h')` → `/prometheus/api/v1/query_range`; unix-seconds start/end (default
    now-1h, step 60).
  - `mimir_labels()` → `/prometheus/api/v1/labels`; `mimir_series(match='up')` → `/prometheus/api/v1/series`
    (match URL-encoded; missing match → error).
  - `X-Scope-OrgID` header set iff `org_id`; envelope `status!='success'` → error;
    not-connected/SSRF/HTTP-4xx → error; `target_account_id` popped; sample bounding (series/points/total → truncated).
- [ ] Implement `mimir_mcp.py`: `_BASE="/prometheus/api/v1"`; `_headers` (auth + optional X-Scope-OrgID);
  `_parse_time` (now/`1h` etc → unix seconds); `_bound` (series≤50, points≤500, total≤5000); 4 tools;
  `ok`/`err`. Stdlib + boto3 (reuses datasource_http). (May mirror prometheus_mcp closely — that is fine.)
- [ ] `cd agent/lambda && python3 -m unittest test_mimir_mcp` → green.
- [ ] Commit: `feat(agent-platform): Mimir read-only MCP Lambda (PromQL @ /prometheus, X-Scope-OrgID) on datasource_http`.

### Task 2: Connectors UI — mimir slug + card
**Files:** Modify `web/lib/integration-credentials.ts`, `web/lib/integration-credentials.test.ts`, `web/app/customization/page.tsx`
- [ ] Add `mimir` to `KNOWN_CONNECTOR_SLUGS`; test store/merge. CONNECTORS `mimir` card: `endpoint` +
  optional `org_id` + optional `username`/`password`/`token`.
- [ ] vitest green; tsc no new errors in changed files.
- [ ] Commit: `feat(integrations): Mimir connector card (endpoint + optional auth + org_id) + slug`.

### Task 3: register the Mimir target on monitoring
**Files:** Modify `scripts/v2/agentcore/catalog.py`
- [ ] `TARGETS["mimir-mcp-target"]` → `{gateway:"monitoring", lambda_key:"mimir-mcp", tools:[4]}`
  (`mimir_query`, `mimir_query_range`, `mimir_labels`, `mimir_series`).
- [ ] catalog_check → OK + `mimir-mcp` in lambda_keys.
- [ ] Commit: `feat(agent-platform): register mimir-mcp-target on monitoring gateway`.

### Task 4: provision the Mimir Lambda + mimir_vpc_enabled flag (TF)
**Files:** Modify `terraform/foundation/ai.tf`
- [ ] Add `"mimir-mcp"` to the integ_count branch + the `INTEGRATIONS_SECRET_NAME` env `contains([...])` list.
- [ ] Add var `mimir_vpc_enabled` (default false); extend the dynamic `vpc_config` condition and the
  `agent_lambda_vpc_eni` compound count to include `mimir-mcp`/`mimir_vpc_enabled`.
- [ ] fmt + validate (off AND `-var mimir_vpc_enabled=true`) → green.
- [ ] Commit: `feat(agent-platform): provision mimir-mcp Lambda (integ-gated) + mimir_vpc_enabled flag (off)`.

## Manual / live: `terraform -target` apply + `make deploy`/`make agentcore`; Connectors → Mimir (endpoint
+ org_id) → chat (monitoring) PromQL; in-cluster needs `mimir_vpc_enabled=true`.
