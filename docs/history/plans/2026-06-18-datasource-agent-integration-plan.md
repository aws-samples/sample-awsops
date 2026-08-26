# Implementation Plan: Datasource-aware AI chat + AI diagnosis (multi-instance, read-only, credential-safe)

- **Date:** 2026-06-18
- **Branch:** `feat/v2-architecture-design`
- **Spec:** `docs/superpowers/specs/2026-06-18-datasource-agent-integration-design.md`
- **Method:** TDD. Each task: write/extend test → implement → run → **commit**. Small units (CLAUDE.md: commit-in-small-units; concurrent sessions switch branches).
- **Phasing:** A = diagnosis collector (full multi-instance). B = chat live-query (default-instance-only, Phase 1). C = connector/SSRF hardening shared by both. Phase-2 chat multi-instance is OUT of scope here.

**Legend:** 🔧 = controller/user-run shared-infra `terraform apply` (no `-auto-approve`; long applies run by controller). 🤖 = `make agentcore`/connector Lambda redeploy (controller/user-run). All other tasks are agent-runnable.

---

## C. Connector + SSRF hardening (do FIRST — shared substrate)

- [ ] **C1.** Test: `agent/lambda/test_datasource_http.py::test_assert_host_allowed_blocks_private_without_optin` — RFC1918/ULA blocked unless `allow_private=True`; metadata/loopback always blocked. Commit: `test(datasource): SSRF allow_private opt-in spec`.
- [ ] **C2.** Implement `assert_host_allowed(endpoint, allow_private=False, resolver=...)` in `agent/lambda/datasource_http.py`; block RFC1918/ULA unless opt-in (reuse agent.py `_ip_is_private`). Run C1. Commit: `feat(datasource): SSRF allow_private opt-in (agent.py parity)`.
- [ ] **C3.** Test: `test_datasource_http.py::test_http_json_pins_resolved_ip` — DNS-rebinding (resolution #1 public, #2 internal) is defeated; connection dials the vetted IP with Host/SNI = hostname. Commit: `test(datasource): IP-pinning TOCTOU`.
- [ ] **C4.** Implement IP-pinning in `datasource_http.py`: `assert_host_allowed` returns vetted IP(s); `http_json` dials pinned IP (custom `HTTPConnection.connect()` override), re-running always-block + `allow_private` on the shared `getaddrinfo`. Run C3. Commit: `fix(datasource): pin vetted IP to close DNS-rebinding window`.
- [ ] **C5.** Test: `test_datasource_http.py::test_load_datasource_instance_id_pure_arg` + `::test_warm_container_no_bleed` — `load_datasource(slug, instance_id=N)` returns `map[str(N)] ?? map[slug]`; a subsequent no-instance_id/no-conn_config invoke resolves the kind-mirror (no bleed). Commit: `test(datasource): per-instance pure-arg + warm-container reset`.
- [ ] **C6.** Implement `load_datasource(slug, instance_id=None, conn=None)` as a pure-arg path (no new module-global); thread `conn`/`instance_id` explicitly; add short TTL (60s) or top-of-handler clear for `_SECRET_CACHE` on the instance_id path. Run C5. Commit: `feat(datasource): per-instance resolution (pure arg) + bounded secret cache`.
- [ ] **C7.** Thread optional `instance_id` arg through `agent/lambda/{prometheus,loki,tempo,mimir,clickhouse}_mcp.py`; wrap each `lambda_handler` in `try/finally` calling `set_request_conn(None)`; ensure the worker invoke path **ignores** inline `conn_config` (only `arguments.instance_id`). Test per connector. Commit: `feat(datasource): connectors accept instance_id; guaranteed conn reset`.
- [ ] **C8.** Test + harden `clickhouse_mcp.py::_assert_read_only` — block `url/file/remote/remoteSecure/s3/s3Cluster/jdbc/odbc/mysql/postgresql` in nested/CTE/comment-obfuscated positions; reject `SETTINGS`. Commit: `fix(datasource): clickhouse read-only guard covers obfuscated table functions`.
- [ ] **C8b.** Test + implement version capture in each `{kind}_schema` (read-only, best-effort): prometheus/mimir `GET /api/v1/status/buildinfo`→`data.version`; clickhouse `SELECT version()`; loki `GET /loki/api/v1/status/buildinfo`; tempo `GET /api/status/buildinfo`. buildinfo failure → `version:null`, schema fetch still returns names. Return `{version, …existing}`. Test per connector (`test_{kind}_mcp.py::test_schema_includes_version` + buildinfo-down still returns names). Commit: `feat(datasource): {kind}_schema captures server version (best-effort)`.
- [ ] **C9.** 🔧 + 🤖 **Controller/user:** redeploy the 5 connector Lambdas (code change — incl. C8b version capture) via the connector deploy path, then `make agentcore` if any tool schema is touched (it is not for Phase 1 — `instance_id` is only read from `arguments`, no inputSchema change needed for the worker path). Verify each Lambda updated.

---

## A. Diagnosis collector (full multi-instance, credential-blind)

- [ ] **A1.** 🔧 **Controller/user:** add to `terraform/foundation/workers.tf` an `lambda:InvokeFunction` statement **scoped to the 5 named ARNs** (`arn:aws:lambda:<region>:<acct>:function:awsops-v2-agent-{prometheus,loki,tempo,mimir,clickhouse}-mcp`, no `function:*`) on `worker_diagnosis` + `worker_lambda_diagnosis`; comment "ADR-041 §2 read-only external DATA egress; disjoint from frozen remediation substrate". **NO** `GetSecretValue` on the integrations secret. Pin `HOST_ACCOUNT_ID == AWS_ACCOUNT_ID` in `workload.tf`. `plan -out tfplan` → controller `apply tfplan`. Keep `integrations_enabled` + `{kind}_vpc_enabled` persisted in `terraform.tfvars`.
- [ ] **A2.** Test: `scripts/v2/workers/diagnosis/test_datasources.py::test_collector_never_raises` — connector error → `{ok, degraded:True}` with a FIXED safe note (no conn_config/cred in note). Commit: `test(diagnosis): datasource collector fail-soft, no cred leak`.
- [ ] **A3.** Test: `::test_account_scoped_cache_read` + `::test_cache_key_resolution` — reads `datasource_schemas WHERE account_id = :acct` using the BFF write convention (host-account ∪ 'self'); 0-rows-but-configured logs a key-mismatch smell. Commit: `test(diagnosis): account-scoped schema cache read + key-mismatch detection`.
- [ ] **A4.** Test: `::test_credential_blind_invoke` — collector passes `{datasource_id, kind, tool, arguments}` only; asserts **no** `conn_config` in the lambda.invoke payload; assert worker role has no integrations-secret read (policy fixture). Commit: `test(diagnosis): credential-blind connector invoke`.
- [ ] **A5.** Test: `::test_summarize_bound` — Prometheus ≤10 series scalars; Loki templated counts only (no `values`); Tempo span counts; ClickHouse aggregate-only; post-collect `len(json(data)) <= 8000` truncation marker. Commit: `test(diagnosis): structural summarize-before-LLM bound`.
- [ ] **A6.** Test: `::test_budget_and_caps` — `MAX_INSTANCES_PER_KIND` (default is_default only, ≤3), `MAX_QUERIES_PER_INSTANCE ≤3`, wall-clock deadline → "time-budget exceeded" note; instances with no cache row → explicit skip note; private-endpoint instance with `{kind}_vpc_enabled` off → preflight skip note. Commit: `test(diagnosis): datasource fan-out budget + reachability preflight`.
- [ ] **A7.** Implement `collect_datasources(conn)` in `scripts/v2/workers/diagnosis/sources.py` (instance discovery reads ONLY non-secret `integrations` columns; schema-aware query plan from cache joined to `service_map`/`cw_metrics`/`inventory`; credential-blind invoke; structural summarize; budget/preflight; never raises). Register in `collect_all` after `collect_service_map`. Run A2–A6. Commit: `feat(diagnosis): schema-driven multi-instance datasource collector`.
- [ ] **A8.** Implement defensive per-section input cap + extend `_REDACTORS` (Bearer/password/token shapes) in `scripts/v2/workers/diagnosis/report.py`. Test: `test_report.py::test_section_input_cap` + `::test_redact_token_shapes`. Commit: `fix(diagnosis): per-section input-token cap + token/password redaction`.
- [ ] **A9.** Declare `datasources_obs` in `sections.py` for `network_architecture` (error-rate/latency view) + `reliability_ha` (saturation view); add deep-only `external_signals` section gated to deep tier. Reuse `_max_error_rate` invariant parameterized by schema-discovered series. Test: `test_invariants.py` external error-rate verdict; `test_sections.py` declaration. Commit: `feat(diagnosis): wire datasources_obs into 2-3 sections + deep external_signals`.
- [ ] **A10.** 🤖 **Controller/user:** `make workers` (rebuild+push arm64 worker image with the new collector). Then trigger a diagnosis report and verify the datasource section renders (or degrades cleanly with a note). 🔧 not required beyond A1.

---

## B. Chat live-query prefetch (default-instance-only, Phase 1)

- [ ] **B1.** Test: `web/lib/__tests__/datasource-prefetch.test.ts::test_account_scoped_enumeration` — enumerates from `listConfiguredSchemas(currentAccountId())` mapped to `integrations` by `integration_id`; never `listDatasources()` unscoped. Commit: `test(chat): account-scoped datasource enumeration`.
- [ ] **B2.** Test: `::test_default_instance_only` + `::test_no_cred_in_context` — queries default per kind only; `connConfig` never appears in returned context/notes; catch logs `error.name` only. Commit: `test(chat): default-only prefetch, no cred leak`.
- [ ] **B3.** Test: `::test_best_effort_budget` — single 2-3s `Promise.race` deadline, `allSettled`; on timeout/error returns schema-only (results block dropped). Commit: `test(chat): bounded best-effort prefetch never stalls SSE`.
- [ ] **B4.** Test: `::test_results_cap` — assembled `schema+results` passes through single `.slice(0, RESULTS_CAP=8000)`; results block pre-truncated ~2000. Commit: `test(chat): enforced results cap`.
- [ ] **B5.** Implement `web/lib/datasource-prefetch.ts` (enumerate account-scoped → default per kind → `getCredentialById` → `invokeMcpLambdaTool` narrow aggregated query → summarize top-N → single hard cap). Run B1–B4. Commit: `feat(chat): BFF datasource live-results prefetch (default-only, bounded)`.
- [ ] **B6.** Wire into `web/app/api/chat/route.ts` `obs()` branch: append bounded results block to `datasourceSchemaContext` via the single cap; build the block ONCE and reuse across ≤3 fan-out gateways; label each result with instance name + "gateway drill-down resolves default instance only" note. Test: route-level test that fan-out reuses one block. Commit: `feat(chat): inject bounded live datasource results on obs branch`.
- [ ] **B7.** `make deploy` (web) — controller/user or autonomous per owner policy; smoke `/api/health`; verify a monitoring-gateway chat turn shows a bounded live-results block and never stalls. (No 🔧, no 🤖.)

---

## D. Connect-time auto-introspect + version-aware schema (owner-flagged §3.C — fills the cache the hot paths read)

- [ ] **D1.** Test: `web/lib/datasource-schema.test.ts::test_version_surfaced` — `mapRow`/`CachedSchema` exposes `version` from `schema.version`; `summarize()` returns the version value (not a count). Implement in `web/lib/datasource-schema.ts`. Commit: `feat(datasource): surface cached schema version`.
- [ ] **D2.** Test: `web/app/api/datasources/manage/route.test.ts::test_create_fires_best_effort_introspect` — POST create returns 201 independent of introspection; an introspection throw does NOT fail create; `error.name`-only log (no cred). Implement fire-and-forget `invokeMcpLambdaTool({kind, tool:`${kind}_schema`, connConfig}) → upsertSchema(currentAccountId(), id, kind, schema)` AFTER the 201 in `manage/route.ts` POST. Commit: `feat(datasource): auto-introspect schema+version on create (fire-and-forget)`.
- [ ] **D3.** Test + wire the same best-effort introspect on a successful `/api/datasources/test` (warms the cache for an existing instance pre-save). Commit: `feat(datasource): warm schema cache on successful Test`.
- [ ] **D4.** Inject the captured version into the agent schema text: extend `renderDatasourceSchemaContext` (chat/route.ts) AND the diag collector schema block to prefix each datasource with its version. Tests: `chat/route.test.ts` version in extraContext; diag `test_datasources.py::test_version_in_query_context`. Commit: `feat(datasource): version-aware schema block for chat + diagnosis`.
- [ ] **D5.** In `collect_datasources`, branch the ≤3 fixed query templates ONLY where version-divergent (document which); default to the broadest-compatible form when version is null. Test: `test_datasources.py::test_version_divergent_template`. Commit: `feat(diagnosis): version-aware query templates (minimal branch)`.

(D rides existing controller steps: connector version capture = C8b → redeployed by C9; D2/D3 web → B7 deploy; D4/D5 diag side → A10 `make workers`.)

---

## Controller/user-run gate summary
- **🔧 terraform apply (shared infra):** A1 (worker IAM scoped invoke + `HOST_ACCOUNT_ID` pin; optional `ds_allow_private` migration/`ai.tf` thread). Long apply, no `-auto-approve`, `apply tfplan`.
- **🤖 connector Lambda redeploy:** C9 (5 connector Lambdas code change). `make agentcore` only if a tool inputSchema changes (NOT required for Phase 1 worker path).
- **🤖 worker image:** A10 (`make workers`).
- **deploy:** B7 (`make deploy`, web) — agent-runnable per owner "dev니까 배포까지 자율수행" or controller.

## Task count
- **C (shared hardening):** 10 (C8b version capture added; C9 is controller/user).
- **A (diagnosis):** 10 (A1 controller 🔧, A10 controller 🤖).
- **B (chat):** 7.
- **D (connect-time introspect + version):** 5 (rides C9/B7/A10 — no new controller step).
- **Total:** 32 tasks; 3 require controller-run apply/agentcore/worker steps (A1, C9, A10), plus B7 deploy.
