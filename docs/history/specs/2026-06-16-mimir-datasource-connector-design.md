# Mimir Datasource Connector (PromQL, read-only) — v1 family sibling #5 (final)

**Date:** 2026-06-16 · **Branch:** `fix/v2-upgrade-snapshot-id` · **Status:** Design (consensus, "순서대로 끝까지").
**Builds on:** `agent/lambda/datasource_http.py` + `prometheus_mcp.py` (Mimir is Prometheus-API-compatible)
+ `loki_mcp.py` (X-Scope-OrgID pattern).

## Goal
Read-only Grafana Mimir connector: PromQL instant/range + label/series discovery, on the **monitoring**
gateway. Mimir exposes the **Prometheus HTTP API under a `/prometheus` prefix** and is **multi-tenant**
(requires `X-Scope-OrgID`). Read-only by construction → no SQL guard; SSRF via `datasource_http`.

## Mimir specifics (vs Prometheus connector)
- **Base path prefix `/prometheus`:** `GET /prometheus/api/v1/query[_range]`, `/prometheus/api/v1/labels`,
  `/prometheus/api/v1/series` (vs Prometheus' bare `/api/v1/...`).
- **Multi-tenant:** `X-Scope-OrgID` header from an optional `org_id` credential field (Mimir usually
  REQUIRES a tenant; the connector sends it when configured). Same `_headers` merge as Loki/Tempo.
- Everything else mirrors `prometheus_mcp.py`: envelope `{status, data:{resultType, result}}`, unix-seconds
  `time`/`start`/`end`, step, sample bounding (series + points-per-series + global sample budget).

## Components
### (a) `agent/lambda/mimir_mcp.py` (datasource_http; slug `mimir`)
- Tools: `mimir_query(query, time?)`, `mimir_query_range(query, start?, end?, step?)`, `mimir_labels()`,
  `mimir_series(match)` — same shapes as the Prometheus tools, base path `/prometheus/api/v1/...`.
- `_BASE = "/prometheus/api/v1"`. `_headers` = `auth_headers(creds)` + optional `X-Scope-OrgID`.
  unix-seconds time parsing; envelope `status!='success'` → error; sample bounding (≤50 series, ≤500
  points/series, ≤5000 total). Mirrors the MCP contract; pops `target_account_id`.

### (b) web: add `mimir` to `KNOWN_CONNECTOR_SLUGS` + Connectors card (endpoint + optional auth + org_id).
### (c) `catalog.py`: `mimir-mcp-target` → monitoring, 4 tools.
### (d) `ai.tf`: `mimir-mcp` in integ_count branch + `INTEGRATIONS_SECRET_NAME` env; var
`mimir_vpc_enabled` extends the dynamic `vpc_config` + `agent_lambda_vpc_eni` compound gate. No new IAM.

## Testing
- `test_mimir_mcp.py`: query/range hit `/prometheus/api/v1/...` (assert the prefix); PromQL URL-encoded;
  unix-seconds time + default 1h window/step 60; labels/series; `X-Scope-OrgID` iff org_id;
  status!=success → error; not-connected/SSRF/HTTP-error → error; target_account_id popped; sample bounding.
- web vitest (mimir slug); TF fmt+validate (off & on).

## Scope / YAGNI
- One datasource (Mimir), 4 read tools. Completes the v1 datasource family (clickhouse/prometheus/loki/
  tempo/mimir). No NL→PromQL, no Mimir admin/ruler API.

## ADR note
External read-only metrics datasource (ADR-011 lineage). Read-only; SSRF via shared guard.
