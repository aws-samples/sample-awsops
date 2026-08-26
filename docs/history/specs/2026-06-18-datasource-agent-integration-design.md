# Design: Datasource-aware AI chat + AI diagnosis (multi-instance, read-only, credential-safe)

- **Date:** 2026-06-18
- **Branch:** `feat/v2-architecture-design`
- **Status:** Proposed (owner approval gate before implementation)
- **Scope:** Both consumers — the AgentCore chat agent (`agent/agent.py` via `web/app/api/chat/route.ts`) and the AI diagnosis worker (`scripts/v2/workers/diagnosis/`) — can use **attached datasource instances** (Prometheus / Mimir / Loki / Tempo / ClickHouse) to diagnose, **read-only**, with **no plaintext credentials in any agent payload**, **SSRF-safe**, and **cost/OOM-bounded**.
- **ADR alignment:** ADR-039 (Integrations axis, egress READ), ADR-041 §2 (external DATA read permitted under governance; §1 AWS-resource mutation + autonomy stay frozen), ADR-040 (external DATA *write* governance — explicitly out of scope here).

---

## 1. Problem

A "datasource" is an `integrations` row (`direction=egress`, `capability=read`, `kind ∈ {prometheus,mimir,loki,tempo,clickhouse}`) with an `endpoint` + `ds_auth_type` (`none|basic|bearer|custom_header`). The original v1 motivation for the datasource route was to let the **agent diagnose using open datasources**. Today neither consumer can do this well:

- **Chat** can reach connectors only as **AgentCore gateway targets**, which carry **no `conn_config`** → the connector falls back to the kind-mirror = **default instance only**. Multi-instance is unaddressable, and the agent cannot pre-ground answers in live results.
- **Diagnosis** (`scripts/v2/workers/diagnosis/sources.py::collect_all`) is **AWS-native only** — zero datasource references. The worker has neither `lambda:InvokeFunction` on the connector Lambdas nor read on the integrations secret.

Owner directive: **both consumers must query attached (multi-instance) datasources**, schema-first and token-efficient — introspect+cache, then write narrow, aggregated, schema-aware queries and summarize before the LLM.

---

## 2. The two planes that exist today

| Plane | Caller | conn_config | Multi-instance | SSRF chokepoint | Status |
|-------|--------|-------------|----------------|-----------------|--------|
| **DIRECT** | BFF → `lambda.invoke(awsops-v2-agent-{kind}-mcp)` (`web/lib/mcp-lambda-invoke.ts`) | **inline** (`_REQUEST_CONN` precedence, `datasource_http.py:178-185`) | **yes** | connector Lambda `assert_host_allowed` | LIVE (Explore page, `/api/datasources/{query,test}`) |
| **GATEWAY** | chat agent → AgentCore gateway target | **none** | **no** (kind-mirror default) | connector Lambda | LIVE (targets READY) |

**Decision:** build both consumers on the **DIRECT plane**, but with a **credential-blind variant** so the worker never holds plaintext creds. The gateway plane stays in place for agent drill-down on the default instance.

---

## 3. Chosen mechanism

### 3.A Diagnosis worker — `collect_datasources(conn)` (the real net-new work)

Add one fail-soft, schema-first collector to `scripts/v2/workers/diagnosis/sources.py::collect_all` (registered **after** `collect_service_map` so it can read those edges). It returns the uniform `{key:'datasources_obs', ok, degraded, notes, data}` and **never raises**.

Flow:
1. **Account-scoped schema read (cache-first, no live introspection on hot path).** Read `datasource_schemas WHERE account_id = :acct` over the worker's existing pg8000 conn. **Account-key resolution is explicit** (see §8 — the worker must use the *same* key the BFF wrote under, not blindly trust `AWS_ACCOUNT_ID`). The per-instance cache rows (keyed `(account_id, integration_id)`) are the **authoritative per-account instance ownership model** (because `integrations` is GLOBAL — no `account_id` column).
2. **Instance discovery is credential-blind.** Read **only** non-secret columns from `integrations` (`id, kind, is_default, enabled, name, endpoint IS NOT NULL`). The worker **never** calls `getCredentialById`, **never** reads the integrations secret.
3. **Schema-aware query plan** derived from cached metric/label/table NAMES joined against AWS targets already collected (high-error `service_map` edges, low-CPU instances from `cw_metrics`, `inventory` resource ids) — **not** a hardcoded metric list. Reuses the deterministic `_max_error_rate` invariant (`invariants.py`) parameterized by schema-discovered series (no new invariant branch).
4. **Invoke the connector Lambda credential-blind:** `boto3 lambda.invoke(FunctionName="awsops-v2-agent-{kind}-mcp", Payload={tool_name, arguments:{...,instance_id}})`. **No `conn_config`** is ever sent by the worker. The connector resolves `map[str(instance_id)] ?? map[kind]` server-side.
5. **Structural summarize-before-LLM** (the bound is in the collector — see §7): reduce each connector response to scalars / top-N / templated-counts. **Never** place a raw connector response, raw series, or raw log lines into `data`.
6. Declare `datasources_obs` in the `sources[]` of **at most 2–3 highest-ROI sections initially** (`network_architecture` error-rate/latency; `reliability_ha` saturation), gating a deep-only `external_signals` section behind the deep tier (Opus cost). `render_section` auto-scopes + `_redact()`s.

Runtime home stays `REGISTRY['report']=('_report','fargate')` (cpu 1024 / mem 4096) — OOM-safe, conn always closed.

### 3.B Chat — `web/lib/datasource-prefetch.ts` (BFF-orchestrated, best-effort, default-only)

A new BFF orchestrator called on the `obs()` branch of `web/app/api/chat/route.ts`, **before** `invokeAgent`. It:
1. Enumerates instances from the **account-scoped** `listConfiguredSchemas(currentAccountId())` (NOT the unscoped `listDatasources()`), mapped back to global `integrations` rows by `integration_id`. Only instances with an account-scoped cache row are queryable.
2. **Default instance per kind only** for the inline prefetch (≤ number-of-obs-kinds invokes). Multi-instance fan-out in chat is **deferred** (§9).
3. For the chosen instance, resolves creds with `getCredentialById(id, kind)` (web process already holds the secret) and calls `invokeMcpLambdaTool({kind, tool, args:{narrow aggregated query, small window}, connConfig})`. `connConfig` (inline plaintext) rides **only the BFF→Lambda invoke** — never the agent payload.
4. Summarizes each result to top-N/aggregate scalars and assembles `schema + results` through a **single hard cap** (`.slice(0, RESULTS_CAP=8000)`, results pre-truncated to ~2000 chars so schema is never fully evicted).
5. **Strict best-effort budget:** whole-prefetch `Promise.race` against a single 2–3s deadline, `Promise.allSettled` so one hang can't block; on any timeout/error → **drop the results block and proceed with schema-only context** (today's behavior); the SSE stream never stalls.
6. In the fan-out branch, build the bounded results block **once** and reuse it across the ≤3 gateways.

**No `agent.py` change, no gateway tool-schema change, no new HTTP-MCP endpoint** for the chosen scope.

### 3.C Connect-time schema + version capture (populates the cache the hot paths read)

§3.A and §3.B both **READ** `datasource_schemas` and never introspect on their hot path. Today that cache is filled **only** by the manual "Refresh schema" POST (or the backfill script) — so a freshly added datasource is invisible to both consumers until an admin remembers to refresh, and **no version is captured anywhere** (`{kind}_schema` returns names only; `health` returns `{ok, latency_ms}` — `datasource_http.py:149`). The owner flagged this against the ADR-011 / connector-spec "schema-first" intent. Fix:

1. **Introspect at connect (best-effort, non-blocking).** On **create** (`web/app/api/datasources/manage/route.ts` POST) and on a **successful Test** (`/api/datasources/test`), fire-and-forget an introspection on the trusted BFF DIRECT plane — `invokeMcpLambdaTool({kind, tool:`${kind}_schema`, connConfig})` → `upsertSchema(currentAccountId(), id, kind, schema)` — **after** the 201/200 is returned (`.catch` logs `error.name` only). Create/Test latency is unchanged; a failure leaves the row usable with manual Refresh as the fallback. This is the SAME cold admin path as the schema route — **never** the diagnosis/chat hot path, so §7.6 holds.
2. **Version is captured inside `${kind}_schema`** (read-only, best-effort): prometheus/mimir `GET /api/v1/status/buildinfo`→`data.version`; clickhouse `SELECT version()`; loki `GET /loki/api/v1/status/buildinfo`; tempo `GET /api/status/buildinfo`. A missing/erroring buildinfo yields `version:null` and never fails the schema fetch. The connector returns `{version, metrics|tables|labels, …}`.
3. **The cache row carries the version.** `datasource_schemas.schema` JSONB already holds arbitrary shape; surface it via `CachedSchema.version` (`web/lib/datasource-schema.ts` mapRow reads `schema.version`), and `summarize()` exposes it (value, not a count).
4. **Version-aware querying.** Both the chat schema block (`renderDatasourceSchemaContext` in `chat/route.ts`) and the diag collector inject the captured version into the schema text ("Prometheus v3.1.0", "ClickHouse 24.3") so the model writes version-appropriate DSL; the diag collector's fixed templates branch **only** where a query is known to be version-divergent (kept minimal — names come from the cache, version informs syntax).

This closes the two owner-flagged gaps (no connect-time store; no version) with **no** hot-path introspection and **no** new write capability.

---

## 4. Multi-instance handling

- **Diagnosis: FULLY honored.** The credential-blind connector resolution (`load_datasource(slug, instance_id)`) selects any instance by id. Default scope = `is_default + enabled` per kind; **hard cap ≤3 instances/kind and a total connector-invoke cap per report**; "all enabled" is a deep-tier opt-in only. The instance set actually queried is recorded in the collector `notes` for reproducibility. Instances with **no cache row** are skipped with an explicit per-instance note ("instance X: no cached schema; run Refresh schema") — never silently dropped.
- **Chat: default-instance-only (Phase 1).** Preserves today's documented invariant (chat schema injection + gateway tools both resolve the default via the kind-mirror). The prefetch results block is labeled with the instance name and a note that agent gateway drill-down tools resolve the **default** instance only — so the agent does not silently mix instances. Full per-account multi-instance chat is **Phase 2** (§9), and requires the account-scoped enumeration in §3.B(1) plus the same connector `instance_id` path.

---

## 5. Credential model

- **No plaintext creds in any AgentCore agent payload** (ADR-039 Q3=B preserved). The agent never connects to a datasource in this design.
- **Diagnosis worker is CREDENTIAL-BLIND (mandatory, not "preferred").** It passes only `{datasource_id, kind, tool, arguments}`; the connector resolves `map[str(instance_id)] ?? map[kind]` from the SM map it already reads (`agent_lambda` role, `ai.tf:214`). The worker IAM grant is **`lambda:InvokeFunction` on the 5 connector Lambdas only** — **NO** `GetSecretValue` on the integrations secret. (Resolves adversarial critical #1, critical #2, major #4.)
- The connector `instance_id` path is a **pure function argument** (`load_datasource(SLUG, instance_id=args.get('instance_id'))`) — **no module-global state**, no second request-scoped global. (Resolves minor warm-container bleed.)
- The connector tool handlers **must NOT honor an inline `conn_config` from the worker invoke**; the worker simply never sends one. Inline `conn_config` remains valid **only** on the trusted BFF path.
- **Chat prefetch** (web process) builds inline `connConfig` from `getCredentialById` — same sanctioned DIRECT pattern as `/api/datasources/query`. **Contract:** the prefetch must NEVER place `connConfig` (or any field of it) into `datasourceSchemaContext`, error notes, or logs — only bounded RESULT rows. Catch blocks log `error.name` only.
- **Worker fail-soft never leaks creds:** the `except` branch emits a FIXED safe note (`datasource <kind>#<id> query failed: <error-class>`) and MUST NOT serialize `conn_config`/cred fields.
- **Defense-in-depth redaction:** extend `report.py::_REDACTORS` with token/password shapes (`Bearer <token>`, `password`/`token` JSON keys) so a future careless path is still scrubbed before Bedrock.

---

## 6. SSRF & network

The connector Lambda (`agent/lambda/datasource_http.py`) is the **single egress chokepoint**; both planes route through it (never raw sockets). **Corrections to prior inaccurate framing** and required hardening:

1. **NOT https-only.** `assert_host_allowed` allows **http and https** (`datasource_http.py:68-69`); in-cluster targets are often plain HTTP. The real controls are: always-block metadata (`169.254.169.254` / `fd00:ec2::254`) + loopback/link-local/multicast/reserved, resolve-and-recheck, no-redirect opener (`_NoRedirect`), and the ClickHouse `_assert_read_only` table-function guard.
2. **Add an `allow_private` opt-in (parity with `agent.py`).** Today `assert_host_allowed(endpoint, resolver=...)` allows RFC1918/ULA **unconditionally** (`datasource_http.py:64-66`) — unlike `agent.py._assert_host_allowed(url, allow_private, ...)`. Because the diagnosis worker fires this path **autonomously and high-frequency**, this is a confused-deputy vector against Aurora / the internal ALB. **Fix:** change the signature to `assert_host_allowed(endpoint, allow_private=False, resolver=...)`, block RFC1918/ULA unless the per-instance row opts in (new `ds_allow_private` column / reuse `integrations.allowPrivate` semantic threaded through). Default false; public-auth datasources need no opt-in. (Resolves adversarial major SSRF #1.)
3. **Close the DNS-rebinding TOCTOU (IP-pinning — REQUIRED, not deferred).** `assert_host_allowed` resolves once, then `http_json`→`_opener.open` re-resolves independently. Because callers are now autonomous/high-frequency, pin the connection to the **vetted IP**: `assert_host_allowed` returns the vetted IP(s); `http_json` dials the pinned IP with `Host:`/SNI = original hostname (custom `HTTPConnection.connect()` override), re-running the always-block + `allow_private` check on the same `getaddrinfo` result the opener uses. (Resolves adversarial major SSRF #2.)
4. **Eliminate `_REQUEST_CONN` module-global on the hot path.** Thread `conn_config` explicitly as a parameter through `_ds()`/`load_datasource(slug, conn=None)` and the tool functions, so each invocation's connection is stack-local and cannot bleed across warm-container reuse. If `set_request_conn` is retained, wrap each `lambda_handler` in `try/finally` that always calls `set_request_conn(None)` on exit. (Resolves adversarial major SSRF #3.)
5. **Private datasource reachability** depends on the per-kind `{kind}_vpc_enabled` flag (default false → connector non-VPC, public-auth only). The Fargate worker is always in-VPC (`aws_security_group.service`, C8 reuse). The collector **preflights**: skip private-endpoint instances when the corresponding flag is known-off, with a clear "in-cluster datasource requires {kind}_vpc_enabled" note instead of a 12s hang; parallelize per-instance invokes with a strict aggregate timeout. (Resolves adversarial minor reachability.)
6. **ClickHouse exfil:** before wiring the autonomous ClickHouse path, verify `_assert_read_only` blocks `url/file/remote/remoteSecure/s3/s3Cluster/jdbc/odbc/mysql/postgresql` in nested/CTE/comment-obfuscated positions and rejects `SETTINGS`. The diag collector emits a **fixed parameterized `SELECT … GROUP BY … LIMIT`** template — never free-form SQL forwarded verbatim. (Resolves adversarial minor ClickHouse.)

The worker IAM `lambda:InvokeFunction` is **scoped to exactly the 5 connector ARNs by name** (no `function:*`) so it cannot reach the frozen remediation substrate. (Resolves adversarial minor IAM scope.)

---

## 7. Cost / OOM / token blow-up (the structural bound)

There is **no post-collect input cap** in the pipeline — `render_section` serializes `collected[key]['data']` **verbatim** (`report.py:131-135`); only OUTPUT `max_tokens` is capped (1500/2200, `report.py:38`). Connector caps (`MAX_SERIES=50×500=5000` samples; Loki/Tempo `~1MB`; ClickHouse 1000 rows) bound the **return to the worker**, NOT what reaches Bedrock. So:

1. **The collector IS the bound.** Never place raw connector responses in `data`. Per kind:
   - Prometheus/Mimir: reduce each series to `{labels-subset, last_value|rate}`, keep ≤10 series.
   - Loki: prefer an **aggregating LogQL** (`sum by (level) (count_over_time(... [1h]))` → series, not lines). If raw is unavoidable, template each line (strip timestamps, replace digit-runs/uuids/hex), `Counter`, emit top-N `{template, count}` — **discard raw `values`**. **Never** return `result[].values`.
   - Tempo: `{failing_span_count, slowest_p95_ms, top-N operation names}`.
   - ClickHouse: aggregate-only `GROUP BY … LIMIT ≤50`, project only GROUP-BY keys + aggregates (never `SELECT *`).
2. **Hard post-collect guard** in `collect_datasources`: serialize `data`, assert `len(json) <= ~8000` chars, else truncate to `{note:'datasource summary truncated', kept:...}`.
3. **Defensive per-section input cap** in `render_section`: if `len(ctx_json) > ~24000` chars (~6k tokens), truncate with `[context truncated for token budget]` **before** `_redact`/`_bedrock_render` — protects every collector, closes the long-standing gap. (Resolves adversarial critical #1 cost.)
4. **Section-count duplication priced.** `datasources_obs` input tokens are paid **once per declaring section**. Therefore: ≤1.5KB serialized per section's view; **tailor** what each section sees (network → error-rate/latency only; reliability → saturation only); start at **2–3 sections**, deep-only Opus section gated to deep tier. (Resolves adversarial major section-multiplication.)
5. **Chat prefetch cap is enforced**, not promised: single `.slice(0, RESULTS_CAP)` over the assembled `schema+results`; bounded fan-out (≤default-per-kind); reuse the block across ≤3 gateways. `MAX_PROMPT=50000` covers the user prompt only — the results cap is separate. (Resolves adversarial critical chat-cap.)
6. **Schema from CACHE, never live introspection on the hot path.** Read `datasource_schemas` from Aurora; never call `clickhouse_schema`'s per-table-DESCRIBE fan-out (up to 100 HTTP calls) from the collector. Optional Haiku name-picker is **OFF by default** and fed only cached NAMES. (Resolves adversarial major latency.)
7. **Single explicit budget** constant: `MAX_KINDS`, `MAX_INSTANCES_PER_KIND` (default is_default only), `MAX_QUERIES_PER_INSTANCE ≤3`, and a wall-clock deadline (~30s) → degrade with a "time-budget exceeded" note. Connector `HTTP_TIMEOUT=12s`; per-section Bedrock read timeout 90s. OOM → SFN-Catch → `status_updater` marks report failed without touching web.

---

## 8. Account-id correctness (cross-tenant safety)

- `datasource_schemas` is keyed `(account_id, integration_id)`; the **diag scope** is a single account (`process.env.AWS_ACCOUNT_ID`, `web/app/api/diagnosis/route.ts:43`). The cache is **written** under `currentAccountId()` (= `HOST_ACCOUNT_ID` env, falling back to `'self'`, `web/lib/account.ts:9-12`).
- **Risk:** the worker reading `WHERE account_id='123456789012'` returns **zero rows** if the BFF wrote under `'self'` → silent empty degrade. **Fix:** (a) `collect_datasources` resolves the cache key with the **same convention** the BFF used (read host-account rows AND fall back to `'self'`, or canonicalize both to one value); (b) **assert/log** when the cache read returns 0 rows while configured instances exist (key-mismatch smell); (c) **pin `HOST_ACCOUNT_ID == AWS_ACCOUNT_ID`** in `workload.tf` and document the invariant. (Resolves adversarial critical account-key.)
- **Both** `collect_datasources` and the chat prefetch **filter by the diagnosed/selected account_id** — never query `datasource_schemas`/instances account-wide. (Resolves adversarial major account-isolation.)

---

## 9. Limitations / phased

- **Phase 1 (this design):** diagnosis = **full multi-instance** (credential-blind); chat = **default-instance-only** prefetch results + existing gateway tools. This ships the owner's primary motivation (agent diagnosing using open datasources) with the smallest, safest delta.
- **Phase 2 (deferred):** **chat multi-instance.** Requires: (a) account-scoped instance enumeration from the cache (already specified in §3.B(1) so it is forward-compatible); (b) the connector `instance_id` arg path (built in Phase 1 for the worker, reused); (c) labeling/system-prompt guidance so the agent treats per-instance prefetch results as authoritative and does not re-query non-default instances via gateway tools; (d) gated behind a flag, default off. **Caveat:** editing an existing gateway tool's inputSchema does NOT auto-resync — `provision.py` detects tool-NAME drift only, so a per-instance gateway tool needs a tool rename or target delete/recreate + connector redeploy. This cost is why chat per-instance is deferred.

---

## 10. ADR compliance

- **ADR-041 §2:** querying Prometheus/Loki/Tempo/Mimir/ClickHouse for diagnosis is **external DATA READ** — permitted under governance. Zero AWS-resource mutation, non-autonomous → disjoint from §1 FROZEN.
- All five connectors are **read-only by construction** (HTTP query APIs; ClickHouse SELECT-only + table-function guard).
- **The report-to-S3 write is an AWS-native artifact write** (`diagnosis/*`), **NOT an ADR-040 external DATA write.** **Explicit non-goal:** this change adds external DATA **read** only; it adds **no** external DATA write (no Slack/Notion/Jira push). Any such write is a separate ADR-040-governed feature behind `integrations_write_enabled` (flag-OFF), out of scope. (Resolves adversarial minor ADR-040 mislabel.)
- ADR-039 Integrations axis unchanged (8 gateways; datasources stay the Integrations axis, not a 9th gateway).
- Governance preserved: SSRF guard (hardened, §6), Secrets-Manager custody (no plaintext in agent payload; credential-blind worker), DLP/redaction (`_redact` + aggregate-not-raw discipline + extended regexes), bounded queries, read needs no human-gate.

---

## 11. Files touched (summary)

**Diagnosis (A):**
- `scripts/v2/workers/diagnosis/sources.py` — NEW `collect_datasources(conn)` + register in `collect_all`.
- `scripts/v2/workers/diagnosis/sections.py` — declare `datasources_obs` in 2–3 sections (+ optional deep-only `external_signals`).
- `scripts/v2/workers/diagnosis/report.py` — defensive per-section input cap + extend `_REDACTORS`.
- `scripts/v2/workers/diagnosis/test_*.py` — tests.

**Connector Lambdas (shared by A + Phase-2 B):**
- `agent/lambda/datasource_http.py` — `assert_host_allowed(endpoint, allow_private=False)` + IP-pinning; `load_datasource(slug, instance_id=None, conn=None)` pure-arg; cache TTL/clear; do not honor worker `conn_config`.
- `agent/lambda/{prometheus,loki,tempo,mimir,clickhouse}_mcp.py` — accept optional `instance_id` arg; `try/finally` reset; ClickHouse read-only verification + fixed aggregate template.

**Chat (B):**
- `web/lib/datasource-prefetch.ts` — NEW (account-scoped, default-only, bounded, best-effort).
- `web/app/api/chat/route.ts` — call prefetch on `obs()` branch; single hard cap; fan-out reuse.
- `web/lib/mcp-lambda-invoke.ts` — reuse (optional `instance_id` pass-through).

**Terraform (controller-run apply):**
- `terraform/foundation/workers.tf` — `lambda:InvokeFunction` on the **5 named connector ARNs** for `worker_diagnosis` + `worker_lambda_diagnosis`; comment as ADR-041 §2 read-only egress.
- `terraform/foundation/ai.tf` — `ds_allow_private` thread if a new column/flag is chosen.
- `terraform/foundation/workload.tf` — pin `HOST_ACCOUNT_ID == AWS_ACCOUNT_ID`.
- `terraform/foundation/migrations/<ULID>_*.sql` — optional `integrations.ds_allow_private` column.
