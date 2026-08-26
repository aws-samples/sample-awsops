# Trace-level Topology — Implementation Plan (TDD)

Source spec: `docs/superpowers/specs/2026-06-25-trace-topology-design.md`.
Each task: write the failing test first → minimal code → refactor → commit (explicit paths).
All work is buildable/testable WITHOUT live traces (the no-op path is part of the design).

## Files in scope
- `web/lib/trace-source.ts` (new) — `TraceSpan`/`TraceSource` types + `ClickHouseOtelTraceSource`.
- `web/lib/trace-source.test.ts` (new)
- `web/lib/graph-store.ts` — add `rebuildTraceGraph` (+ bridge-ref helpers).
- `web/lib/graph-store.test.ts` — add trace-graph tests (or new `graph-store-trace.test.ts`).
- `scripts/v2/graph-rebuild.mjs` — call `rebuildTraceGraph`.
- `web/app/api/graph/route.ts` — accept/validate `class=trace` (likely already generic; add guard + test).
- `web/app/api/graph/route.test.ts` — class=trace case.
- `agent/lambda/inventory_read_mcp.py` — `get_topology` accepts `class=trace` (if it pins class).
- `agent/lambda/test_inventory_read_mcp.py` — class=trace case.
- topology page component (the `class` toggle) — add `trace`; locate exact file in Task 7.

## Tasks

- [ ] **T1 — `TraceSource` interface + types.** New `web/lib/trace-source.ts`: export `TraceSpan`
  and `TraceSource` (`available()`, `recentSpans(windowMins, cap)`). Add a `FakeTraceSource`
  test helper. Test (`web/lib/trace-source.test.ts`): the fake satisfies the contract
  (available true/false, returns the seeded spans). No graph logic yet.

- [ ] **T2 — `rebuildTraceGraph` aggregation (the core).** In `web/lib/graph-store.ts` add
  `rebuildTraceGraph(pool, source)`. Test FIRST with a `FakeTraceSource` of fixture spans
  (svc A → svc B → db postgres, with k8s attrs): assert it produces `service`/`db`/`workload`
  nodes (correct ids) + `calls`/`queries`/`runs_on` edges + `confidence` from span counts.
  Implement aggregation + write via the existing shared writer **`writeGraph(pool, 'trace',
  TRACE_LOCK, nodes, edges, runId)`** (define a new `TRACE_LOCK` advisory-lock constant alongside
  `FLOW_LOCK`/`INFRA_LOCK`; reuse the class-scoped mark-sweep — no rule duplication).

- [ ] **T2.5 — resolve the `writeGraph` empty-build guard (review MAJOR-2).** `writeGraph` has an
  empty-build guard that SKIPS the mark-sweep when a build yields 0 nodes (so a transient empty
  fetch can't wipe a live graph). That guard CONFLICTS with T3's "empty source must sweep stale
  trace rows". Test FIRST: a previously-populated `class='trace'` layer + an empty rebuild →
  stale trace rows are removed, while `flow`/`infra` are untouched AND a flow/infra empty build
  still keeps its guard. Implement option (a): add an opt-in `allowEmpty` (default `false`,
  preserving the flow/infra guard) to `writeGraph`; `rebuildTraceGraph`'s no-op path passes
  `allowEmpty: true` so an intentionally-empty trace layer sweeps. (Keeps one writer; no duplicate
  sweep logic.) This task gates T3.

- [ ] **T3 — no-op-when-empty path.** Test: `source.available()===false` → `rebuildTraceGraph`
  returns `{nodes:0,edges:0}`, throws nothing, and (via T2.5's `allowEmpty`) mark-sweeps away any
  stale `class='trace'` rows WITHOUT touching `flow`/`infra` rows (class-isolation regression
  assertion). Implement the early-return calling `writeGraph(..., {allowEmpty:true})`.

- [ ] **T4 — bridge-ref matching.** Test: given infra nodes (an RDS node with host H) + a trace
  `db` node whose host resolves to H → the `db` node gets `meta.infra_ref = <rds node id>`;
  an unmatched host → no `infra_ref` (node still present). Same shape for `workload.eks_ref`/
  `tg_ref` (best-effort; unresolved → omitted). Implement the matcher (pure function, unit-tested
  on inputs — no DB).

- [ ] **T4.5 — ClickHouse connection resolution (review CRITICAL).** There is **no
  `getDefaultDatasource('clickhouse')`** path — `web/lib/datasources.ts` is ID-based
  (`listDatasources`/`getDatasource`/`resolveConnConfig`), and the connector resolves by slug/
  instance. Before T5, decide+implement how `ClickHouseOtelTraceSource` (node context, run from
  `graph-rebuild.mjs`) obtains its connection: resolve the **default instance for kind=clickhouse**
  the SAME way the chat schema-injection already does (`listDatasources()` → filter `kind==='clickhouse'
  && isDefault` → `resolveConnConfig(id)`); expose a small `getDefaultDatasource(kind)` helper in
  `datasources.ts` if one doesn't exist. `available()` returns false when there is no default
  clickhouse instance. Test FIRST: default present → connConfig resolved; none → `available()` false.
  (Also accept an explicit `instanceId` override for multi-instance.)

- [ ] **T5 — `ClickHouseOtelTraceSource` adapter.** NOTE (review MINOR-1): the OTel ClickHouse
  exporter's `otel_traces` stores attributes in **`Map(LowCardinality(String), String)` columns**
  (`ResourceAttributes`, `SpanAttributes`), NOT flat columns — plus top-level `Timestamp`,
  `Duration`, `TraceId`, `SpanId`, `ParentSpanId`, `ServiceName`, `SpanKind`. The adapter extracts
  `service` from `ServiceName` (or `ResourceAttributes['service.name']`), `dbSystem` from
  `SpanAttributes['db.system']`, `k8sNamespace/Pod/Deployment` from
  `ResourceAttributes['k8s.namespace.name'|'k8s.pod.name'|'k8s.deployment.name']`. Test FIRST: a
  fixture row in the **real nested-map shape** → correct `TraceSpan` mapping; `available()` false
  when no ClickHouse datasource / `otel_traces` absent. Implement via the existing connector path
  (read-only SELECT, SSRF-guarded credential reuse). Bounded by `recentSpans(window, cap)`.

- [ ] **T6 — wire into `graph-rebuild.mjs`.** Add the `rebuildTraceGraph` call after flow/infra
  (constructing the default `ClickHouseOtelTraceSource`); log `trace: N nodes, M edges`. Test:
  the runner invokes all three rebuilds (extend the existing runner test if present, else a
  focused assertion).

- [ ] **T7 — expose `class='trace'` on the read paths + UI toggle.**
  (a) **(review MAJOR-1)** `/api/graph` currently selects class via a ternary that **silently
  falls back to `flow` for any unknown value** — an unvalidated `class=trace` would return the
  WRONG layer. Replace the ternary with an explicit allow-list (`flow` | `infra` | `trace`, plus
  any existing key) → **400 on unknown class**, and include `trace`. Test FIRST: `class=trace` →
  trace layer; `class=bogus` → 400 (not a silent flow).
  (b) **(review MINOR-2)** `get_topology` in `inventory_read_mcp.py` calls `_fetch_topology_graph`
  (confirmed present) — read it, then add `trace` to its allowed class set the same way (allow-list
  + reject unknown). + python test for `class=trace`.
  (c) Locate the topology page's class toggle component and add a `trace` ("Service / Traces")
  option (additive; test if the page has one). Each sub-part is its own commit if independent.

- [ ] **T8 — docs.** Update root `CLAUDE.md` Key Files + the `docs/.../reference` topology note to
  mention the `trace` layer (one-liner each). Run `/co-agent sync-context` is a follow-up, not here.

## Verification
- `cd web && npx vitest run` green for all new/changed web tests.
- `cd agent && python3 -m pytest test_inventory_read_mcp.py -q` green.
- `next build` compiles (no app-level type error).
- Manual: `rebuildTraceGraph` with an empty source is a clean no-op; `/api/graph?class=trace`
  returns an empty graph (until traces exist).

## Out of scope (per spec YAGNI)
Datadog adapter (interface only), otel collector/pipeline work, pod-granularity beyond k8s attrs,
topology UI redesign beyond the toggle option.
