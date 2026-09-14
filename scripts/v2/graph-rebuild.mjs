// ADR-043 — topology graph rebuild runner (OFF the BFF, per the thin-BFF mandate).
// Rebuilds BOTH materialized graphs (each reuses its single-source builder — no rule duplication):
//   - flow  (class='flow')  via rebuildGraph      → traffic-flow topology
//   - infra (class='infra') via rebuildInfraGraph → resource-relationship topology (Step 2)
// The two classes are key-distinct (class in the node PK + edge UNIQUE), so each mark-sweeps only
// its own rows.
//
//   Run from a VPC-with-Aurora context (the ECS task or a bastion), with the Aurora env set
//   and HOST_ACCOUNT_ID set to the configured host account for explicit-account DB host matching.
//   This setting does not verify telemetry claims or grant queue-to-inventory attribution:
//     cd web && npx tsx ../scripts/v2/graph-rebuild.mjs
//
// The gated web/instrumentation.ts timer invokes this logic in the web process.
import { getPool } from '../../web/lib/db.ts';
import { rebuildGraph, rebuildInfraGraph, rebuildTraceGraph } from '../../web/lib/graph-store.ts';
import { loadGraphSources } from '../../web/lib/graph-sources.ts';
import { graphDiagnostic } from '../../web/lib/graph-state.ts';

// Exit 0: all layers published (including confirmed zero/degraded); 2: retained/skipped; 1: exception.
const pool = getPool();
let stage = 'flow';
try {
  const flow = await rebuildGraph(pool);
  console.log(`[graph-rebuild] flow: ${JSON.stringify(flow)}`);
  stage = 'infra';
  const infra = await rebuildInfraGraph(pool);
  console.log(`[graph-rebuild] infra: ${JSON.stringify(infra)}`);
  stage = 'trace_sources';
  const { sources, metricsSources } = await loadGraphSources(pool);
  stage = 'trace';
  const trace = await rebuildTraceGraph(pool, sources, undefined, metricsSources);
  console.log(`[graph-rebuild] trace: ${JSON.stringify(trace)}`);
  process.exitCode = [flow, infra, trace].some(result => result.retained || result.skipped) ? 2 : 0;
} catch (error) {
  console.error(`[graph-rebuild] failed ${graphDiagnostic(stage, error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
