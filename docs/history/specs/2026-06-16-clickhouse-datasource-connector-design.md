# ClickHouse Datasource Connector (user-supplied endpoint + SQL, read-only)

**Date:** 2026-06-16
**Branch:** `fix/v2-upgrade-snapshot-id` (worktree `gap-impl-wave1`)
**Status:** Design — approved by user direction (`/co-agent:consensus`), entering plan→build.
**Context:** the v1 external-datasource model realized in v2. The user wants the **v1 datasource
family** — **ClickHouse, Prometheus, Loki, Tempo, Mimir** — all of which share ONE model:
user-supplied **HTTP endpoint + credential**, queried in a **query language** (SQL / PromQL / LogQL /
TraceQL / PromQL). Unlike Notion (fixed endpoint) or OpenSearch (AWS-native, boto3-discovered),
these are user-endpoint datasources — the first connectors that both *use* the credential UX and
*extend* it (endpoint + auth, not a single token).

**Cadence (user: "one at a time"):** this increment builds **ClickHouse + the reusable
datasource-connector foundation** (multi-field credential schema/UI, a shared SSRF/auth/HTTP helper,
the VPC-reachability flag pattern) so the remaining four (Prometheus/Loki/Tempo/Mimir) land as small
sibling increments — each just a query tool + endpoint paths + query language on the same foundation.

## Goal
A read-only ClickHouse connector: an admin connects a ClickHouse datasource (endpoint + auth) in the
Connectors UI; the connector Lambda runs **read-only SQL** against it and returns rows. On the
**data** gateway (ClickHouse is a datastore). Reachability: public-auth by default; private/in-VPC
behind a flag.

## Key decisions
- **Credential = a multi-field object** stored in the single secret under slug `clickhouse`:
  `{"endpoint":"http://host:8123","username":"default","password":"…"}`. The credential lib already
  stores an arbitrary object per slug — only the **Connectors panel must generalize** from one
  "token" field to a per-connector **field schema** (`CONNECTORS[].fields`). Notion stays one
  `token` field; ClickHouse gets `endpoint`+`username`+`password`.
- **Read-only SQL guard:** the connector accepts only `SELECT`/`SHOW`/`DESCRIBE`/`EXISTS`/`WITH…SELECT`
  (reject `INSERT`/`ALTER`/`DROP`/`CREATE`/`DELETE`/`TRUNCATE`/`OPTIMIZE`/`ATTACH`/`SET`/multi-statement
  `;`). Also send ClickHouse `readonly=1` (+ `max_result_rows`) as a server-side backstop. Read-only
  stance preserved.
- **SSRF:** the endpoint is user-supplied → at the connector Lambda, resolve the host and **always
  block** metadata(169.254.169.254 / fd00:ec2::254)/loopback/link-local/multicast/reserved (reuse the
  agent.py `_ip_always_blocked` classifier logic, ported to this Lambda). Private RFC1918/ULA is
  ALLOWED (in-cluster ClickHouse is the intended target) — documented as the ADR-011 private-datasource
  posture. https not required (in-cluster ClickHouse is plain http); credentials go over the VPC.
- **Reachability / VPC:** non-VPC by default (reaches a public-auth endpoint). For an in-VPC ClickHouse,
  flag `clickhouse_vpc_enabled` (default false) attaches the connector Lambda to the private subnets +
  service SG — same mechanism as `opensearch_vpc_enabled` (extend the dynamic `vpc_config` condition +
  the compound-gated ENI policy to include `clickhouse-mcp`).
- **Secret IAM:** the connector Lambda reads the single integrations secret — the existing
  `agent_lambda_integrations_secret` GetSecretValue grant (from the credential-UI increment) already
  covers it; **no new secret IAM**. (No AWS data-plane IAM — ClickHouse is plain HTTP.)
- **Live test:** likely none (no ClickHouse instance) → code + tests only; document that live needs a
  reachable endpoint + creds (+ `clickhouse_vpc_enabled` for in-VPC) + the admin gate open.

## Architecture (data flow)
```
[Admin UI] Connectors → ClickHouse card (endpoint + username + password) → PUT /api/integrations/credential
   {slug:'clickhouse', secret:{endpoint,username,password}}  (SSRF-validate endpoint host on save)
[chat] data gateway → clickhouse-mcp Lambda → read map['clickhouse'] from the single secret
   → SSRF-guard the endpoint host → POST <endpoint>/?readonly=1&max_result_rows=N (Basic auth) body=SQL
   → rows → agent summarizes
```

## Components
### (a0) `agent/lambda/datasource_http.py` — shared datasource-connector helper (reused by the family)
- `load_datasource(slug)` → reads `creds[slug]` = {endpoint, username?, password?, token?} from the
  single integrations secret (env `INTEGRATIONS_SECRET_NAME`); missing → a clear "not connected" error.
- `assert_host_allowed(endpoint)` → SSRF always-block (metadata 169.254.169.254 / fd00:ec2::254,
  loopback, link-local, multicast, reserved); private RFC1918/ULA ALLOWED (in-cluster datasources are
  the intended target — ADR-011 posture). Raises on block.
- `auth_headers(creds)` → Basic (user/password) or Bearer (token) or none.
- `http_json(method, url, headers, body, timeout)` → stdlib urllib; returns (status, parsed); bounds.
- This is the v1 `datasource-client` logic ported to Python; Prometheus/Loki/Tempo/Mimir Lambdas reuse it.

### (a) `agent/lambda/clickhouse_mcp.py` — read-only ClickHouse MCP Lambda (uses datasource_http)
- **Tools:** `clickhouse_query(sql, max_rows?)` (read-only SQL, `FORMAT JSON`); `clickhouse_tables()`
  (`SHOW TABLES` / system.tables); `clickhouse_describe(table)` (`DESCRIBE`).
- Reads `creds = json(secret)["clickhouse"]` = {endpoint, username, password} (secret name from env
  `INTEGRATIONS_SECRET_NAME`; missing → "clickhouse not connected" error). Basic-auth header from
  user/password. `_assert_read_only(sql)` + `_assert_host_allowed(endpoint)` (always-block set) before
  the request. Stdlib `urllib` (no extra deps). Bounds: `max_result_rows` + truncate.
- Handler mirrors the MCP contract (`tool_name`+`arguments`, pop `target_account_id`, `ok`/`err`).

### (b) `web/lib/integration-credentials.ts` + `web/app/customization/page.tsx`
- Add `clickhouse` to `KNOWN_CONNECTOR_SLUGS`. Generalize `CONNECTORS` to carry `fields` (Notion:
  `[{key:'token'}]`; ClickHouse: `[{key:'endpoint'},{key:'username'},{key:'password',secret:true}]`);
  the panel renders the fields and PUTs `{slug, secret:{...collected}}`. SSRF-validate the `endpoint`
  field server-side on save (reuse `web/lib/ssrf-guard.ts` with the always-block set; private allowed).

### (c) `terraform/foundation/ai.tf`
- Add `"clickhouse-mcp"` to `local.agent_lambdas` base map (agentcore_enabled). No new IAM (reuses the
  integrations-secret read grant). Extend the dynamic `vpc_config` + ENI policy conditions to also
  match `clickhouse-mcp` when `clickhouse_vpc_enabled`. New var `clickhouse_vpc_enabled` (default false).

### (d) `scripts/v2/agentcore/catalog.py`
- `TARGETS["clickhouse-mcp-target"]` → gateway `data`, 3 tools.

## Error handling
- Not connected / missing fields → structured "clickhouse not connected" error.
- Non-read-only SQL → rejected before any request ("read-only: only SELECT/SHOW/DESCRIBE").
- SSRF block → "endpoint blocked (metadata/loopback)".
- ClickHouse HTTP 4xx/5xx → structured error with the body snippet.

## Testing
- `agent/lambda/test_clickhouse_mcp.py`: read-only guard (accept SELECT/SHOW/DESC; reject INSERT/DROP/
  multi-stmt); SSRF always-block (169.254.169.254/127.0.0.1/::1 → blocked; 10.x private → allowed);
  request build (Basic auth header, readonly=1, FORMAT JSON, body=sql); missing creds → error;
  HTTP error mapped; `target_account_id` popped; row truncation.
- `web/lib/integration-credentials.test.ts`: `clickhouse` slug allowed; multi-field object stored/merged.
- `web/app/api/integrations/credential/route.test.ts`: endpoint SSRF-reject on save (if validated there).
- TF `fmt`+`validate` (flag off & on). Full web vitest green.

## Scope / YAGNI
- **This increment:** ClickHouse (3 read tools, read-only SQL) **+ the shared foundation**
  (`datasource_http.py`, multi-field Connectors UI, VPC flag pattern). Public-auth default; VPC behind a flag.
- **Next increments (one at a time):** Prometheus (PromQL `/api/v1/query[_range]`), Loki (LogQL
  `/loki/api/v1/query_range`), Tempo (TraceQL `/api/search`), Mimir (PromQL `/prometheus/api/v1/query`)
  — each a small sibling: a query tool + endpoint paths + a CONNECTORS field schema, reusing `datasource_http`.
- No query-builder, no write, no schema-cache, no AI query generation yet (v1 had NL→query; later).

## ADR note
External read-only datasource (ADR-011 lineage: SSRF allowlist, private opt-in). No mutation/autonomy.
Read-only SQL + always-block SSRF keep the read-only stance. (ADR numbering per `docs/decisions/CLAUDE.md`.)
