// Next.js server-boot hook: the gated graph timer runs IN the request-serving web process.
// Inventory reads use bounded per-account snapshots and release the shared pool connection
// before building. Publication uses nonwaiting class locks and transaction deadlines. The
// timer's in-flight guard skips overlapping ticks; it does not enqueue a worker job.
// Larger fleets beyond these budgets require a separately reviewed worker path.
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
    const { rebuildGraph, rebuildInfraGraph, rebuildTraceGraph } = await import('./lib/graph-store');
    const { loadGraphSources } = await import('./lib/graph-sources');
    const { graphDiagnostic } = await import('./lib/graph-state');
    const pool = getPool();

    // In-flight guard: the advisory lock in writeGraph() only serializes the WRITE section, not the
    // (possibly expensive) ClickHouse/inventory reads before it — without this, a rebuild slower than
    // the interval, or the initial 60s setTimeout landing on top of a short interval (e.g. mins=1),
    // would pile up duplicate concurrent read/source calls. Skipping a tick (not queuing it) is fine:
    // the next interval fires regardless, and a rebuild is idempotent.
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      let stage = 'flow';
      try {
        const flow = await rebuildGraph(pool);
        console.log(`[graph-rebuild] flow: ${JSON.stringify(flow)}`);
        stage = 'infra';
        const infra = await rebuildInfraGraph(pool);
        console.log(`[graph-rebuild] infra: ${JSON.stringify(infra)}`);
        // Registry-driven (2026-07-08): sources come from every registered datasource's pre-built
        // graph-query catalog (datasource_graph_queries), not one hardcoded default — see
        // docs/superpowers/specs/2026-07-08-registry-graph-sources-design.md.
        stage = 'trace_sources';
        const { sources, metricsSources } = await loadGraphSources(pool);
        stage = 'trace';
        const trace = await rebuildTraceGraph(pool, sources, undefined, metricsSources);
        console.log(`[graph-rebuild] trace: ${JSON.stringify(trace)}`);
      } catch (error) {
        // Never crash the server over a background rebuild — log and retry next interval.
        console.error(`[graph-rebuild] failed ${graphDiagnostic(stage, error)}`);
      } finally {
        running = false;
      }
    };

    setTimeout(run, 60_000); // first run ~60s after boot, so a fresh deploy materializes promptly
    setInterval(run, mins * 60_000);
  }
}
