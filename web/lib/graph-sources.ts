// web/lib/graph-sources.ts
// Registry-driven graph-source loader (design: docs/superpowers/specs/
// 2026-07-08-registry-graph-sources-design.md). Reads the pre-built `datasource_graph_queries`
// catalog (graph_catalog.py, kept fresh by the daily datasource_index worker job) and returns
// ready-to-use adapters — one per registered, capability-matched datasource instance — instead of a
// single hardcoded default ClickHouse instance.

import type { Pool } from 'pg';
import { ClickHouseOtelTraceSource, TempoTraceSource, MetricsCallsSource, type TraceSource } from '@/lib/trace-source';

interface GraphQueryRow {
  integration_id: number;
  query: { tool?: string; mapper?: string; args_template?: Record<string, unknown> } | null;
}

export interface GraphSources {
  sources: TraceSource[];
  metricsSources: MetricsCallsSource[];
}

/** Load ready graph-source adapters across every registered datasource instance. Falls back to a
 *  bare default ClickHouseOtelTraceSource (the pre-registry behavior) when no ready row exists yet
 *  — a fresh environment before the first daily datasource_index run, or the query itself failing —
 *  so nothing regresses. Never throws. */
export async function loadGraphSources(pool: Pool): Promise<GraphSources> {
  let rows: GraphQueryRow[] = [];
  try {
    // JOIN against integrations as defense-in-depth against an orphan row (deleteDatasource() sweeps
    // datasource_graph_queries on delete, but a row surviving that sweep — e.g. a race, or predating
    // that fix — must still never surface a source for an instance that no longer exists).
    const r = await pool.query(
      `SELECT gq.integration_id, gq.query FROM datasource_graph_queries gq
       JOIN integrations i ON i.id = gq.integration_id
       WHERE gq.account_id = 'self' AND gq.status = 'ready'`,
    );
    rows = r.rows as GraphQueryRow[];
  } catch {
    rows = [];
  }

  const sources: TraceSource[] = [];
  const metricsSources: MetricsCallsSource[] = [];
  for (const row of rows) {
    const q = row.query;
    const mapper = q?.mapper;
    if (mapper === 'otel_v1') {
      const sql = q?.args_template?.sql;
      sources.push(new ClickHouseOtelTraceSource(row.integration_id, typeof sql === 'string' ? sql : undefined));
    } else if (mapper === 'tempo_v1') {
      sources.push(new TempoTraceSource(row.integration_id));
    } else if (mapper === 'servicegraph_v1' || mapper === 'istio_v1') {
      const kind = q?.tool === 'mimir_query' ? 'mimir' : 'prometheus';
      const promql = q?.args_template?.query;
      if (typeof promql === 'string') metricsSources.push(new MetricsCallsSource(row.integration_id, kind, promql));
    }
    // unknown mapper / malformed row → contributes nothing (never throws)
  }

  if (sources.length === 0 && metricsSources.length === 0) {
    sources.push(new ClickHouseOtelTraceSource());
  }
  return { sources, metricsSources };
}
