// Existing default-off graph timer runs in the web process, outside HTTP handlers.
// Flow failure does not block infra; trace depends on successful same-cycle infra execution.
// Existing web-task permissions and the enabling tfvar are documented in terraform/foundation/variables.tf.
// Class advisory locks serialize writes across ECS tasks; the local guard avoids duplicate reads.
// If work outgrows this process, an EventBridge/ECS worker path needs separate review, not a timer tweak.
//
// Default OFF (GRAPH_REBUILD_INTERVAL_MINS unset/0) — manual `scripts/v2/graph-rebuild.mjs` remains
// the baseline path; this just automates it once the interval is configured (recommended: 15, matching
// steampipe.tf's inventory-sync cadence).
//
// The `=== 'nodejs'` guard must wrap the import()s directly (not an early-return before them):
// NEXT_RUNTIME is inlined as a build-time literal per bundle target, so webpack's dead-code
// elimination can drop this whole branch — and the pg/node-builtins import chain it pulls in —
// from the edge-runtime bundle. An early-return guard doesn't get the same treatment and breaks
// the edge build (`Module not found: fs/path/stream` from pg → pgpass).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const mins = Number(process.env.GRAPH_REBUILD_INTERVAL_MINS ?? 0);
    if (!Number.isFinite(mins) || mins <= 0) return;

    const { getPool } = await import('./lib/db');
    const { rebuildGraph, rebuildInfraGraph, rebuildTraceGraph, recordTraceSourceFailure } = await import('./lib/graph-store');
    const { loadGraphSources } = await import('./lib/graph-sources');
    const { graphDiagnostic } = await import('./lib/graph-state');
    const { executeGraphLayer } = await import('./lib/graph-execution');
    const pool = getPool();
    const execute = async (stage: string, action: () => ReturnType<typeof rebuildGraph>) => {
      return executeGraphLayer(stage, action, (line, failed) => console[failed ? 'error' : 'log'](line));
    };

    // In-flight guard: the advisory lock in writeGraph() only serializes the WRITE section, not the
    // (possibly expensive) ClickHouse/inventory reads before it — without this, a rebuild slower than
    // the interval, or the initial 60s setTimeout landing on top of a short interval (e.g. mins=1),
    // would pile up duplicate concurrent read/source calls. Skipping a tick (not queuing it) is fine:
    // the next interval fires regardless, and a rebuild is idempotent.
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await execute('flow', () => rebuildGraph(pool));
        const infra = await execute('infra', () => rebuildInfraGraph(pool));
        if (infra.failed) {
          console.error('[graph-rebuild] trace skipped: infra execution failed');
          return;
        }
        // Registry-driven (2026-07-08): sources come from every registered datasource's pre-built
        // graph-query catalog (datasource_graph_queries), not one hardcoded default — see
        // docs/superpowers/specs/2026-07-08-registry-graph-sources-design.md.
        try {
          const { sources, metricsSources, registryFailed } = await loadGraphSources(pool);
          if (registryFailed) console.error('[graph-rebuild] trace_sources: registry_read_failed');
          await execute('trace', () => rebuildTraceGraph(pool, sources, undefined, metricsSources));
        } catch (error) {
          await execute('trace', () => recordTraceSourceFailure(pool));
          console.error(`[graph-rebuild] failed ${graphDiagnostic('trace_sources', error)}`);
        }
      } catch (error) {
        // An unexpected coordination error must not escape a background timer callback.
        console.error(`[graph-rebuild] failed ${graphDiagnostic('graph_state', error)}`);
      } finally {
        running = false;
      }
    };

    setTimeout(run, 60_000); // first attempt ~60s after boot; interval ticks keep the same overlap guard
    setInterval(run, mins * 60_000);
  }
}
