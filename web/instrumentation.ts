// Next.js server-boot hook (requires experimental.instrumentationHook in next.config.mjs). Schedules
// the graph-rebuild materializer (flow/infra/trace layers, ADR-043 + the 2026-06-25 trace-topology
// design) to run periodically IN the web server process — no new Docker image or AWS resource, and
// the web task role already holds the perms rebuildTraceGraph needs (Aurora IAM auth + connector-Lambda
// invoke for the ClickHouse source). Bounded work (one inventory SELECT + ≤1000 spans + ≤200/500 node/
// edge upserts, seconds, I/O-bound) run OFF any request path, so this doesn't violate thin-BFF.
// Concurrent ECS tasks are safe: writeGraph() takes a per-class pg advisory lock, so overlapping runs
// serialize rather than corrupt state — duplicate work is a bounded, acceptable cost, not a bug.
// Upgrade path if this ever gets heavy: move to an EventBridge-scheduled ECS runTask (ADR-043 stays
// BFF-request-path-clean either way; this only affects background-timer plumbing).
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
      try {
        const flow = await rebuildGraph(pool);
        const infra = await rebuildInfraGraph(pool);
        // Registry-driven (2026-07-08): sources come from every registered datasource's pre-built
        // graph-query catalog (datasource_graph_queries), not one hardcoded default — see
        // docs/superpowers/specs/2026-07-08-registry-graph-sources-design.md.
        const { sources, metricsSources } = await loadGraphSources(pool);
        const trace = await rebuildTraceGraph(pool, sources, undefined, metricsSources);
        console.log(`[graph-rebuild] flow: ${flow.nodes} nodes, ${flow.edges} edges`);
        console.log(`[graph-rebuild] infra: ${infra.nodes} nodes, ${infra.edges} edges`);
        console.log(`[graph-rebuild] trace: ${trace.nodes} nodes, ${trace.edges} edges`);
      } catch (err) {
        // Never crash the server over a background rebuild — log and retry next interval.
        console.error('[graph-rebuild] failed:', err);
      } finally {
        running = false;
      }
    };

    setTimeout(run, 60_000); // first run ~60s after boot, so a fresh deploy materializes promptly
    setInterval(run, mins * 60_000);
  }
}
