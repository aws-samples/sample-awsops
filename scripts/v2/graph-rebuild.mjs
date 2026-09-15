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
import { rebuildGraph, rebuildInfraGraph, rebuildTraceGraph, recordTraceSourceFailure } from '../../web/lib/graph-store.ts';
import { loadGraphSources } from '../../web/lib/graph-sources.ts';
import { graphDiagnostic } from '../../web/lib/graph-state.ts';

// Exit 0: all layers published (including confirmed zero/degraded); 2: retained/skipped; 1: exception.
const pool = getPool();
let failed = false, incomplete = false;
const execute = async (stage, action) => {
  try {
    const result = await action();
    console.log(`[graph-rebuild] ${stage}: ${JSON.stringify(result)}`);
    incomplete ||= !!(result.retained || result.skipped);
    if (result.failed) {
      failed = true;
      console.error(`[graph-rebuild] failed ${graphDiagnostic(stage, { code: result.failureCode })}`);
    }
  } catch (error) {
    failed = true;
    console.error(`[graph-rebuild] failed ${graphDiagnostic(stage, error)}`);
  }
};
try {
  await execute('flow', () => rebuildGraph(pool));
  await execute('infra', () => rebuildInfraGraph(pool));
  try {
    const { sources, metricsSources } = await loadGraphSources(pool);
    await execute('trace', () => rebuildTraceGraph(pool, sources, undefined, metricsSources));
  } catch (error) {
    failed = true;
    await execute('trace', () => recordTraceSourceFailure(pool));
    console.error(`[graph-rebuild] failed ${graphDiagnostic('trace_sources', error)}`);
  }
  process.exitCode = failed ? 1 : incomplete ? 2 : 0;
} finally {
  await pool.end();
}
