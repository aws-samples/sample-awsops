# Plan — Resource-Relationship Topology (ADR-043 Step 2 / infra graph)

> **Base:** `feat/v2-architecture-design`. Implements spec
> `docs/superpowers/specs/2026-06-17-resource-relationship-topology-design.md`.
> TDD; bite-sized tasks; explicit file paths; one commit per task. Reuses the ADR-043 materialized
> graph (`topology_nodes`/`topology_edges`, `graph-store.ts`, `graph-query.ts`, `/api/graph`).

## Conventions (verified)
- Migrations = ULID files under `terraform/foundation/migrations/` applied by `scripts/v2/migrate.mjs`.
  New columns/constraints go in a NEW `migrations/<ULID>_*.sql` (NOT editing the frozen baseline).
- Web tests = `vitest run` (mock pg Pool; no live DB). BFF routes `verifyUser` + node-pg `getPool`.
- `flow-topology.ts` is the single source for the flow graph; `infra-topology.ts` will be the single
  source for the infra graph (no rule duplication).
- thin-BFF: no heavy rebuild on a request path; rebuild runs in the worker / runner.

---

### Task 1 — migration: `class` namespace on the graph tables
> **P2 gate (CRITICAL, gemini+kiro):** `class` must be in BOTH primary/unique keys, or a node shared
> by flow+infra (same id) collapses to one row with one class and a class-scoped sweep deletes it,
> orphaning the other class's edges. Fix: `class` is part of the node PK AND the edge UNIQUE → a
> resource node is stored as TWO class-distinct rows (one per graph), each swept independently.
- [ ] `terraform/foundation/migrations/<ULID>_topology_class.sql`: `ADD COLUMN class text NOT NULL
      DEFAULT 'flow'` on `topology_nodes` AND `topology_edges`. **Drop + recreate the node PK as
      `(account_id, id, class)`** and the edge UNIQUE as `(account_id, source, target, rel, class)`.
      Add traversal index `topology_edges (account_id, class, source)`. Idempotent (guards).
- [ ] `web/lib/graph-store.test.ts` (migration-presence test): assert the migration file exists and its
      DDL contains the class column + the class in the node PK + the widened edge unique (string check,
      no live DB).
- [ ] Commit: `feat(topology): migration — class namespace (flow|infra) on topology_nodes/edges`

### Task 2 — infra-topology builder (pure TS, TDD)
- [ ] `web/lib/infra-topology.ts`: `buildInfraGraph(input)` where input = { resources: Row[] (any
      synced resource with network fields), vpcs, subnets, securityGroups }. Emits nodes (kind
      `vpc`|`subnet`|`sg`|resource) with globally-unique ids (ARN else `<type>:<region>:<id>`) and
      edges `infra:in_vpc` / `infra:in_subnet` / `infra:uses_sg` (resource→network). Reuse the id
      shapes from the detail panel (`idsFrom`-style extraction). Mark default SGs (`group_name ===
      'default'`) on the node meta.
- [ ] `web/lib/infra-topology.test.ts`: resource rows → expected nodes/edges (rel types, ids, default-SG
      flag); handles the multiple id shapes (string | {GroupId} | availability_zones[].SubnetId).
- [ ] Commit: `feat(topology): infra-topology builder (resource↔vpc/subnet/sg edge ontology)`

### Task 3 — `rebuildInfraGraph` + make flow rebuild class-scoped (TDD)
- [ ] `web/lib/graph-store.ts`: (a) make existing `rebuildGraph` write `class='flow'`, upsert with
      `ON CONFLICT (account_id, id, class)` (nodes) / `(account_id, source, target, rel, class)` (edges),
      and scope its mark-sweep `WHERE class='flow' AND run_id <> $1` for BOTH nodes and edges (now
      correct since rows are class-distinct); distinct advisory-lock key. (b) add `rebuildInfraGraph
      (pool)`: reads inventory (resources + vpc/subnet/security_group), calls `buildInfraGraph`, upserts
      class='infra' (same ON CONFLICT targets) under advisory lock + class-scoped node+edge mark-sweep;
      empty-build guard (skip sweep when 0 nodes — preserves last-good on a failed/unsynced inventory;
      accepted tradeoff: a genuinely-emptied account keeps its last graph until non-empty).
- [ ] `web/lib/graph-store.test.ts`: rebuildInfraGraph upserts class='infra', mark-sweep filters class,
      empty inventory → no sweep; rebuildGraph mark-sweep now class-scoped to 'flow'.
- [ ] Commit: `feat(topology): rebuildInfraGraph (class-scoped upsert+sweep) + flow rebuild class-aware`

### Task 4 — traversal: class filter + fan-out cap + default-SG exclusion (TDD)
- [ ] `web/lib/graph-query.ts`: add a `class` filter and a per-hop fan-out cap. The LATERAL
      `(SELECT … WHERE source = w.node … ORDER BY target LIMIT <CAP=20>)` MUST sit INSIDE the recursive
      term so it caps neighbors-per-node (hairball hubs), NOT the total traversal breadth (gate MINOR).
      Exclude `default` SG nodes from expansion unless they are the start node; keep CYCLE + MAX_DEPTH.
      Export the CAP.
- [ ] `web/lib/graph-query.test.ts`: emitted SQL contains the class filter, the LATERAL LIMIT cap, the
      default-SG exclusion, CYCLE, and the depth bound; params are parameterized.
- [ ] Commit: `feat(topology): graph-query class filter + LATERAL fan-out cap + default-SG exclusion`

### Task 5 — `/api/graph?class=&depth=&from=` (TDD)
- [ ] `web/app/api/graph/route.ts`: accept `class` (default 'flow'), `depth` (default 2, clamped),
      `from`; delegate to graph-query traversal; return `{ nodes, edges, captured_at, capped }`. GET
      only, verifyUser, force-dynamic. No rebuild on the path.
- [ ] `web/app/api/graph/route.test.ts`: 401 unauth; `?class=infra&from=&depth=` calls the infra
      traversal with the parsed params; depth clamp.
- [ ] Commit: `feat(topology): /api/graph class+depth+from traversal params`

### Task 6 — per-resource page + detail link
- [ ] `web/app/topology/resource/[id]/page.tsx`: client page — fetch `/api/graph?class=infra&from=<id>
      &depth=<n>`, render with React Flow. Reuse `layoutFlow` (already dagre-based) with `rankdir:'TB'`
      for the VPC→subnet→resource hierarchy (gate MINOR: RF is a renderer, needs a layout engine — we
      already have dagre). Depth control (default 2), `captured_at` + "capped" notice, back-to-flow link.
      `export default`.
- [ ] `web/app/topology/page.tsx`: add a "관계 그래프 / Relationship graph" link in the detail panel
      (DetailPanel `actions`) → `/topology/resource/<encodeURIComponent(id)>` for resource nodes that
      carry a row.
- [ ] Commit: `feat(topology): /topology/resource/[id] infra graph page + detail-panel link`

### Task 7 — post-sync auto trigger (rebuild both graphs)
- [ ] `scripts/v2/graph-rebuild.mjs`: also invoke `rebuildInfraGraph` after `rebuildGraph` (both classes).
- [ ] `scripts/v2/steampipe/sync_lambda.py`: on successful sync, enqueue a `worker_jobs` row
      (`type='graph-rebuild'`) + SQS (reuse the existing enqueue path / db helper); idempotent.
- [ ] worker handler (`scripts/v2/workers/handlers.py` or the graph job path): on `graph-rebuild`, run
      both rebuilds. Guard behind existing `workers_enabled`; no behavior when off.
- [ ] Commit: `feat(topology): post-inventory-sync trigger rebuilds flow+infra graphs (worker job)`

### Task 8 — docs
- [ ] Update `docs/decisions/CLAUDE.md` ADR-043 note + `CLAUDE.md` Key Files (infra graph = Step 2).
- [ ] Commit: `docs(topology): record ADR-043 Step 2 (resource-relationship infra graph)`

### Task 9 — flow-topology: reflect LBs/TGs wired via listener PATH RULES (owner add-on)
> Today flow-topology links LB→TG only via `tg.load_balancer_arns` (no listener/rule inventory).
> A TG associated ONLY through a path/host listener rule can be missed when AWS doesn't populate
> `load_balancer_arns` for it. Fix: sync listeners + rules and build LB→TG edges from forward actions.
- [ ] `scripts/v2/steampipe/sync_lambda.py`: add a listener-rule inventory type — verify the Steampipe
      table (`aws_ec2_load_balancer_listener` default_actions + a rules source); capture
      `load_balancer_arn`, `target_group_arns` (forward), `conditions` (path/host patterns).
- [ ] `web/lib/flow-topology.ts`: in addition to `load_balancer_arns`, add LB→TG edges from listener
      rules (label with the path/host pattern; confidence 'observed'). De-dupe vs the existing edge.
- [ ] `web/lib/flow-topology.test.ts`: a TG reachable only via a path rule still gets an LB→TG edge.
- [ ] Commit: `feat(topology): link LB→TG via listener path/host rules (not just load_balancer_arns)`

## Out of scope (per spec)
Cross-account / peering / TGW; app-dependency edges; live (non-materialized) fallback.
