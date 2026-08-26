# Plan: Loki datasource connector (LogQL, read-only) — v1 family sibling #3

> Spec: `docs/superpowers/specs/2026-06-16-loki-datasource-connector-design.md`. Reuses
> `agent/lambda/datasource_http.py`; `prometheus_mcp.py` is the template. Loki differences:
> **nanosecond** timestamps + optional **X-Scope-OrgID** multi-tenant header. monitoring gateway.

## Grounding (verified)
- v1 `queryLoki`: range `GET /loki/api/v1/query_range?query=&start=&end=&limit=&direction=` (start/end =
  unix **nanoseconds**, default now-1h); instant `GET /loki/api/v1/query?query=&limit=`; envelope
  `{status, data:{resultType:'streams'|'matrix', result}}`. Port 3100; placeholder `http://loki:3100`.
- `datasource_http.{load_datasource,assert_host_allowed,auth_headers,http_json}` ready. `prometheus_mcp.py`
  shows the dispatch/bounding/_parse pattern. Single secret + grant + INTEGRATIONS_SECRET_NAME env exist.
- VPC: extend `loki_vpc_enabled` into the dynamic vpc_config + `agent_lambda_vpc_eni` compound gate.

## P2 consensus gate — round 1 findings & resolutions (kiro opus/kimi/glm)
- **MAJOR (opus, valid) — add a total-BYTES budget to `_bound`.** Loki log lines are arbitrary-length
  (multi-KB stack traces / JSON dumps); capping line COUNT (≤5000) doesn't bound payload bytes → can
  exceed the 6 MB Lambda limit / balloon model context. **Resolution: `_bound` also enforces
  `MAX_TOTAL_BYTES` (sum `len(line)` across kept values; stop + `truncated:true` when exceeded; truncate
  an individual oversized line to a cap). Test a result whose lines exceed the byte budget is truncated.**
- **MINOR (kimi, adopt) — integer ns arithmetic + dual error check.** `_parse_time_ns` uses integer math
  (`int(time.time()) * 1_000_000_000`, not float `*1e9`) to avoid precision loss; `_get` errors on
  HTTP `status>=400` OR envelope `status!='success'` (mirror prometheus_mcp `_get`).
- **kimi's X-Scope-OrgID "merge" + TF compound-gate/vpc_config "missing loki" — NOT defects:** the merge
  is `{**auth_headers(creds), **(org_id?…)}` (exactly Task 1), and Task 4 already prescribes adding loki to
  the compound ENI gate + vpc_config (kimi read the pre-implementation ai.tf). No plan change.
- glm: NO BLOCKING.

## Tasks (TDD; per-task commit; unittest / vitest / catalog_check / `terraform validate` green)

### Task 1: Loki read-only MCP Lambda (TDD)
**Files:** Create `agent/lambda/loki_mcp.py`; Test `agent/lambda/test_loki_mcp.py`
- [ ] Failing tests (mock load_datasource/assert_host_allowed/http_json):
  - `loki_query_range('{app="x"}', start='1h')`: GET `/loki/api/v1/query_range`; start/end are unix
    **nanosecond** strings (assert end-start ≈ 1h in ns; default window now-1h); LogQL URL-encoded;
    `limit` default 100, `direction` default `backward`.
  - `loki_query('{app="x"}')`: GET `/loki/api/v1/query` (instant).
  - `loki_labels()` → `/loki/api/v1/labels`; `loki_label_values('app')` → `/loki/api/v1/label/app/values`
    (label percent-encoded in the path).
  - `X-Scope-OrgID`: header present == creds has `org_id`; absent otherwise.
  - envelope `status!='success'` → error; not-connected/SSRF/HTTP-4xx → error; `target_account_id` popped.
  - bounding: a `streams` result with > cap streams / > cap lines-per-stream / > global line budget /
    > total-BYTES budget is truncated (`values[]` trimmed; oversized single line capped) + `truncated:true`
    (test the byte-budget case explicitly, not just line-count).
- [ ] Implement `loki_mcp.py`: dispatch like prometheus_mcp; `_parse_time_ns` (now / `1h`/`30m` → now-delta;
  **integer ns** `int(time.time()) * 1_000_000_000` — no float `*1e9`); `_headers(creds)` =
  `{**auth_headers(creds), **({'X-Scope-OrgID': creds['org_id']} if creds.get('org_id') else {})}`;
  `urlencode`; `_get` errors on HTTP `status>=400` OR envelope `status!='success'`; `_bound`
  (streams + lines/stream + global line budget + `MAX_TOTAL_BYTES`, capping an oversized line); `ok`/`err`.
  Stdlib + boto3 (reuses datasource_http).
- [ ] `cd agent/lambda && python3 -m unittest test_loki_mcp` → green.
- [ ] Commit: `feat(agent-platform): Loki read-only MCP Lambda (LogQL, ns-time, X-Scope-OrgID) on datasource_http`.

### Task 2: Connectors UI — loki slug + card
**Files:** Modify `web/lib/integration-credentials.ts`, `web/lib/integration-credentials.test.ts`, `web/app/customization/page.tsx`
- [ ] Add `loki` to `KNOWN_CONNECTOR_SLUGS`; test multi-field store/merge.
- [ ] CONNECTORS `loki` card: `endpoint` + optional `username`/`password`/`token` + optional `org_id`
  (X-Scope-OrgID). Reuses per-field render + endpoint SSRF-on-save.
- [ ] vitest green; tsc adds no new errors in changed files.
- [ ] Commit: `feat(integrations): Loki connector card (endpoint + optional auth + org_id) + slug`.

### Task 3: register the Loki target on monitoring
**Files:** Modify `scripts/v2/agentcore/catalog.py`
- [ ] `TARGETS["loki-mcp-target"]` → `{gateway:"monitoring", lambda_key:"loki-mcp", tools:[4]}`:
  `loki_query_range` (req query; opt start/end/limit/direction), `loki_query` (req query; opt time/limit),
  `loki_labels` (none), `loki_label_values` (req label).
- [ ] catalog_check → OK + `loki-mcp` in lambda_keys.
- [ ] Commit: `feat(agent-platform): register loki-mcp-target on monitoring gateway`.

### Task 4: provision the Loki Lambda + loki_vpc_enabled flag (TF)
**Files:** Modify `terraform/foundation/ai.tf`
- [ ] Add `"loki-mcp"` to the integ_count branch + the `INTEGRATIONS_SECRET_NAME` env `contains([...])` list.
- [ ] Add var `loki_vpc_enabled` (default false); extend the dynamic `vpc_config` condition and the
  `agent_lambda_vpc_eni` count to include `loki-mcp`/`loki_vpc_enabled`.
- [ ] fmt + validate (flag off AND `-var loki_vpc_enabled=true`) → green.
- [ ] Commit: `feat(agent-platform): provision loki-mcp Lambda (integ-gated) + loki_vpc_enabled flag (off)`.

## Manual / live: `terraform -target` apply + `make deploy`/`make agentcore`; Connectors → Loki (endpoint
[+org_id]) → chat (monitoring) "Loki: error logs last 1h"; in-cluster needs `loki_vpc_enabled=true`.
