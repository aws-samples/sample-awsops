# Plan — ADR-040 Step 1: Postgres edge-table ontology

> **Base branch:** `feat/v2-architecture-design`. Implements **ADR-040 Step 1** (Postgres
> edge-tables first; Neptune deferred). Scope = materialize the topology graph (the relationship
> ontology that already lives in `web/lib/flow-topology.ts`) into Aurora as a queryable edge table,
> + a recursive-CTE query lib + a read-only BFF route. **Agent SQL tool = documented follow-on
> (Step 1b), not in this plan.** No Neptune.

## Problem / why

The topology graph is currently rebuilt client-side on every page load (fetch inventory →
`buildFlowGraph`). The DevOps agent (ADR-032 read-only RCA) cannot ask multi-hop questions
("blast radius of this RDS", "what's upstream of this pod") without re-deriving the whole graph.
ADR-040 decided: materialize the edges in Aurora (reuse the existing sync; ≈$0) + recursive-CTE
traversal — 80% of graph-DB value without Neptune. The derivation rules already exist in one
place (`flow-topology.ts`); we must NOT duplicate them (drift) — the materializer reuses them.

## Constraints / conventions (verified)

- Migrations = ULID files under `terraform/foundation/migrations/` applied by
  `scripts/v2/migrate.mjs` (advisory-locked, version-stamped); `make deploy` runs `migrate` first.
  New tables go in a `migrations/<ULID>_*.sql` file (NOT schema.sql append).
- `web/lib/flow-topology.ts` is pure TS → importable server-side (Node BFF). Reuse it; do not
  re-implement relationship rules.
- BFF routes: `web/app/api/**/route.ts`, `verifyUser` auth, node-pg via `web/lib/db.ts getPool`.
- Read-only posture: the graph layer never mutates AWS; only reads inventory + writes the derived
  edge table in Aurora. No new IAM.
- ADR-040 guardrails: mark-sweep deletion (stamp each rebuild with a `run_id`/timestamp, delete
  rows not in the latest run — no stale nodes); stamp `captured_at`; the materializer is the only
  writer of the edge table.

## Tasks

### Task 1 — migration: topology graph tables (TDD: schema test)
- [ ] `terraform/foundation/migrations/<ULID>_topology_graph.sql`: `topology_nodes`
      (`id` text PK = the builder node id e.g. `alb:<arn>`, kind, label, meta jsonb, run_id,
      captured_at) + `topology_edges` (id bigserial PK, source, target, rel, confidence, run_id,
      captured_at, **`UNIQUE(source, target, rel)`** for idempotent ON CONFLICT upsert).
      Indexes on edges(source), edges(target), nodes(kind). (node upsert keys on the text PK `id`.)
- [ ] `web/lib/graph-store.test.ts` (or migration presence test) asserts the migration file exists
      and the DDL parses (no live DB).
- [ ] Commit: `feat(topology): topology_nodes/edges migration (ADR-040 Step 1)`

### Task 2 — server-side materializer reusing flow-topology (TDD)
- [ ] `web/lib/graph-store.ts`: `rebuildGraph(pool)` — reads `inventory_resources` for the
      topology types (route53/cloudfront/alb/nlb/target_group/waf/ec2/lambda/ecs_task), shapes them
      into `FlowInput` (same `{resource_id, region, ...data}` flattening the page uses), calls
      `buildFlowGraph` (REUSED — no rule duplication), then upserts nodes/edges with a fresh `run_id`
      and **mark-sweep deletes** rows from prior runs.
      **Concurrency (gate fix): the whole rebuild runs in ONE transaction guarded by
      `pg_advisory_xact_lock(<const key>)`** so two near-simultaneous rebuilds serialize and never
      sweep each other's live rows. Upserts use `ON CONFLICT` on the keys from Task 1.
      EKS (live in-cluster) is out of the materializer (stays UI-live) — note it.
      **NOT called from a BFF request handler** (thin-BFF mandate) — `rebuildGraph` is a plain
      function invoked by the runner in Task 5.
- [ ] `graph-store.test.ts`: given a mocked pool, `rebuildGraph` takes the advisory lock, upserts
      the expected nodes/edges, and issues the mark-sweep delete of stale run_ids — all in one tx.
- [ ] Commit: `feat(topology): graph-store materializer (reuses flow-topology, tx + advisory lock + mark-sweep)`

### Task 3 — recursive-CTE traversal lib (TDD)
- [ ] `web/lib/graph-query.ts`: `downstream(pool, id)`, `upstream(pool, id)`, `blastRadius(pool, id)`
      via Postgres `WITH RECURSIVE` over `topology_edges`, using the **SQL-standard `CYCLE id SET
      is_cycle USING path` clause** (PG 17.9 native — gate fix, replaces a manual visited array).
      Bound depth (e.g. ≤ 8 hops) as a backstop.
- [ ] `graph-query.test.ts`: verify the emitted SQL shape + params (mocked pool); CYCLE clause present.
- [ ] Commit: `feat(topology): recursive-CTE graph traversal (downstream/upstream/blast-radius, CYCLE)`

### Task 4 — read-only BFF route (TDD) — GET only, no inline rebuild
- [ ] `web/app/api/graph/route.ts`: **`GET` only** (verifyUser) — returns the materialized graph
      (`{nodes, edges, captured_at}`) from the tables, or a traversal when `?from=<id>&dir=down|up`
      is passed (delegates to `graph-query`). force-dynamic. **No POST/rebuild here** — rebuild is
      heavy and must not run in a BFF request (thin-BFF mandate, gate CRITICAL). Light reads only.
- [ ] `app/api/graph/route.test.ts`: 401 unauth; GET returns the graph shape; `?from=&dir=` calls
      the traversal.
- [ ] Commit: `feat(topology): /api/graph read-only route (GET + traversal)`

### Task 5 — rebuild runner (TS, outside the BFF request path)
- [ ] `scripts/v2/graph-rebuild.mjs` (or a `make graph-rebuild` target): a Node entrypoint that
      connects to Aurora (reusing the deploy creds path) and calls `rebuildGraph` from
      `web/lib/graph-store.ts` (transpiled/`tsx`). Run manually now; **automation = follow-on**
      (post-sync EventBridge → a TS Node Lambda reusing `graph-store`; documented, NOT this plan).
      This keeps the heavy rebuild off the web node AND keeps the derivation rules in TS only
      (no Python duplication).
- [ ] Commit: `feat(topology): graph-rebuild runner (node entrypoint, off the BFF)`

## Out of scope (follow-on)

- **Agent SQL/graph tool** (Step 1b): expose `graph-query` to the DevOps agent (a read-only tool).
- **EKS pods in the materialized graph** (live in-cluster, not synced) — stays UI-live for now.
- **Neptune** (ADR-040 deferred option) — only if recursive-CTE proves insufficient.

## Hand-off / ops note

`make deploy` runs the new migration against live Aurora (ULID, advisory-locked, idempotent).
The edge table is empty until the first `rebuildGraph` (POST /api/graph as admin, or post-sync
wiring). The topology UI is unaffected (still client-side `buildFlowGraph`); `/api/graph` is the
new server path for the agent + future scale.
