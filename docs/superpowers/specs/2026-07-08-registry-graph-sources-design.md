# Registry-driven graph sources — schema cache + pre-built queries + drift batch
# 레지스트리 기반 그래프 소스 — 스키마 캐시 + 사전 빌드 쿼리 + 드리프트 배치

**Status:** Approved 2026-07-08. Branch `feat/v2-graph-source-registry` (stacked on `feat/v2-trace-topology-activation`, PR #141).

## 요약 (한국어)

`class='trace'` 토폴로지가 단일 하드코딩된 ClickHouse 인스턴스/테이블에서만 span을 가져오던 구조를,
**레지스트리에 등록된 모든 datasource**(prometheus/clickhouse/mimir/loki/tempo 5종) 기반으로 일반화한다.
등록 시 스키마를 Postgres에 캐시하고(`datasource_schemas`), 그 스키마로부터 그래프 빌드용 SQL/쿼리를
**사전 생성**해 `datasource_graph_queries` 테이블에 저장한다(순수 카탈로그 매칭 우선, ClickHouse
`trace_spans`만 매칭 실패 시 게이트된 LLM fallback으로 생성). 기존 daily `datasource_index` 잡을
확장해 (a) 5종 전체로 넓히고 (b) 커넥터의 `{kind}_schema` 도구로 **라이브 재조회하여 드리프트를 감지**,
캐시/사전빌드쿼리를 갱신한다. 상세 설계·결정 근거·테스트 계획은 아래 영어 본문 참조.

## Problem

`class='trace'` topology (activated in PR #141) only pulls spans from one hardcoded default
ClickHouse instance querying a hardcoded `otel_traces` table (`web/lib/trace-source.ts`). The user
asked for this to generalize:

1. The graph build should be driven by whichever datasources are actually registered in
   `integrations`, not a single hardcoded default.
2. When a datasource is registered, its schema must be cached in Postgres, and the necessary SQL/query
   statements for graph-building must be pre-generated from that schema ahead of time — not computed
   ad hoc at rebuild time.
3. A weekly batch must re-check the schema for drift and refresh the pre-built queries.
4. This must apply uniformly across all five observability connector kinds: prometheus, clickhouse,
   mimir, loki, tempo.

## What already exists (reused, not rebuilt)

- **Schema cache on registration**: `web/app/api/datasources/manage/route.ts` POST already calls
  `warmSchemaCache()` → `${kind}_schema` connector tool → `upsertSchema()`
  (`web/lib/datasource-schema.ts`, table `datasource_schemas`, PK `(account_id, integration_id)`,
  256KB cap) → `enqueueDatasourceIndex()`. This already fires for all five kinds — the registration
  hook itself needs no code change.
- **Schema → pre-built-query precedent**: `scripts/v2/workers/datasource_index.py` +
  `diagnosis/signal_catalog.py` → `datasource_diag_signals` (ready/unavailable rows + query JSONB +
  schema-hash skip + mark-sweep). Prometheus/Mimir only today. This design clones the pattern for
  graph queries and extends the job to all five kinds.
- **Credential-blind connector invoke**: `diagnosis/sources.py:_invoke_connector` — Lambda invoke of
  `{PROJECT}-agent-{kind}-mcp` with only `instance_id`; the connector Lambda resolves the per-instance
  secret. IAM already wired behind `datasource_diagnosis_enabled`.
- **Cached schema JSONB shapes**: clickhouse `{version, tables:[{name, columns:[{name,type}]}]}`;
  prometheus/mimir `{version, metrics[], labels[]}`; loki `{version, labels[]}`; tempo `{version, tags[]}`.
- **AI chat's use of the schema cache**: `web/app/api/chat/route.ts` already calls
  `listConfiguredSchemas` + `renderSchemaForPrompt` to inject the cached schema into the external-obs
  gateway agent's context. This design keeps that cache fresher (daily drift checks across all five
  kinds instead of TTL-lazy/manual-only refresh for two), which improves chat answer quality for free
  — the chat code path itself is unchanged by this design.

## Decisions

### Per-kind graph contribution: capability-driven

Only ClickHouse (`otel_traces`) and Tempo carry span-level parent/child call data — those are the only
sources that can produce `calls`/`queries`/`runs_on` edges directly. Prometheus/Mimir can only
contribute `calls` edges when a service-graph metric exists (Istio's `istio_requests_total` or Tempo's
metrics-generator `traces_service_graph_request_total`) — otherwise they contribute nothing to the
graph (they still get a diag-signals row elsewhere, unrelated to this design). Loki (logs) cannot
derive call relationships at all; it gets a permanent `unavailable` catalog row so the "why is this
datasource contributing nothing" question is answered by data, not silence.

A per-kind, per-query-type catalog checks the cached schema for the metrics/tables that query needs
and marks that entry `ready` or `unavailable` — mirroring `signal_catalog.py` exactly, just for graph
queries instead of diagnostic ones.

### Query pre-generation: hybrid (catalog-first, LLM fallback)

The catalog above only recognizes *standard* schema shapes (the OTel exporter's default table name,
Istio's/Tempo's standard metric names). A ClickHouse instance with spans in a renamed or
differently-shaped table won't match the catalog. For that case only — v1 scope is ClickHouse
`trace_spans` — the system asks AgentCore (Bedrock + the cached schema render + a Code Interpreter
validation step) to generate a candidate query, then runs it through three checks before caching it:
a static read-only/single-statement check, an optional Code Interpreter sandbox parse+column-mapping
check (skipped if no interpreter is provisioned), and a live `LIMIT 1` dry run against the connector.
Only a query that survives all three is cached, tagged `provenance:'generated'`. Everything else
(standard schemas, Prometheus/Mimir metric-name matching, Tempo's fixed API, Loki's structural
inability) is answered deterministically by the catalog with zero LLM cost. Generation is gated behind
a new terraform flag, default off.

### Drift batch: extend the existing daily job

There is no existing weekly-cadence EventBridge rule (max today is `rate(24 hours)`, used by
`datasource_index_dispatcher`). Rather than add a new schedule, extend that dispatcher and the
`datasource_index` job it enqueues to (a) cover all five kinds instead of two, and (b) re-introspect
the datasource live inside the job (call the connector's `${kind}_schema` tool), compare against the
cached schema, and update the cache + rebuild pre-built queries only when something changed. Daily
satisfies "at least weekly" with zero new infrastructure.

## Design

### New table: `datasource_graph_queries`

```sql
CREATE TABLE IF NOT EXISTS datasource_graph_queries (
  account_id      text NOT NULL DEFAULT 'self',
  integration_id  bigint NOT NULL,
  query_key       text NOT NULL,          -- 'trace_spans' | 'servicegraph_calls'
  status          text NOT NULL CHECK (status IN ('ready','unavailable')),
  query           jsonb,                  -- ready: {tool, mapper, args_template}
  missing         jsonb,                  -- unavailable: missing schema elements
  meta            jsonb NOT NULL DEFAULT '{}',  -- {kind, provenance:'catalog'|'generated'}
  schema_version  text,
  built_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, integration_id, query_key)
);
```

A separate table rather than adding rows to `datasource_diag_signals`: that table's two consumers (the
diagnosis planner and the Explore quick-query chips) unconditionally read every row for an instance —
mixing graph rows in would force both to filter, for no shared benefit. `deleteDatasource()`'s cascade
(`web/lib/datasources.ts`) gets one more sweep statement for the new table.

### Static catalog: `scripts/v2/workers/graph_catalog.py`

Pure function `build_graph_queries(kind, schema) -> list[row]`, mirroring `signal_catalog.py`'s shape
and `CATALOG_VERSION` hash discipline:

- **clickhouse** `trace_spans`: ready when `schema.tables` contains a table matching the OTel exporter
  shape (TraceId/SpanId/ParentSpanId/ServiceName/Timestamp/Duration/SpanAttributes/ResourceAttributes
  columns). Query = `{tool:'clickhouse_query', mapper:'otel_v1', args_template:{sql: <templated SELECT
  with {window}/{cap} placeholders>}}` — the SQL currently hardcoded in `trace-source.ts` becomes this
  template. No match → hybrid-generation candidate (§ below); still no match → `unavailable`.
- **tempo** `trace_spans`: ready whenever the schema fetch succeeded (a reachable Tempo is sufficient
  capability). Query = `{tool:'tempo_search', mapper:'tempo_v1', args_template:{query:'{}', limit:20}}`.
- **prometheus/mimir** `servicegraph_calls`: ready with mapper `servicegraph_v1` if
  `traces_service_graph_request_total` is in `schema.metrics`; else mapper `istio_v1` if
  `istio_requests_total` is present; else `unavailable` with the missing metric names.
- **loki**: both query keys always `unavailable` (structural — logs carry no call-graph data).

### Job extension: `scripts/v2/workers/datasource_index.py`

1. `_KINDS` widens from `("prometheus", "mimir")` to all five.
2. New step: live re-introspection via `_invoke_connector(kind, f"{kind}_schema", integration_id)`.
   Success + schema hash differs from the cached row → update `datasource_schemas`. Failure (endpoint
   down, timeout) → keep the cached schema, note `introspect_error` in the job result — the job still
   never raises.
3. After introspection, build both diag signals (existing, prom/mimir only) and graph queries (new, all
   five kinds) via `graph_catalog.build_graph_queries()`, upserted/swept through new `db.py` helpers
   `upsert_graph_queries` / `sweep_graph_queries` (mirroring `upsert_diag_signals` / `sweep_diag_signals`).
   Each table's schema-version-hash skip is independent.
4. Graph-query building always runs (pure DB writes, no external cost). Live re-introspection only runs
   where the connector-invoke IAM is already wired (`datasource_diagnosis_enabled`).
5. `datasource_index_dispatcher.py`'s `_LIST_SQL` widens to all five kinds so every registered instance
   gets a daily job, not just Prometheus/Mimir.

### Hybrid LLM fallback: `scripts/v2/workers/graph_querygen.py` (new, gated)

Scope v1: ClickHouse `trace_spans` only — the only case where a *non-standard* schema shape is
plausible (Prometheus/Mimir metric names are either the standard name or absent; Tempo's API is fixed;
Loki structurally cannot help).

- Trigger: catalog mismatch, a plausible candidate table exists (one with TraceId/SpanId/ParentSpanId-
  shaped columns), and `GRAPH_QUERYGEN_ENABLED=true` (new env, default false).
- Generation: Bedrock `InvokeModel` (Haiku 4.5) with the cached schema rendered via the existing
  `renderSchemaForPrompt`-equivalent plus a fixed mapping contract, asking for one SELECT statement.
- Validation, in order: (a) static read-only/single-statement guard (reject multi-statement, DDL, or
  non-SELECT); (b) Code Interpreter sandbox check — if an interpreter is provisioned (SSM
  `interpreter_id` present), parse the SQL and assert the required output columns are referenced; skip
  this step entirely if no interpreter is configured; (c) a live `LIMIT 1` dry run through
  `clickhouse_query`, checking the returned columns match what the `otel_v1` mapper needs.
- Pass → cache as `ready`, `meta.provenance='generated'`. Any failure → `unavailable` with the reason in
  `missing`. Because the row is keyed to `schema_version`, regeneration only happens when the schema
  actually changes — no recurring LLM cost from the daily/weekly cadence.
- terraform: `workers.tf`'s `datasource_index` Lambda gets `GRAPH_QUERYGEN_ENABLED` env + Bedrock/
  AgentCore invoke IAM behind a new flag `graph_querygen_enabled` (default false), following the
  existing `concat(base, [], var.X ? [...] : [])` gate convention — off means byte-identical plan.

### Web: registry-driven multi-source rebuild

- `web/lib/graph-sources.ts` (new): `loadGraphSources(pool)` reads `datasource_graph_queries` `ready`
  rows and returns adapters keyed by `mapper`:
  - `otel_v1` → `ClickHouseOtelTraceSource`, parameterized by instance id + the SQL template (replacing
    the current hardcoded-table, default-instance-only class).
  - `tempo_v1` → new `TempoTraceSource` in `trace-source.ts`: `tempo_search` (limit 20) then per-trace
    `tempo_get_trace` (bounded ≤20 calls) mapped to `TraceSpan[]`.
  - `servicegraph_v1`/`istio_v1` → new `MetricsCallsSource`: an instant PromQL query returning
    `[{client, server, count}]` pairs — not spans, a direct edge-count source.
- `graph-store.ts`'s `rebuildTraceGraph` takes both `TraceSource[]` (unioned into the existing span
  aggregation) and `MetricsCallsSource[]` (merged into the same `calls` edge count map before confidence
  normalization) — nodes merge naturally since every source shares the `svc:` id namespace.
- Both call sites — `web/instrumentation.ts` and `scripts/v2/graph-rebuild.mjs` — switch from
  constructing `ClickHouseOtelTraceSource` directly to `loadGraphSources(pool)`. If no `ready` rows
  exist yet (fresh environment, job hasn't run), fall back to the old default-clickhouse-instance
  behavior so nothing regresses before the first daily job runs.

## Testing

- `graph_catalog.py`: table-driven tests over kind × (standard schema / non-standard / empty) → the
  right ready/unavailable/query shape. Pure function, same style as `test_signal_catalog.py`.
- `graph_querygen.py`: each validation stage's rejection path (multi-statement, DDL, column mismatch) —
  Bedrock and Code Interpreter calls stubbed.
- `datasource_index.py`: drift hash comparison (changed / unchanged / introspection-failure fallback) —
  extends the existing `test_datasource_index.py` FakeConn pattern.
- `web/lib/graph-sources.test.ts` (new): mapper → adapter construction, empty-ready-rows fallback.
- `trace-source.ts`: `TempoTraceSource` mapping fixtures; `ClickHouseOtelTraceSource` template
  substitution.
- `graph-store-trace.test.ts`: metrics-sourced `calls` edges merging into the existing count/confidence
  normalization.

## Verification

1. `cd web && npx vitest run` all green; worker `pytest` all green.
2. Apply the new migration via `migrate.mjs`; confirm the table exists.
3. Register a test datasource of each kind → confirm a `datasource_schemas` row and a
   `datasource_graph_queries` row (ready or unavailable, as expected for that kind) appear.
4. Manual `npx tsx ../scripts/v2/graph-rebuild.mjs` → `/api/graph?class=trace` shows nodes/edges;
   `/topology/services` renders.
5. Simulate drift (alter a test instance's schema) → manually enqueue `datasource_index` → confirm
   `datasource_schemas.fetched_at` advances and the query plan rebuilds.
6. `terraform plan` with `graph_querygen_enabled=false` (default) shows no changes.

## Known ceilings

- Tempo's `trace_spans` costs up to 21 Lambda invokes per rebuild per instance (1 search + ≤20
  get-trace calls) — bounded but grows with instance count. Flagged inline with a `ponytail:` comment
  at the call site.
- Prometheus/Mimir service-graph contributes `calls` edges only, never `queries`/`runs_on` — an
  intentional consequence of the capability-driven decision, not a bug.
- Generated ClickHouse queries are cached per `schema_version`, so they only regenerate on drift — no
  recurring LLM cost from the daily job. Environments without a provisioned Code Interpreter skip
  validation stage (b) entirely (documented, not silently weakened without a trace in `meta`).
