# Loki Datasource Connector (LogQL, read-only) — v1 family sibling #3

**Date:** 2026-06-16 · **Branch:** `fix/v2-upgrade-snapshot-id` · **Status:** Design (consensus, "순서대로 끝까지").
**Builds on:** the shared `agent/lambda/datasource_http.py` foundation + multi-field Connectors UI;
`prometheus_mcp.py` is the sibling template.

## Goal
Read-only Loki connector: query logs by **LogQL** (instant/range) + label discovery, on the
**monitoring** gateway. Read-only by construction (Loki query API cannot write; LogQL has no
server-side fetch) → no SQL-style guard; SSRF handled by `datasource_http.assert_host_allowed`.

## Loki-specific differences (vs Prometheus)
- **Nanosecond timestamps:** Loki `start`/`end` are **unix NANOSECONDS** (v1: `getTime()*1e6`). The
  range default is now-1h. `_parse_time_ns` must emit ns (not seconds).
- **Multi-tenant header:** Loki is often multi-tenant → an optional `org_id` credential field maps to
  the **`X-Scope-OrgID`** request header (added on top of `datasource_http.auth_headers`).
- **Result shape:** `data.resultType` is `streams` (logs: each stream has `values:[[ns_ts, line],…]`)
  or `matrix` (metric LogQL). Bound streams AND lines-per-stream AND a global line budget.
- **`limit`/`direction`** query params (default limit 100, direction backward).

## Components
### (a) `agent/lambda/loki_mcp.py` (uses datasource_http; slug `loki`)
- Tools: `loki_query_range(query, start?, end?, limit?, direction?)` → `GET /loki/api/v1/query_range`;
  `loki_query(query, time?, limit?)` → `GET /loki/api/v1/query` (instant); `loki_labels()` →
  `GET /loki/api/v1/labels`; `loki_label_values(label)` → `GET /loki/api/v1/label/<label>/values`.
- LogQL/label URL-encoded (`urlencode`). `X-Scope-OrgID` from `creds['org_id']` if present.
  ns time parsing. Envelope `status!='success'` → error. Bound result (≤50 streams, ≤200 lines/stream,
  ≤5000 lines global, `truncated` flag). Mirrors the MCP contract; pops `target_account_id`.

### (b) web: add `loki` to `KNOWN_CONNECTOR_SLUGS` + a Connectors card (endpoint + optional
auth + optional `org_id`); endpoint SSRF-validated on save (existing path).
### (c) `catalog.py`: `loki-mcp-target` → monitoring, 4 tools.
### (d) `ai.tf`: `loki-mcp` in the integ_count branch + `INTEGRATIONS_SECRET_NAME` env; var
`loki_vpc_enabled` extends the dynamic `vpc_config` + the `agent_lambda_vpc_eni` compound gate. No new IAM.

## Testing
- `test_loki_mcp.py`: query_range ns-timestamp params + default 1h window; instant; labels;
  label_values (label in path, URL-encoded); `X-Scope-OrgID` header set iff org_id present;
  LogQL URL-encoding; status!=success → error; not-connected/SSRF/HTTP-error → error;
  target_account_id popped; stream+line bounding (truncated).
- web vitest (loki slug store/merge); TF fmt+validate (flag off & on).

## Scope / YAGNI
- One datasource (Loki), 4 read tools. No NL→LogQL, no tail/websocket, no push. Tempo + Mimir next.

## ADR note
External read-only logs datasource (ADR-011 lineage). Read-only by construction; SSRF via shared guard.
