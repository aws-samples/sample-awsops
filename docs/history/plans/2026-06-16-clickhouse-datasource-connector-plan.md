# Plan: ClickHouse datasource connector + shared datasource-connector foundation

> Spec: `docs/superpowers/specs/2026-06-16-clickhouse-datasource-connector-design.md`. First of the v1
> datasource family (clickhouse/prometheus/loki/tempo/mimir). This increment = ClickHouse (read-only
> SQL) + the reusable foundation (`datasource_http.py`, multi-field Connectors UI, VPC flag) so the
> other four land as small siblings. User-supplied endpoint + auth; data gateway. Branch
> `fix/v2-upgrade-snapshot-id`.

## Grounding (verified)
- v1 `src/lib/datasource-client.ts`: `buildHeaders` (basic = `Authorization: Basic base64(user:pass)`,
  bearer = `Authorization: Bearer token`), `fetchWithTimeout`; endpoints `/api/v1/query[_range]` (Prom),
  `/loki/api/v1/query_range` (Loki). Port to Python.
- Single integrations secret + `agent_lambda_integrations_secret` GetSecretValue grant already exist
  (credential-UI increment) → connector Lambdas read the secret with NO new IAM.
- MCP Lambda contract (network_mcp.py): `tool_name`+`arguments`, pop `target_account_id`, `ok`/`err`.
- `opensearch_vpc_enabled` + dynamic `vpc_config` + compound-gated ENI policy (ai.tf) — extend to clickhouse.
- Credential UX: `web/lib/integration-credentials.ts` stores an arbitrary object per slug; `KNOWN_CONNECTOR_SLUGS`;
  `web/app/customization/page.tsx` `CONNECTORS` (currently single `token` field) + `web/lib/ssrf-guard.ts`.

## Non-goals
- Prometheus/Loki/Tempo/Mimir tools (next increments, reuse `datasource_http`). No write, no NL→query, no schema-cache.

## P2 consensus gate — round 1 findings & resolutions (panel: kiro opus-4.8 + kimi-k2.5; glm timeout)
- **CRITICAL (both, verified) — ClickHouse table functions = server-side SSRF/exfil bypass.** A
  syntactically read-only `SELECT * FROM url('http://169.254.169.254/…')` (or `s3()`/`remote()`/`mysql()`/
  `postgresql()`/`jdbc()`/`odbc()`/`mongodb()`/`file()`/`hdfs()`/`azureBlobStorage()`/…) passes a verb
  allow-list, and ClickHouse `readonly=1` does NOT block read-side table functions → the **server**
  performs SSRF/cross-datastore reads, fully bypassing the Lambda host guard. v1 `queryClickHouse` had an
  explicit table-function blocklist; the plan dropped it. **Resolution: T2 `_assert_read_only` ports the
  v1 table-function blocklist (`\b(url|file|remote|remoteSecure|s3|gcs|hdfs|input|cluster|mysql|postgresql|
  jdbc|odbc|mongodb|azureBlobStorage|deltaLake|iceberg|sqlite)\s*\(`) + explicit bypass tests.**
- **CRITICAL/MAJOR (both) — read-only guard bypasses.** Comments (`/* */`, `--`) hiding verbs; stacked
  `;`; missing verbs GRANT/REVOKE/KILL/MOVE/RENAME/DETACH/SYSTEM. **Resolution: strip SQL comments
  before analysis; reject stacked statements; first non-comment token MUST be SELECT/WITH/SHOW/DESCRIBE/
  DESC/EXISTS; reject the dangerous-verb set anywhere; + the table-function block above. Tests for each.**
- **CRITICAL (kimi) / MAJOR (opus) — SSRF redirect + DNS-rebinding.** urllib follows 30x by default → a
  malicious endpoint can `Location:` to metadata/internal, re-validated by nobody (agent.py uses
  redirect=manual). **Resolution: T1 `http_json` installs a redirect handler that BLOCKS 3xx (no
  auto-follow) — mirrors agent.py.** DNS-rebinding (resolve≠connect TOCTOU): documented as an accepted
  limitation consistent with the inc2 egress posture (IP-pinning deferred) — the always-block + no-redirect
  + read-only + table-function block are the layered defense.
- **MAJOR (both) — web `ssrf-guard.ts` semantics don't fit.** `assertEgressEndpointAllowed` forces https
  (rejects plain-http in-cluster ClickHouse) and `isBlockedHost` blocks ALL RFC1918 (the legit target),
  while `allowPrivate:true` skips the blocked-host check entirely → permits metadata (SSRF hole).
  **Resolution: T3 adds a NEW always-block-only validator to `ssrf-guard.ts` (block metadata
  169.254.169.254/fd00:ec2::254 + loopback/link-local/multicast/reserved; ALLOW RFC1918/ULA; allow ONLY
  http/https schemes — reject file://etc.) mirroring agent.py `_ip_always_blocked`; use it for
  endpoint-bearing slugs at save. The Lambda (`datasource_http.assert_host_allowed`) enforces the same.**
- **MAJOR (opus) — TF gating mismatch.** clickhouse-mcp on the `agentcore_enabled` base map, but the
  integrations secret + its GetSecretValue grant + `INTEGRATIONS_SECRET_NAME` env are `integ_count`-gated
  (and the env is notion-only) → with `integrations_enabled=false` the Lambda has no secret/IAM/env (runtime
  fail) and `integrations[0]` refs index-error. **Resolution: T5 gates clickhouse-mcp on `integ_count` (the
  notion branch) and adds its `INTEGRATIONS_SECRET_NAME` env in the merge.**
- **MAJOR (kimi) — scheme + secret hygiene.** **Resolution: restrict endpoint scheme to http/https (both
  Lambda + web); `datasource_http` never logs creds/headers; secret UI fields use `autoComplete="new-password"`.**
- **MINOR — ENI gate update.** **Resolution: update the EXISTING `aws_iam_role_policy.agent_lambda_vpc_eni`
  `count` to `var.agentcore_enabled && (var.opensearch_vpc_enabled || var.clickhouse_vpc_enabled)`.**

## Tasks (TDD; per-task commit; `python3 -m unittest` / vitest / catalog_check / `terraform validate` green)

### Task 1: shared datasource-connector helper (TDD)
**Files:**
- Create: `agent/lambda/datasource_http.py`
- Test: `agent/lambda/test_datasource_http.py`
- [ ] Failing tests (unittest; mock the single-secret read + urlopen; no network):
  - `load_datasource('clickhouse')`: reads `INTEGRATIONS_SECRET_NAME` JSON → `map['clickhouse']`
    `{endpoint,username,password}`; missing slug/empty secret → `NotConnected` (clear message).
  - `auth_headers`: `{username,password}` → `Authorization: Basic base64(u:p)`; `{token}` → `Bearer`;
    neither → no auth header.
  - `assert_host_allowed`: scheme MUST be http/https (else raise — reject `file://`/`gopher://`…);
    `169.254.169.254`/`127.0.0.1`/`::1`/`fe80::1`/`224.0.0.1`/`fd00:ec2::254` → blocked (raises);
    `10.0.0.1`/`192.168.1.1`/`fc00::1`/`8.8.8.8`/a hostname → allowed. Two classifiers (always-block vs
    allowed), NOT one. Resolve a hostname to ALL its IPs and block if ANY is in the always-block set.
    (Port agent.py `_ip_always_blocked` logic.)
  - `http_json(method,url,headers,body,timeout)`: builds the request, returns (status, parsed); HTTP
    non-2xx → (status, body) not an exception; **3xx is NOT auto-followed** (redirect handler blocks it).
  - never logs `creds`/auth headers (assert no secret in any log/exception path).
- [ ] Implement `agent/lambda/datasource_http.py`: `NotConnected(Exception)`; `load_datasource(slug)`
  (boto3 SecretsManager get + json + slug extract, module-cached client); `assert_host_allowed(endpoint)`
  (parse scheme; resolve host; `ipaddress` always-block set; DNS-resolve a hostname to its IPs, block if
  ANY always-blocked, else allow public/private); `auth_headers(creds)` (Basic/Bearer/none); `http_json`
  via stdlib urllib with a **no-redirect opener** (`HTTPRedirectHandler.redirect_request` → None / raise).
  Stdlib + boto3 only. Never log credential material.
- [ ] `cd agent/lambda && python3 -m unittest test_datasource_http` → green.
- [ ] Commit: `feat(agent-platform): datasource_http — shared SSRF/auth/HTTP helper for v1 datasource family`.

### Task 2: ClickHouse read-only MCP Lambda (TDD)
**Files:**
- Create: `agent/lambda/clickhouse_mcp.py`
- Test: `agent/lambda/test_clickhouse_mcp.py`
- [ ] Failing tests (mock `datasource_http.load_datasource` + `urlopen`):
  - read-only guard `_assert_read_only` — **comment-strip first** (`/* */` and `--…` removed), then:
    accept first token `SELECT`/`WITH…SELECT`/`SHOW`/`DESCRIBE`/`DESC`/`EXISTS` (case/whitespace-insensitive).
    REJECT (anywhere): `INSERT/ALTER/DROP/CREATE/DELETE/TRUNCATE/OPTIMIZE/ATTACH/DETACH/SET/SYSTEM/GRANT/
    REVOKE/KILL/MOVE/RENAME`; REJECT stacked statements (a `;` separating two statements).
    **REJECT table functions** `\b(url|file|remote|remoteSecure|s3|gcs|hdfs|input|cluster|mysql|postgresql|
    jdbc|odbc|mongodb|azureBlobStorage|deltaLake|iceberg|sqlite)\s*\(` — tested with
    `SELECT * FROM url('http://169.254.169.254/')` → rejected, `SELECT/**/* FROM mysql(...)` → rejected.
  - `clickhouse_query('SELECT 1', max_rows=5)`: POST `<endpoint>/?readonly=1&max_result_rows=5` with the
    Basic-auth header and `FORMAT JSON` appended; returns parsed rows; truncates to max_rows.
  - `clickhouse_tables` → `SHOW TABLES`; `clickhouse_describe('t')` → `DESCRIBE TABLE t`.
  - not connected (load_datasource raises) → structured error; HTTP 4xx/5xx → structured error w/ snippet.
  - SSRF: a blocked endpoint (via assert_host_allowed) → "endpoint blocked" error; `target_account_id` popped.
- [ ] Implement `agent/lambda/clickhouse_mcp.py`: `lambda_handler` (mirror dispatch); uses
  `datasource_http.load_datasource('clickhouse')` + `assert_host_allowed` + `auth_headers` + `http_json`;
  `_assert_read_only(sql)` (comment-strip + first-token allow-list + dangerous-verb reject + stacked-stmt
  reject + table-function block); 3 tools; `readonly=1`+`max_result_rows` server backstop; `ok`/`err`;
  row truncation. (readonly=1 is defense-in-depth — the table-function block is the real SSRF control.)
- [ ] `cd agent/lambda && python3 -m unittest test_clickhouse_mcp` → green.
- [ ] Commit: `feat(agent-platform): ClickHouse read-only MCP Lambda (SQL, read-only guard) on datasource_http`.

### Task 3: multi-field Connectors UI + clickhouse slug + endpoint SSRF on save
**Files:**
- Modify: `web/lib/integration-credentials.ts`
- Test: `web/lib/integration-credentials.test.ts`
- Modify: `web/lib/ssrf-guard.ts`
- Test: `web/lib/ssrf-guard.test.ts`
- Modify: `web/app/api/integrations/credential/route.ts`
- Test: `web/app/api/integrations/credential/route.test.ts`
- Modify: `web/app/customization/page.tsx`
- [ ] `ssrf-guard.ts`: add a NEW `assertDatasourceEndpointAllowed(url)` (always-block-only): allow ONLY
    http/https schemes; block metadata `169.254.169.254`/`fd00:ec2::254`, loopback, link-local, multicast,
    reserved; ALLOW RFC1918/ULA + public (in-cluster datasources are the target). Failing tests: metadata/
    loopback/`file://` → throw; `http://10.0.0.5:8123`/`https://ch.example` → ok. (Mirrors agent.py
    `_ip_always_blocked`; does NOT reuse `assertEgressEndpointAllowed`, whose https-only + block-all-RFC1918
    semantics are wrong here.)
- [ ] Add `clickhouse` to `KNOWN_CONNECTOR_SLUGS`. Failing tests: store/merge a multi-field
    `{endpoint,username,password}` under `clickhouse` (other slugs preserved); `getConfiguredSlugs`
    still keys-only; secret values never in any return.
- [ ] Route: for an endpoint-bearing slug, `assertDatasourceEndpointAllowed(secret.endpoint)` BEFORE
    `setIntegrationCredential`; blocked host/`file://` → 400, no SM write; valid → stored. Test both.
- [ ] `page.tsx`: generalize `CONNECTORS` to `{slug,label,help,fields:[{key,label,secret?}]}`; render each
    field (secret fields `type=password` + `autoComplete="new-password"`); PUT `{slug, secret:{...collected}}`.
    Notion = `[{token,secret}]`; ClickHouse = `[{endpoint},{username},{password,secret}]`. Never render secret values back.
- [ ] `cd web && npx vitest run lib/integration-credentials.test.ts app/api/integrations/credential/route.test.ts`
    → green; `npx tsc --noEmit` adds no errors in the changed files.
- [ ] Commit: `feat(integrations): multi-field Connectors UI + clickhouse slug + endpoint SSRF on save`.

### Task 4: register the ClickHouse target on the data gateway
**Files:**
- Modify: `scripts/v2/agentcore/catalog.py`
- [ ] `TARGETS["clickhouse-mcp-target"]` → `{gateway:"data", lambda_key:"clickhouse-mcp", tools:[3]}`:
    `clickhouse_query` (req `sql`; opt `max_rows`), `clickhouse_tables` (none), `clickhouse_describe` (req `table`).
- [ ] `cd scripts/v2/agentcore && python3 catalog_check.py` → `OK` + `clickhouse-mcp` in lambda_keys.
- [ ] Commit: `feat(agent-platform): register clickhouse-mcp-target on data gateway`.

### Task 5: provision the ClickHouse Lambda + clickhouse_vpc_enabled flag (TF)
**Files:**
- Modify: `terraform/foundation/ai.tf`
- [ ] Add `"clickhouse-mcp"` to `local.agent_lambdas` **integ_count branch** (the notion-mcp merge —
    NOT the agentcore base), since it needs the integrations secret. Add its env in the merge:
    `INTEGRATIONS_SECRET_NAME = aws_secretsmanager_secret.integrations[0].name` (alongside notion's env
    block — both notion-mcp and clickhouse-mcp get it). NO new IAM (reuses `agent_lambda_integrations_secret`
    GetSecretValue; ClickHouse is plain HTTP — no AWS data IAM).
- [ ] Add var `clickhouse_vpc_enabled` (bool, default false). Extend the dynamic `vpc_config` condition to
    `(each.key == "opensearch-mcp" && var.opensearch_vpc_enabled) || (each.key == "clickhouse-mcp" && var.clickhouse_vpc_enabled)`,
    and UPDATE the existing `aws_iam_role_policy.agent_lambda_vpc_eni` `count` to
    `var.agentcore_enabled && (var.opensearch_vpc_enabled || var.clickhouse_vpc_enabled) ? 1 : 0`.
- [ ] `terraform -chdir=terraform/foundation fmt` (revert out-of-scope drift) + `validate` (flag off AND
    `-var clickhouse_vpc_enabled=true`) → green.
- [ ] Commit: `feat(agent-platform): provision clickhouse-mcp Lambda + clickhouse_vpc_enabled flag (off)`.

## Manual / live steps (NOT autonomous)
1. `terraform -target` apply: clickhouse Lambda (+ VPC if `clickhouse_vpc_enabled=true`).
2. `make deploy` (Connectors multi-field UI) + `make agentcore` (clickhouse-mcp target on data gateway).
3. Connectors → ClickHouse: enter endpoint + user/password → chat (data) "ClickHouse: SELECT … last hour".
   (No live ClickHouse → code/tests only until a reachable endpoint exists; in-VPC needs the flag.)
