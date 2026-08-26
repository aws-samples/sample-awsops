import { describe, it, expect, vi } from 'vitest';
// trace-source.ts transitively imports datasources.ts → db.ts → aws-sdk (rds-signer). Stub it so this
// mapper-selection test needs no AWS SDK — mirrors graph-store-trace.test.ts's pattern.
vi.mock('@/lib/datasources', () => ({
  getDatasource: vi.fn(async () => null),
  getDefaultDatasource: vi.fn(async () => null),
  resolveConnConfig: vi.fn(async () => ({})),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: vi.fn(async () => ({ rows: [] })) }));
import { loadGraphSources } from './graph-sources';
import { ClickHouseOtelTraceSource, TempoTraceSource, MetricsCallsSource } from './trace-source';

// Adapter internals (connector calls, credential resolution) are covered by trace-source.test.ts —
// this file only tests the mapper→adapter selection/wiring logic, so no need to mock datasources/
// mcp-lambda-invoke: we never call available()/recentSpans()/calls() on the returned adapters here.
function mockPool(rows: unknown[]) {
  return { query: vi.fn(async () => ({ rows })) } as unknown as import('pg').Pool;
}

describe('loadGraphSources', () => {
  it('maps an otel_v1 ready row to a ClickHouseOtelTraceSource carrying the schema-driven SQL template', async () => {
    const pool = mockPool([
      { integration_id: 7, query: { tool: 'clickhouse_query', mapper: 'otel_v1', args_template: { sql: 'SELECT 1 FROM t LIMIT {cap}' } } },
    ]);
    const { sources, metricsSources } = await loadGraphSources(pool);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(ClickHouseOtelTraceSource);
    expect(metricsSources).toHaveLength(0);
    const s = sources[0] as unknown as { instanceId: number; sqlTemplate?: string };
    expect(s.instanceId).toBe(7);
    expect(s.sqlTemplate).toBe('SELECT 1 FROM t LIMIT {cap}');
  });

  it('maps a tempo_v1 ready row to a TempoTraceSource', async () => {
    const pool = mockPool([
      { integration_id: 9, query: { tool: 'tempo_search', mapper: 'tempo_v1', args_template: { query: '{}', limit: 20 } } },
    ]);
    const { sources } = await loadGraphSources(pool);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(TempoTraceSource);
    expect((sources[0] as unknown as { instanceId: number }).instanceId).toBe(9);
  });

  it('maps servicegraph_v1/istio_v1 ready rows to MetricsCallsSource with the right kind + PromQL template', async () => {
    const pool = mockPool([
      { integration_id: 3, query: { tool: 'prometheus_query', mapper: 'servicegraph_v1', args_template: { query: 'sum(x[{window}m])' } } },
      { integration_id: 4, query: { tool: 'mimir_query', mapper: 'istio_v1', args_template: { query: 'sum(y[{window}m])' } } },
    ]);
    const { sources, metricsSources } = await loadGraphSources(pool);
    expect(sources).toHaveLength(0);
    expect(metricsSources).toHaveLength(2);
    expect(metricsSources[0]).toBeInstanceOf(MetricsCallsSource);
    const m0 = metricsSources[0] as unknown as { instanceId: number; kind: string; promqlTemplate: string };
    expect(m0).toMatchObject({ instanceId: 3, kind: 'prometheus', promqlTemplate: 'sum(x[{window}m])' });
    const m1 = metricsSources[1] as unknown as { instanceId: number; kind: string };
    expect(m1).toMatchObject({ instanceId: 4, kind: 'mimir' });
  });

  it('skips unavailable/malformed rows without throwing (falls back to the default, none were usable)', async () => {
    const pool = mockPool([
      { integration_id: 1, query: null },
      { integration_id: 2, query: { mapper: 'unknown_mapper' } },
      { integration_id: 3, query: { mapper: 'servicegraph_v1', args_template: {} } }, // no query string
    ]);
    const { sources, metricsSources } = await loadGraphSources(pool);
    // none of the 3 rows produced a usable adapter → the empty-result fallback kicks in (1 bare default)
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(ClickHouseOtelTraceSource);
    expect((sources[0] as unknown as { instanceId?: number }).instanceId).toBeUndefined();
    expect(metricsSources).toHaveLength(0);
  });

  it('falls back to a bare default ClickHouseOtelTraceSource when no ready rows exist yet', async () => {
    const pool = mockPool([]);
    const { sources, metricsSources } = await loadGraphSources(pool);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(ClickHouseOtelTraceSource);
    const s = sources[0] as unknown as { instanceId?: number; sqlTemplate?: string };
    expect(s.instanceId).toBeUndefined();
    expect(s.sqlTemplate).toBeUndefined();
    expect(metricsSources).toHaveLength(0);
  });

  it('never throws when the query itself fails (treated as no ready rows → fallback)', async () => {
    const pool = { query: vi.fn(async () => { throw new Error('db down'); }) } as unknown as import('pg').Pool;
    const { sources } = await loadGraphSources(pool);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(ClickHouseOtelTraceSource);
  });

  it('joins against integrations so a row for a deleted instance is skipped (M3 defense-in-depth, independent of deleteDatasource\'s sweep)', async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toMatch(/JOIN integrations/i); // loader itself excludes orphans, not just the delete-path sweep
      return { rows: [] }; // the mock has no matching integrations row — nothing comes back
    });
    const pool = { query } as unknown as import('pg').Pool;
    const { sources } = await loadGraphSources(pool);
    expect(sources).toHaveLength(1); // no ready rows survived the join → bare default fallback
    expect(sources[0]).toBeInstanceOf(ClickHouseOtelTraceSource);
    expect((sources[0] as unknown as { instanceId?: number }).instanceId).toBeUndefined();
  });
});
