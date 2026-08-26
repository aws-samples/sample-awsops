# Tempo Datasource Connector (TraceQL, read-only) — v1 family sibling #4

**Date:** 2026-06-16 · **Branch:** `fix/v2-upgrade-snapshot-id` · **Status:** Design (consensus, "순서대로 끝까지").
**Builds on:** `agent/lambda/datasource_http.py` + multi-field Connectors UI; `loki_mcp.py`/`prometheus_mcp.py` templates.

## Goal
Read-only Tempo connector: search traces by **TraceQL** + fetch a trace + tag discovery, on the
**monitoring** gateway (metrics+logs+traces correlation for incident triage). Read-only by
construction (Tempo query API can't write; TraceQL has no server-side fetch) → no SQL guard; SSRF via
`datasource_http.assert_host_allowed`.

## Tempo specifics
- **Endpoints:** `GET /api/search?q=<TraceQL>&start=&end=&limit=` (start/end = unix **SECONDS**);
  `GET /api/traces/<traceID>` (full trace); `GET /api/search/tags`; `GET /api/search/tag/<tag>/values`.
- **Multi-tenant:** optional `org_id` → `X-Scope-OrgID` header (same as Loki).
- **Large payloads:** a single trace (batches of spans) can be multi-MB → bound: cap trace count in
  search, cap spans/batches per trace, AND a total-byte budget; `ensure_ascii=False` in `ok()`.
- **trace_id validation:** hex-only `[0-9a-fA-F]+` (defense-in-depth, it goes in the URL path).

## Components
### (a) `agent/lambda/tempo_mcp.py` (datasource_http; slug `tempo`)
- Tools: `tempo_search(query, start?, end?, limit?)` → `/api/search`; `tempo_get_trace(trace_id)` →
  `/api/traces/<hex>`; `tempo_search_tags()` → `/api/search/tags`; `tempo_tag_values(tag)` →
  `/api/search/tag/<tag>/values`.
- `_parse_time_s` (now / `1h`/`30m` → now-delta SECONDS / unix passthrough). `_headers` = auth + optional
  `X-Scope-OrgID`. `urlencode` for `q`; `quote` for tag/trace_id path; `_validate_trace_id` (hex).
  Bound search traces (≤50) + per-trace spans/byte budget; `ensure_ascii=False`. Mirrors MCP contract;
  pops `target_account_id`. Tempo search envelope is `{traces:[…]}` (no `status` field) — treat HTTP 2xx
  as success, 4xx/5xx as error.

### (b) web: add `tempo` to `KNOWN_CONNECTOR_SLUGS` + Connectors card (endpoint + optional auth + org_id).
### (c) `catalog.py`: `tempo-mcp-target` → monitoring, 4 tools.
### (d) `ai.tf`: `tempo-mcp` in integ_count branch + `INTEGRATIONS_SECRET_NAME` env; var
`tempo_vpc_enabled` extends the dynamic `vpc_config` + `agent_lambda_vpc_eni` compound gate. No new IAM.

## Testing
- `test_tempo_mcp.py`: search params (q URL-encoded, start/end SECONDS, default 1h, limit); get_trace
  (hex path; non-hex trace_id → error before request); tags; tag_values (tag path-encoded);
  `X-Scope-OrgID` iff org_id; HTTP 4xx/5xx → error; not-connected/SSRF → error; target_account_id popped;
  trace/byte bounding (truncated) incl. a multibyte case.
- web vitest (tempo slug); TF fmt+validate (off & on).

## Scope / YAGNI
- One datasource (Tempo), 4 read tools. No NL→TraceQL, no metrics-from-traces. Mimir is the last sibling.

## ADR note
External read-only traces datasource (ADR-011 lineage). Read-only; SSRF via shared guard.
