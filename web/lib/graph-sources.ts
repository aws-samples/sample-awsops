// web/lib/graph-sources.ts
// Registry-driven graph-source loader (design: docs/superpowers/specs/
// 2026-07-08-registry-graph-sources-design.md). Reads the pre-built `datasource_graph_queries`
// catalog (graph_catalog.py, kept fresh by the daily datasource_index worker job) and returns
// ready-to-use adapters — one per registered, capability-matched datasource instance — instead of a
// single hardcoded default ClickHouse instance.

import type { Pool } from 'pg';
import {
  ClickHouseOtelAggregateSource, ClickHouseOtelTraceSource, TempoTraceSource, MetricsCallsSource,
  otelAggregateShape, type TraceSource,
} from '@/lib/trace-source';

interface GraphQueryRow {
  integration_id: number;
  query: { tool?: string; mapper?: string; args_template?: Record<string, unknown> } | null;
}

export interface GraphSources {
  sources: TraceSource[];
  metricsSources: MetricsCallsSource[];
  /** Query failure is also signaled to coordinators; the synthetic error source still drives retention. */
  registryFailed?: true;
}

// JOIN against integrations as defense-in-depth against an orphan row (deleteDatasource() sweeps
// datasource_graph_queries on delete, but a row surviving that sweep — e.g. a race, or predating
// that fix — must still never surface a source for an instance that no longer exists).
const READY_GRAPH_QUERIES = `SELECT gq.integration_id, gq.query FROM datasource_graph_queries gq
       JOIN integrations i ON i.id = gq.integration_id
       WHERE gq.account_id = 'self' AND gq.status = 'ready'`;

const otelTemplate = (q: GraphQueryRow['query']) => {
  const sql = q?.args_template?.sql;
  return typeof sql === 'string' ? sql : undefined;
};

export interface ClickHouseTraceDatasource { instanceId: number; template?: string }

/** The registered ClickHouse trace datasources (`otel_v1` catalog rows) with their catalog SQL
 *  template, read the same way loadGraphSources does. Unlike it there is no bare-default fallback:
 *  callers report "no trace source" instead of guessing an unregistered default instance.
 *  Duplicate (instance, template) rows collapse to one. Throws on registry read failure. */
export async function listClickHouseTraceDatasources(pool: Pool): Promise<ClickHouseTraceDatasource[]> {
  const r = await pool.query(READY_GRAPH_QUERIES);
  const seen = new Set<string>();
  const out: ClickHouseTraceDatasource[] = [];
  for (const row of r.rows as GraphQueryRow[]) {
    if (row.query?.mapper !== 'otel_v1' || !Number.isSafeInteger(row.integration_id)) continue;
    const template = otelTemplate(row.query);
    const key = JSON.stringify([row.integration_id, template ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ instanceId: row.integration_id, ...(template !== undefined ? { template } : {}) });
  }
  return out;
}

/** Load ready graph-source adapters across every registered datasource instance. Falls back to a
 *  bare default ClickHouseOtelTraceSource (the pre-registry behavior) when no ready row exists yet
 *  — a fresh environment before the first daily datasource_index run.
 *  Registry failures are explicit evidence failures, never a silent default-source fallback. */
export async function loadGraphSources(pool: Pool): Promise<GraphSources> {
  let rows: GraphQueryRow[] = [];
  try {
    const r = await pool.query(READY_GRAPH_QUERIES);
    rows = r.rows as GraphQueryRow[];
  } catch {
    return {
      registryFailed: true,
      sources: [{
        available: async () => false,
        recentSpans: async (windowMins, _cap, endMs = Date.now()) => ({
          sourceId: 'graph-registry', status: 'error', items: [], reasons: ['registry_read_failed'],
          windowStartMs: endMs - windowMins * 60_000, windowEndMs: endMs,
        }),
      }],
      metricsSources: [],
    };
  }

  const sources: TraceSource[] = [];
  const metricsSources: MetricsCallsSource[] = [];
  for (const row of rows) {
    const q = row.query;
    const mapper = q?.mapper;
    if (mapper === 'otel_v1') {
      const template = otelTemplate(q);
      // The catalog's exporter-schema template is read as whole-window aggregates; any other
      // (generated/custom) template keeps the bounded newest-span reader.
      const shape = otelAggregateShape(template);
      sources.push(shape ? new ClickHouseOtelAggregateSource(row.integration_id, shape, template)
        : new ClickHouseOtelTraceSource(row.integration_id, template));
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
    sources.push(new ClickHouseOtelAggregateSource());
  }
  return { sources, metricsSources };
}
