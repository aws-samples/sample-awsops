# Spec — Resource-Relationship Topology (per-resource network graph) / 리소스-관계 토폴로지

> **Branch:** `feat/v2-architecture-design`. Builds on **ADR-043** (materialized graph substrate:
> `topology_nodes` / `topology_edges`, `web/lib/graph-store.ts`, `web/lib/graph-query.ts`,
> `GET /api/graph`). A **second** topology view distinct from the existing **traffic-flow** topology
> (`web/lib/flow-topology.ts`). Design approved 2026-06-17 (owner) + co-agent panel (gemini full;
> codex/kiro timed out → gemini synthesis verified against code by the chair).

## Goal / 목적
Click a resource → a **separate page** showing that resource's **network-placement relationship
graph**: resource ↔ VPC ↔ subnet ↔ security-group ↔ co-located resources. This realizes the
graph-substrate's multi-hop / blast-radius purpose, complementing (not replacing) traffic flow.

## Locked decisions (owner Q1–Q5)
1. **Scope:** network placement only for v1 (VPC / subnet / SG); the edge ontology MUST be extensible
   (new `rel` types can be added later for app-dependency, etc.).
2. **Data source:** the **materialized** graph (`topology_nodes` / `topology_edges`) — add
   resource-relationship `rel` types. NOT a client-side rebuild.
3. **Render:** a **separate page** `/topology/resource/[id]`, reached via a link in the detail panel.
4. **Expansion:** variable depth (blast-radius) — default 2-hop, a depth control, via `graph-query`
   down/up traversal; MUST cap fan-out (shared subnet/SG and default-SG are huge hubs).
5. **Materialization:** **post-inventory-sync auto trigger** rebuilds BOTH graphs (traffic-flow +
   resource-relationship) so the graph stays fresh (ADR-043 Step 1b).

## Architecture

### Data model — coexistence via a `class` namespace
Both graphs live in the SAME physical tables, separated by a new logical namespace column:

- Add **`class TEXT NOT NULL DEFAULT 'flow'`** to `topology_nodes` and `topology_edges`
  (new ULID migration under `terraform/foundation/migrations/`). `'flow'` = traffic-flow
  (existing behaviour unchanged via the default), `'infra'` = resource-relationship.
- **Widen the edge UNIQUE** to `(account_id, source, target, rel, class)` so the same node pair can
  carry both a flow edge and an infra edge. (Node PK stays `(account_id, id)` — a node may belong to
  both classes; `class` on a node records which materializer last wrote it / its primary class.)
- **infra node kinds:** `vpc`, `subnet`, `sg` (+ resource nodes already exist as flow nodes).
- **infra `rel` types:** `infra:in_vpc`, `infra:in_subnet`, `infra:uses_sg` (extensible).
- **Node IDs are globally-unique** (ARN where available, else `<type>:<region>:<id>`) to avoid
  cross-region id collisions (e.g. two `sg-…` ids). Resource nodes reuse their existing flow node id
  when present so the two graphs share the same resource node.

### Mark-sweep scoped by class
`rebuildGraph` / `rebuildInfraGraph` each run under `pg_advisory_xact_lock` and mark-sweep ONLY their
own class: `DELETE FROM topology_edges WHERE class = $class AND run_id <> $run` (same for nodes). The
two materializers never wipe each other's rows. The advisory-lock key differs per class so they can
run concurrently. The empty-build guard (skip sweep when 0 nodes built) is retained per class.

### Materializer — `rebuildInfraGraph(pool)` in `web/lib/graph-store.ts`
1. Read `inventory_resources` for `vpc`, `subnet`, `security_group` → emit infra nodes (label =
   Name tag / `group_name`, fall back to id).
2. Second pass over all synced resources carrying `vpc_id` / subnet ids / security-group ids in their
   `data` (reusing the same id-extraction shapes as the detail panel's `idsFrom` /`networkNames`) →
   emit `infra:in_vpc` / `infra:in_subnet` / `infra:uses_sg` edges (resource → network node).
3. Upsert under advisory lock + class-scoped mark-sweep (class `'infra'`).
4. Derivation rules live in ONE place (a shared `infra-topology.ts` builder, mirroring how
   `flow-topology.ts` is the single source for the flow graph) — no rule duplication between the
   materializer and any future consumer.

### Post-sync auto trigger (Q5)
On successful Steampipe inventory sync, **enqueue a `worker_jobs` job** (`{type:'graph-rebuild'}`) via
the existing P2 worker backbone (the sync writes the queued row + SQS message — same path the BFF
uses, no HTTP call from the VPC). The worker runs `rebuildGraph` (flow) then `rebuildInfraGraph`
(infra). Reuses `scripts/v2/graph-rebuild.mjs` logic. No DB triggers; thin-BFF preserved (rebuild
never runs on a request).

### Traversal + caps — `web/lib/graph-query.ts`
- Add a **`class` filter** to the recursive-CTE traversal (`WHERE class = $class`).
- **Per-hop fan-out cap** to bound hubs: inside the recursive step use a LATERAL subquery with a
  deterministic `ORDER BY target LIMIT <CAP>` (default 20) so a large subnet/SG cannot explode the
  result. Record (do not silently drop) when a hub was capped.
- **Default-SG exclusion:** a node identified as a `default` security group is NOT expanded beyond
  itself unless it is the `?from=` start node.
- Keep the existing PG17 `CYCLE` clause + `MAX_DEPTH` backstop.

### API + page
- Extend `GET /api/graph` to accept `?class=infra&from=<id>&depth=<n>` → `{ nodes, edges, captured_at,
  capped? }`. GET-only, read-only, `verifyUser`; no rebuild on the request path (thin-BFF).
- New page **`/topology/resource/[id]`** (client component): fetch the infra subgraph, render with
  React Flow. VPC nesting is better shown with a hierarchy/tree (or force) layout than the flow LR
  DAG — `layoutFlow` gains a layout option OR a small infra-specific layout. A depth control (default
  2) re-queries. A "back to flow topology" link.
- **Detail-panel link:** the topology detail panel (and, extensibly, inventory detail) gains an
  "이 리소스 관계 그래프 / Relationship graph" link → `/topology/resource/<encoded id>`.

## Out of scope (v1 — explicit cuts)
- **Cross-account / VPC-peering / Transit-Gateway** links (restrict to `account_id = 'self'`).
- App-dependency edges (LB→TG→target as infra, EC2→EBS, Lambda→role, …) — the ontology allows them
  later; not built now.
- Live (non-materialized) fallback — the page reads the materialized graph only.

## Risks & mitigations
- **UI hairball** (hub fan-out) → per-hop LIMIT cap + default-SG exclusion + depth default 2.
- **Staleness** → post-sync auto trigger (Q5); page shows the graph `captured_at`.
- **ID collisions** across regions → globally-unique node ids (ARN / `type:region:id`).
- **Two materializers on one table** → class-scoped mark-sweep + per-class advisory-lock key.
- **Empty/failed inventory** → per-class empty-build guard (skip sweep, preserve last-good).

## Testing
- `infra-topology` builder: resource rows → expected infra nodes/edges (id shapes, rel types).
- `rebuildInfraGraph` (mock pool): class-scoped upsert + mark-sweep + advisory lock; empty-build guard.
- `graph-query` infra: emitted SQL has the `class` filter, the LATERAL LIMIT cap, default-SG
  exclusion, CYCLE + depth bound.
- `GET /api/graph?class=infra`: 401 unauth; returns subgraph shape; `?from=&depth=` wires traversal.
- migration presence/DDL parse test (class column + widened unique).

## Success criteria
Clicking a resource opens `/topology/resource/<id>` showing its VPC/subnet/SG (and ≤2-hop co-located
resources, capped) from the materialized graph, kept fresh by the post-sync trigger, with the
traffic-flow topology unchanged.
