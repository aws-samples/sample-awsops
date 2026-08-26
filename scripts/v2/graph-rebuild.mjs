// ADR-043 — topology graph rebuild runner (OFF the BFF, per the thin-BFF mandate).
// Rebuilds BOTH materialized graphs (each reuses its single-source builder — no rule duplication):
//   - flow  (class='flow')  via rebuildGraph      → traffic-flow topology
//   - infra (class='infra') via rebuildInfraGraph → resource-relationship topology (Step 2)
// The two classes are key-distinct (class in the node PK + edge UNIQUE), so each mark-sweeps only
// its own rows.
//
//   Run from a VPC-with-Aurora context (the ECS task or a bastion), with the Aurora env set:
//     cd web && npx tsx ../scripts/v2/graph-rebuild.mjs
//
// The post-inventory-sync AUTO trigger (a 'graph-rebuild' worker job) invokes this same logic.
import { getPool } from '../../web/lib/db.ts';
import { rebuildGraph, rebuildInfraGraph, rebuildTraceGraph } from '../../web/lib/graph-store.ts';
import { loadGraphSources } from '../../web/lib/graph-sources.ts';

const pool = getPool();
const flow = await rebuildGraph(pool);
console.log(`[graph-rebuild] flow: ${flow.nodes} nodes, ${flow.edges} edges`);
const infra = await rebuildInfraGraph(pool);
console.log(`[graph-rebuild] infra: ${infra.nodes} nodes, ${infra.edges} edges`);
// Step 3 — trace-level (application) graph. Registry-driven (2026-07-08): sources come from every
// registered datasource's pre-built graph-query catalog (datasource_graph_queries) — see
// docs/superpowers/specs/2026-07-08-registry-graph-sources-design.md. Falls back to a bare default
// ClickHouse source (available()=false with no default clickhouse instance → empty layer) when no
// ready row exists yet, e.g. before the first daily datasource_index run.
const { sources, metricsSources } = await loadGraphSources(pool);
const trace = await rebuildTraceGraph(pool, sources, undefined, metricsSources);
console.log(`[graph-rebuild] trace: ${trace.nodes} nodes, ${trace.edges} edges`);
process.exit(0);
