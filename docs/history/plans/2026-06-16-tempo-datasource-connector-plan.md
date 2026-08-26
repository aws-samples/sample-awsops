# Plan: Tempo datasource connector (TraceQL, read-only) — v1 family sibling #4

> Spec: `docs/superpowers/specs/2026-06-16-tempo-datasource-connector-design.md`. Reuses
> `datasource_http.py`; `loki_mcp.py` template. Tempo: unix-SECONDS time, X-Scope-OrgID, hex trace_id,
> large trace payloads (byte budget). monitoring gateway.

## Grounding (verified)
- v1 `queryTempo`: trace `GET /api/traces/<id>`; search `GET /api/search?q=&start=&end=&limit=` (start/end
  unix SECONDS, end default now). Port 3200; placeholder `http://tempo:3200`. Tag APIs `/api/search/tags`,
  `/api/search/tag/<tag>/values`.
- `datasource_http` + `loki_mcp.py` (X-Scope-OrgID, byte-budget `_bound`, `ensure_ascii=False`) are the templates.
- Single secret + grant + INTEGRATIONS_SECRET_NAME env exist; extend `tempo_vpc_enabled` into vpc_config + ENI gate.

## Tasks (TDD; per-task commit; unittest / vitest / catalog_check / `terraform validate` green)

### Task 1: Tempo read-only MCP Lambda (TDD)
**Files:** Create `agent/lambda/tempo_mcp.py`; Test `agent/lambda/test_tempo_mcp.py`
- [ ] Failing tests (mock load_datasource/assert_host_allowed/http_json):
  - `tempo_search('{ .service.name="x" }', start='1h')`: GET `/api/search`; `q` URL-encoded; start/end
    unix SECONDS (default window now-1h; magnitude ~10-digit, NOT ns); `limit` passed when given.
  - `tempo_get_trace('a1b2')` → GET `/api/traces/a1b2`; a non-hex trace_id (`x; rm`) → error BEFORE any request.
  - `tempo_search_tags()` → `/api/search/tags`; `tempo_tag_values('service.name')` →
    `/api/search/tag/service.name/values` (tag path-encoded).
  - `X-Scope-OrgID` set iff `org_id`; HTTP 4xx/5xx → structured error; not-connected/SSRF → error;
    `target_account_id` popped.
  - bounding: a search with > cap traces, and a trace whose spans/bytes exceed the budget, are truncated
    (`truncated:true`); a multibyte case is budgeted by UTF-8 bytes.
- [ ] Implement `tempo_mcp.py`: dispatch like loki_mcp; `_parse_time_s` (now / `1h`/`30m` → now-delta
  SECONDS, integer; unix passthrough); `_headers` (auth + optional X-Scope-OrgID); `_validate_trace_id`
  (`^[0-9a-fA-F]+$`); `urlencode`/`quote`; `_bound` (cap traces + spans/batches + `MAX_TOTAL_BYTES` on
  UTF-8); success = HTTP 2xx (Tempo has no envelope `status`); `ok` with `ensure_ascii=False`/`err`.
  Stdlib + boto3 (reuses datasource_http).
- [ ] `cd agent/lambda && python3 -m unittest test_tempo_mcp` → green.
- [ ] Commit: `feat(agent-platform): Tempo read-only MCP Lambda (TraceQL search/trace/tags, byte-bounded) on datasource_http`.

### Task 2: Connectors UI — tempo slug + card
**Files:** Modify `web/lib/integration-credentials.ts`, `web/lib/integration-credentials.test.ts`, `web/app/customization/page.tsx`
- [ ] Add `tempo` to `KNOWN_CONNECTOR_SLUGS`; test store/merge. CONNECTORS `tempo` card: `endpoint` +
  optional `org_id` + optional `username`/`password`/`token`. Reuses per-field render + endpoint SSRF-on-save.
- [ ] vitest green; tsc no new errors in changed files.
- [ ] Commit: `feat(integrations): Tempo connector card (endpoint + optional auth + org_id) + slug`.

### Task 3: register the Tempo target on monitoring
**Files:** Modify `scripts/v2/agentcore/catalog.py`
- [ ] `TARGETS["tempo-mcp-target"]` → `{gateway:"monitoring", lambda_key:"tempo-mcp", tools:[4]}`:
  `tempo_search` (req query; opt start/end/limit), `tempo_get_trace` (req trace_id), `tempo_search_tags`
  (none), `tempo_tag_values` (req tag).
- [ ] catalog_check → OK + `tempo-mcp` in lambda_keys.
- [ ] Commit: `feat(agent-platform): register tempo-mcp-target on monitoring gateway`.

### Task 4: provision the Tempo Lambda + tempo_vpc_enabled flag (TF)
**Files:** Modify `terraform/foundation/ai.tf`
- [ ] Add `"tempo-mcp"` to the integ_count branch + the `INTEGRATIONS_SECRET_NAME` env `contains([...])` list.
- [ ] Add var `tempo_vpc_enabled` (default false); extend the dynamic `vpc_config` condition and the
  `agent_lambda_vpc_eni` compound count to include `tempo-mcp`/`tempo_vpc_enabled`.
- [ ] fmt + validate (off AND `-var tempo_vpc_enabled=true`) → green.
- [ ] Commit: `feat(agent-platform): provision tempo-mcp Lambda (integ-gated) + tempo_vpc_enabled flag (off)`.

## Manual / live: `terraform -target` apply + `make deploy`/`make agentcore`; Connectors → Tempo → chat
(monitoring) "Tempo: traces for service x with errors last 1h"; in-cluster needs `tempo_vpc_enabled=true`.
