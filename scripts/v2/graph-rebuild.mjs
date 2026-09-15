// ADR-043 — manual graph execution; the default-off timer uses these builders in the web process.
// Rebuilds all three materialized graph classes without changing their collection/publication behavior:
//   - flow  (class='flow')  via rebuildGraph      → traffic-flow topology
//   - infra (class='infra') via rebuildInfraGraph → resource-relationship topology (Step 2)
//   - trace (class='trace') via rebuildTraceGraph → shared trace graph
// Each builder retains its existing class/account storage boundary.
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
import { executeGraphLayer } from '../../web/lib/graph-execution.ts';

// Exit 0: execution returned; 2: explicit retention/skip reported; 1: failure. Counts are not full source proof.
const pool = getPool();
let failed = false, incomplete = false;
const execute = async (stage, action) => {
  const result = await executeGraphLayer(stage, action, (line, error) => console[error ? 'error' : 'log'](line));
  failed ||= result.failed;
  incomplete ||= result.incomplete;
};
try {
  await execute('flow', () => rebuildGraph(pool));
  await execute('infra', () => rebuildInfraGraph(pool));
  try {
    const { sources, metricsSources } = await loadGraphSources(pool);
    await execute('trace', () => rebuildTraceGraph(pool, sources, undefined, metricsSources));
  } catch (error) {
    failed = true;
    console.error(`[graph-rebuild] failed ${graphDiagnostic('trace_sources', error)}`);
  }
  process.exitCode = failed ? 1 : incomplete ? 2 : 0;
} finally {
  try { await pool.end(); }
  catch (error) {
    console.error(`[graph-rebuild] pool close failed ${graphDiagnostic('graph_state', error)}`);
    process.exitCode = 1;
  }
}
