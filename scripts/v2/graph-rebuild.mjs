// ADR-043 — manual graph execution; the default-off timer uses these builders in the web process.
// Flow failure does not block infra; trace runs only after infra execution returns successfully.
// Builders retain their existing collection/publication behavior:
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
import { rebuildGraph, rebuildInfraGraph, rebuildTraceGraph, recordTraceSourceFailure } from '../../web/lib/graph-store.ts';
import { loadGraphSources } from '../../web/lib/graph-sources.ts';
import { graphDiagnostic } from '../../web/lib/graph-state.ts';
import { executeGraphLayer } from '../../web/lib/graph-execution.ts';

// Exit 1: unexpected/invalid execution, registry or cleanup failure; 2: retained/skipped; otherwise 0.
const pool = getPool();
let failed = false, incomplete = false;
const execute = async (stage, action) => {
  const result = await executeGraphLayer(stage, action, (line, error) => console[error ? 'error' : 'log'](line));
  failed ||= result.failed;
  incomplete ||= !!result.incomplete;
  return result;
};
try {
  await execute('flow', () => rebuildGraph(pool));
  const infra = await execute('infra', () => rebuildInfraGraph(pool));
  if (infra.failed) {
    console.error('[graph-rebuild] trace skipped: infra execution failed');
  } else {
    try {
      const { sources, metricsSources, registryFailed } = await loadGraphSources(pool);
      if (registryFailed) {
        failed = true;
        console.error('[graph-rebuild] trace_sources: registry_read_failed');
      }
      await execute('trace', () => rebuildTraceGraph(pool, sources, undefined, metricsSources));
    } catch (error) {
      failed = true;
      await execute('trace', () => recordTraceSourceFailure(pool));
      console.error(`[graph-rebuild] failed ${graphDiagnostic('trace_sources', error)}`);
    }
  }
  process.exitCode = failed ? 1 : incomplete ? 2 : 0;
} finally {
  try { await pool.end(); }
  catch (error) {
    console.error(`[graph-rebuild] pool close failed ${graphDiagnostic('graph_state', error)}`);
    process.exitCode = 1;
  }
}
