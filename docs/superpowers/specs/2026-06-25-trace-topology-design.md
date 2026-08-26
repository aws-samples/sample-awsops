# Trace-level Topology (service axis, `class='trace'`) — Design

**Date:** 2026-06-25 · **Status:** Approved (brainstorm) · **Branch:** feat/v2-architecture-design

## Goal
Extend the v2 topology from infra-level (CF→LB→TG→DB) to an **application/trace level**: a
service call-graph derived from distributed-trace data (ClickHouse otel traces first; Datadog APM
later) that reaches from **inside an EKS pod → service → service → DB**. Prepare it now so that the
moment the tracing pipeline lands spans, the graph populates with **no further code change**
(tracing is not yet complete).

## Non-goals (YAGNI)
- Datadog adapter implementation (define the interface only).
- Pod granularity beyond what otel `k8s.*` resource attributes already provide.
- Topology-page UI redesign beyond adding a `trace` layer to the existing class toggle.
- Physically merging the trace graph into the flow/infra classes (kept as separate linked layers).
- Live ClickHouse otel pipeline / collector work (out of scope — this consumes traces, not produces).

## Decisions (from brainstorm)
1. **Graph model = service call-graph (APM service map).** Nodes = services + DBs (+ workloads
   from k8s attrs); edges = trace span parent→child calls and DB-client spans.
2. **Storage = a new `class='trace'` layer** in the existing `topology_nodes`/`topology_edges`
   tables — same pattern as `flow`/`infra` (class in node PK + edge UNIQUE; mark-sweep per class).
   Reuses `/api/graph`, `get_topology` (inventory_read MCP), and the topology page (all already
   class-parameterized). Bridge to other layers via cross-class refs in node `meta` (NOT a merge).
3. **Source = ClickHouse otel first, behind a pluggable `TraceSource` interface.** Datadog APM is a
   future adapter.
4. **Pod↔service mapping = otel resource attributes** (`k8s.pod.name`/`k8s.namespace`/
   `k8s.deployment.name`) carried on the spans (the otel collector's k8sattributes processor
   enriches them) — self-contained in the trace data, no separate k8s-API join.

## Architecture
A third materialized topology layer built **off the BFF** (thin-BFF mandate), mirroring the existing
two:

- `web/lib/graph-store.ts` gains **`rebuildTraceGraph(pool)`** alongside `rebuildGraph` (flow) and
  `rebuildInfraGraph` (infra). It mark-sweeps only `class='trace'` rows (key-distinct, per the
  existing class PK/UNIQUE), so it never touches flow/infra rows.
- `scripts/v2/graph-rebuild.mjs` calls `rebuildTraceGraph` after the flow/infra rebuilds (and the
  post-inventory-sync `graph-rebuild` worker job invokes the same logic).
- A **`TraceSource`** interface decouples the builder from the trace backend:
  ```
  interface TraceSpan { traceId; spanId; parentSpanId?; service; kind; dbSystem?; dbName?;
                        peerService?; k8sNamespace?; k8sPod?; k8sDeployment?; startMs; durationMs }
  interface TraceSource { available(): Promise<boolean>;
                          recentSpans(windowMins: number, cap: number): Promise<TraceSpan[]> }
  ```
  First adapter: **`ClickHouseOtelTraceSource`** — queries the ClickHouse `otel_traces` table via
  the existing datasource connector path (default ClickHouse instance), maps rows → `TraceSpan[]`.
  `available()` is false when no ClickHouse datasource is configured or `otel_traces` is absent/empty.

## Data model (`topology_nodes`/`topology_edges`, `class='trace'`)
- **Nodes** (`kind`, `id`, `label`, `meta`):
  - `service` — `id = svc:<service.name>`; `meta = { instances, k8sNamespace?, spanCount }`.
  - `db` — `id = db:<system>:<host_or_name>` (e.g. `db:postgresql:awsops-v2-aurora…`); `meta = {
    system, host, dbName?, infra_ref? }`.
  - `workload` — `id = workload:<ns>/<deployment>` (aggregated from pod attrs); `meta = { namespace,
    deployment, pods: [<pod names>], eks_ref? }`.
- **Edges** (`source`, `target`, `rel`, `confidence`):
  - `calls` — service→service (span parent service → child service).
  - `queries` — service→db (DB-client span: `db.system` present).
  - `runs_on` — service→workload (the workload the service's spans originate from, via k8s attrs).
  - `confidence` ∈ (0,1] — normalized span count for that edge over the window (a freshness/strength
    signal; low-count edges still shown).
- **Bridge meta (the "connect to existing topology" requirement)** — best-effort cross-class refs so
  the UI/agent can pivot trace↔infra↔flow without merging classes:
  - `db` node `meta.infra_ref` = the matching infra-layer node id (RDS/Aurora), matched by endpoint
    **host** (the trace `db.host`/peer address resolved against infra RDS node hosts). Unmatched →
    omit `infra_ref` (node still shown, just no pivot).
  - `workload` node `meta.eks_ref` = the EKS pod/workload node id (from the EKS in-cluster data),
    and `meta.tg_ref` = the infra target-group node id fronting it when resolvable.
  - The full chain "CF→LB→TG→pod (infra/flow) … pod→service→db (trace)" is navigable by following
    `tg_ref`/`eks_ref`/`infra_ref` across classes — each layer stays independently rebuildable.

## Data flow
1. Trigger: the post-inventory-sync `graph-rebuild` worker job (and the manual
   `scripts/v2/graph-rebuild.mjs`) — same cadence as flow/infra.
2. `rebuildTraceGraph(pool)`:
   a. `if (!(await source.available())) → mark-sweep to an empty trace layer and return {nodes:0,
      edges:0}` (no-op; never errors — this is the pre-tracing state).
   b. `spans = await source.recentSpans(window, cap)` (bounded).
   c. Aggregate spans → `service`/`db`/`workload` nodes + `calls`/`queries`/`runs_on` edges
      (dedup by id; sum span counts → confidence; cap top-N services/edges).
   d. Resolve bridge refs against current infra nodes (host match for `infra_ref`; EKS data for
      `eks_ref`/`tg_ref`).
   e. Mark-sweep upsert into `topology_nodes`/`topology_edges` with `class='trace'`.
3. Read: `/api/graph?class=trace` and `get_topology(class=trace)` (inventory_read MCP) return the
   layer; the topology page adds `trace` to its existing class toggle.

## Error handling / boundaries
- Source unavailable/empty → no-op (empty trace layer), never a crash. This is the default until the
  otel pipeline produces spans.
- Span volume bounded: `recentSpans(window, cap)` caps rows; aggregation caps top-N nodes/edges and
  logs what was dropped (no silent truncation).
- Bridge-ref matching is best-effort; an unmatched `db`/`workload` node renders without the pivot.
- Read path degrades exactly like flow/infra: empty layer → empty graph, no error.
- Security: the ClickHouse adapter reuses the existing connector's SSRF host-guard + credential path
  (`datasource_http`); read-only `SELECT` only; never logs credential material.

## Testing
- `rebuildTraceGraph` aggregation: fixture `TraceSpan[]` → expected nodes/edges/confidence
  (svc→svc→db, workload `runs_on`).
- No-op path: `available()=false` → empty layer, no throw; mark-sweep removes stale trace rows only.
- Bridge-ref matching: trace `db.host` → matching infra RDS node id; unmatched → no `infra_ref`.
- `TraceSource` contract: a `FakeTraceSource` used in the builder tests; `ClickHouseOtelTraceSource`
  row→`TraceSpan` mapping tested against a fixture ClickHouse response.
- Class isolation: rebuilding `trace` does not modify `flow`/`infra` rows (regression test).
- Mirror the existing graph-store tests' structure.

## Rollout / "preparation" boundary
Built now (all buildable + testable without live traces): the `TraceSource` interface, the
ClickHouse-otel adapter, `rebuildTraceGraph` (incl. the no-op-when-empty path), bridge-ref matching,
class='trace' wiring in graph-store + graph-rebuild + the topology page toggle. **Dormant until
traces exist**: `available()` returns false → empty layer. When the otel pipeline lands spans in
ClickHouse `otel_traces`, the next `graph-rebuild` populates the layer with zero code change.
