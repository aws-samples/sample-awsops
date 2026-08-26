import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDefaultDatasource = vi.fn();
const getDatasource = vi.fn();
const resolveConnConfig = vi.fn();
const invokeMcpLambdaTool = vi.fn();
vi.mock('@/lib/datasources', () => ({
  getDefaultDatasource: (...a: unknown[]) => getDefaultDatasource(...a),
  getDatasource: (...a: unknown[]) => getDatasource(...a),
  resolveConnConfig: (...a: unknown[]) => resolveConnConfig(...a),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({
  invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a),
}));

import {
  FakeTraceSource,
  ClickHouseOtelTraceSource,
  TempoTraceSource,
  MetricsCallsSource,
  mapOtelRow,
  mapTempoTrace,
  extractServiceGraphCalls,
  type TraceSpan,
} from './trace-source';

const span = (over: Partial<TraceSpan> = {}): TraceSpan => ({
  traceId: 't1', spanId: 's1', service: 'svc', kind: 'SERVER', startMs: 0, durationMs: 1, ...over,
});

describe('FakeTraceSource (TraceSource contract)', () => {
  it('reports its availability flag and returns seeded spans up to cap', async () => {
    const spans = [span({ spanId: 'a' }), span({ spanId: 'b' }), span({ spanId: 'c' })];
    const src = new FakeTraceSource(spans, true);
    expect(await src.available()).toBe(true);
    expect(await src.recentSpans(60, 2)).toHaveLength(2);
    expect(await src.recentSpans(60, 99)).toHaveLength(3);
  });

  it('available() false when constructed unavailable', async () => {
    const src = new FakeTraceSource([], false);
    expect(await src.available()).toBe(false);
  });
});

describe('mapOtelRow (real nested-map otel_traces shape)', () => {
  it('extracts service / db / k8s from the Map columns + top-level fields', () => {
    const row = {
      TraceId: 'abc', SpanId: 'def', ParentSpanId: 'par',
      ServiceName: 'checkout', SpanKind: 'SPAN_KIND_CLIENT',
      Timestamp: '2026-06-25T00:00:00.000Z',
      Duration: 5_000_000, // 5ms in ns
      ResourceAttributes: {
        'service.name': 'checkout',
        'k8s.namespace.name': 'shop', 'k8s.pod.name': 'checkout-xyz', 'k8s.deployment.name': 'checkout',
        'k8s.cluster.name': 'mall-apne2-az-a',
      },
      SpanAttributes: { 'db.system': 'postgresql', 'db.name': 'orders', 'server.address': 'aurora.example.rds' },
    };
    const s = mapOtelRow(row);
    expect(s).toMatchObject({
      traceId: 'abc', spanId: 'def', parentSpanId: 'par', service: 'checkout',
      dbSystem: 'postgresql', dbName: 'orders', dbHost: 'aurora.example.rds',
      k8sNamespace: 'shop', k8sPod: 'checkout-xyz', k8sDeployment: 'checkout',
      k8sCluster: 'mall-apne2-az-a',
      durationMs: 5,
    });
    expect(s.startMs).toBe(Date.parse('2026-06-25T00:00:00.000Z'));
  });

  it('falls back to ResourceAttributes service.name and omits absent attrs', () => {
    const s = mapOtelRow({ ResourceAttributes: { 'service.name': 'edge' }, SpanAttributes: {} });
    expect(s.service).toBe('edge');
    expect(s.dbSystem).toBeUndefined();
    expect(s.k8sNamespace).toBeUndefined();
    expect(s.parentSpanId).toBeUndefined();
  });
});

describe('ClickHouseOtelTraceSource', () => {
  beforeEach(() => {
    getDefaultDatasource.mockReset(); getDatasource.mockReset(); resolveConnConfig.mockReset(); invokeMcpLambdaTool.mockReset();
  });

  it('available() false when there is no default clickhouse instance', async () => {
    getDefaultDatasource.mockResolvedValue(null);
    expect(await new ClickHouseOtelTraceSource().available()).toBe(false);
  });

  it('available() true when a default clickhouse instance resolves', async () => {
    getDefaultDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', isDefault: true });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch' });
    expect(await new ClickHouseOtelTraceSource().available()).toBe(true);
  });

  it('recentSpans runs a read-only SELECT against otel_traces and maps rows', async () => {
    getDefaultDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', isDefault: true });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch' });
    invokeMcpLambdaTool.mockResolvedValue({
      rows: [{ ServiceName: 'a', SpanAttributes: {}, ResourceAttributes: {} }],
    });
    const out = await new ClickHouseOtelTraceSource().recentSpans(30, 100);
    expect(out).toHaveLength(1);
    expect(out[0].service).toBe('a');
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(call.kind).toBe('clickhouse');
    expect(call.tool).toBe('clickhouse_query');
    expect(String(call.args.sql)).toMatch(/SELECT[\s\S]*otel_traces/);
    expect(String(call.args.sql)).toMatch(/LIMIT 100/);
  });

  it('recentSpans returns [] (no throw) when the query fails (otel_traces absent)', async () => {
    getDefaultDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', isDefault: true });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch' });
    invokeMcpLambdaTool.mockRejectedValue(new Error('UNKNOWN_TABLE'));
    expect(await new ClickHouseOtelTraceSource().recentSpans(30, 100)).toEqual([]);
  });

  it('explicit instanceId resolves the row by id (not the kind default)', async () => {
    getDatasource.mockResolvedValue({ id: 42, kind: 'clickhouse', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch-42' });
    expect(await new ClickHouseOtelTraceSource(42).available()).toBe(true);
    expect(getDatasource).toHaveBeenCalledWith(42);
    expect(getDefaultDatasource).not.toHaveBeenCalled();
  });

  it('explicit instanceId → false when the id is missing or not a clickhouse instance', async () => {
    getDatasource.mockResolvedValueOnce(null);
    expect(await new ClickHouseOtelTraceSource(99).available()).toBe(false);
    getDatasource.mockResolvedValueOnce({ id: 5, kind: 'prometheus', isDefault: false });
    expect(await new ClickHouseOtelTraceSource(5).available()).toBe(false);
  });

  it('a custom sqlTemplate (from graph_catalog.py, schema-driven table name) is used verbatim with {window}/{cap} substituted', async () => {
    getDatasource.mockResolvedValue({ id: 42, kind: 'clickhouse', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch-42' });
    invokeMcpLambdaTool.mockResolvedValue({ rows: [] });
    const template = 'SELECT TraceId FROM my_custom_spans WHERE Timestamp >= now() - INTERVAL {window} MINUTE LIMIT {cap}';
    await new ClickHouseOtelTraceSource(42, template).recentSpans(15, 50);
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(String(call.args.sql)).toBe('SELECT TraceId FROM my_custom_spans WHERE Timestamp >= now() - INTERVAL 15 MINUTE LIMIT 50');
  });

  it('substitutes EVERY occurrence of {window}/{cap}, not just the first — an LLM-generated template' +
    ' (graph_querygen.py) can plausibly reference a placeholder more than once', async () => {
    getDatasource.mockResolvedValue({ id: 42, kind: 'clickhouse', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch-42' });
    invokeMcpLambdaTool.mockResolvedValue({ rows: [] });
    const template = 'SELECT TraceId FROM t WHERE Timestamp >= now() - INTERVAL {window} MINUTE ' +
      'AND Timestamp <= now() + INTERVAL {window} MINUTE LIMIT {cap} SETTINGS max_rows = {cap}';
    await new ClickHouseOtelTraceSource(42, template).recentSpans(15, 50);
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(String(call.args.sql)).toBe(
      'SELECT TraceId FROM t WHERE Timestamp >= now() - INTERVAL 15 MINUTE ' +
      'AND Timestamp <= now() + INTERVAL 15 MINUTE LIMIT 50 SETTINGS max_rows = 50',
    );
  });
});

// ── TempoTraceSource (registry-driven graph sources, 2026-07-08) ───────────────────────────────────
describe('mapTempoTrace (OTLP-JSON {batches:[...]} shape from tempo_get_trace)', () => {
  it('extracts service / db / k8s from resource + span attributes across scopeSpans', () => {
    const result = {
      batches: [{
        resource: { attributes: [
          { key: 'service.name', value: { stringValue: 'checkout' } },
          { key: 'k8s.namespace.name', value: { stringValue: 'shop' } },
          { key: 'k8s.pod.name', value: { stringValue: 'checkout-1' } },
          { key: 'k8s.deployment.name', value: { stringValue: 'checkout' } },
        ] },
        scopeSpans: [{
          spans: [{
            spanId: 'sp1', parentSpanId: 'par1', kind: 2,
            startTimeUnixNano: '1000000000', endTimeUnixNano: '1005000000',
            attributes: [
              { key: 'db.system', value: { stringValue: 'postgresql' } },
              { key: 'db.name', value: { stringValue: 'orders' } },
              { key: 'server.address', value: { stringValue: 'aurora.example.rds' } },
            ],
          }],
        }],
      }],
    };
    const spans = mapTempoTrace('trace-abc', result);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      traceId: 'trace-abc', spanId: 'sp1', parentSpanId: 'par1', service: 'checkout', kind: 'SERVER',
      dbSystem: 'postgresql', dbName: 'orders', dbHost: 'aurora.example.rds',
      k8sNamespace: 'shop', k8sPod: 'checkout-1', k8sDeployment: 'checkout',
      durationMs: 5,
    });
  });

  it('falls back gracefully (no throw) on a missing/malformed batches shape', () => {
    expect(mapTempoTrace('t', null)).toEqual([]);
    expect(mapTempoTrace('t', {})).toEqual([]);
    expect(mapTempoTrace('t', { batches: [{}] })).toEqual([]);
  });
});

describe('TempoTraceSource', () => {
  beforeEach(() => {
    getDatasource.mockReset(); resolveConnConfig.mockReset(); invokeMcpLambdaTool.mockReset();
  });

  it('available() true when the instance resolves as a tempo datasource', async () => {
    getDatasource.mockResolvedValue({ id: 9, kind: 'tempo', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://tempo' });
    expect(await new TempoTraceSource(9).available()).toBe(true);
  });

  it('available() false when the id is missing or not a tempo instance', async () => {
    getDatasource.mockResolvedValueOnce(null);
    expect(await new TempoTraceSource(9).available()).toBe(false);
    getDatasource.mockResolvedValueOnce({ id: 9, kind: 'loki', isDefault: false });
    expect(await new TempoTraceSource(9).available()).toBe(false);
  });

  it('recentSpans searches then fetches each trace, mapping spans (bounded ≤20 get-trace calls)', async () => {
    getDatasource.mockResolvedValue({ id: 9, kind: 'tempo', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://tempo' });
    invokeMcpLambdaTool.mockImplementation(async ({ tool }: { tool: string }) => {
      if (tool === 'tempo_search') return { traces: [{ traceID: 'a' }, { traceID: 'b' }] };
      if (tool === 'tempo_get_trace') {
        return { batches: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{ spanId: 's', kind: 1 }] }] }] };
      }
      throw new Error('unexpected tool');
    });
    const out = await new TempoTraceSource(9).recentSpans(60, 1000);
    expect(out).toHaveLength(2); // one span per trace, 2 traces
    const searchCall = invokeMcpLambdaTool.mock.calls.find((c) => c[0].tool === 'tempo_search')![0];
    expect(searchCall.kind).toBe('tempo');
    expect(searchCall.args.limit).toBe(20);
  });

  it('returns [] (no throw) when the search call fails', async () => {
    getDatasource.mockResolvedValue({ id: 9, kind: 'tempo', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://tempo' });
    invokeMcpLambdaTool.mockRejectedValue(new Error('down'));
    expect(await new TempoTraceSource(9).recentSpans(60, 1000)).toEqual([]);
  });

  it('one bad trace fetch does not drop the others', async () => {
    getDatasource.mockResolvedValue({ id: 9, kind: 'tempo', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://tempo' });
    invokeMcpLambdaTool.mockImplementation(async ({ tool, args }: { tool: string; args: { trace_id?: string } }) => {
      if (tool === 'tempo_search') return { traces: [{ traceID: 'good' }, { traceID: 'bad' }] };
      if (args.trace_id === 'bad') throw new Error('fetch failed');
      return { batches: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{ spanId: 's', kind: 1 }] }] }] };
    });
    const out = await new TempoTraceSource(9).recentSpans(60, 1000);
    expect(out).toHaveLength(1);
  });
});

describe('extractServiceGraphCalls (Prometheus/Mimir instant-query vector result)', () => {
  it('extracts {client,server,count} from a servicegraph_v1-shaped vector (client/server labels)', () => {
    const result = { resultType: 'vector', result: [
      { metric: { client: 'checkout', server: 'orders' }, value: [1234567890, '5'] },
      { metric: { client: 'orders', server: 'postgres' }, value: [1234567890, '2'] },
    ] };
    expect(extractServiceGraphCalls(result)).toEqual([
      { client: 'checkout', server: 'orders', count: 5 },
      { client: 'orders', server: 'postgres', count: 2 },
    ]);
  });

  it('extracts from an istio_v1-shaped vector (source_workload/destination_workload labels)', () => {
    const result = { result: [
      { metric: { source_workload: 'checkout', destination_workload: 'orders' }, value: [0, '3'] },
    ] };
    expect(extractServiceGraphCalls(result)).toEqual([{ client: 'checkout', server: 'orders', count: 3 }]);
  });

  it('drops zero/negative/non-numeric counts and malformed rows without throwing', () => {
    expect(extractServiceGraphCalls(null)).toEqual([]);
    expect(extractServiceGraphCalls({})).toEqual([]);
    expect(extractServiceGraphCalls({ result: [{ metric: {}, value: [0, '5'] }] })).toEqual([]); // no client/server
    expect(extractServiceGraphCalls({ result: [{ metric: { client: 'a', server: 'b' }, value: [0, '0'] }] })).toEqual([]);
  });
});

describe('MetricsCallsSource', () => {
  beforeEach(() => {
    getDatasource.mockReset(); resolveConnConfig.mockReset(); invokeMcpLambdaTool.mockReset();
  });

  it('available() true when the instance resolves as the expected kind', async () => {
    getDatasource.mockResolvedValue({ id: 3, kind: 'prometheus', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://prom' });
    expect(await new MetricsCallsSource(3, 'prometheus', 'sum(x[{window}m])').available()).toBe(true);
  });

  it('available() false when the instance kind does not match', async () => {
    getDatasource.mockResolvedValue({ id: 3, kind: 'mimir', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://x' });
    expect(await new MetricsCallsSource(3, 'prometheus', 'sum(x[{window}m])').available()).toBe(false);
  });

  it('calls() substitutes {window} into the PromQL template and queries the right tool', async () => {
    getDatasource.mockResolvedValue({ id: 3, kind: 'prometheus', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://prom' });
    invokeMcpLambdaTool.mockResolvedValue({ result: [{ metric: { client: 'a', server: 'b' }, value: [0, '1'] }] });
    const out = await new MetricsCallsSource(3, 'prometheus', 'sum by (client,server) (increase(x[{window}m]))').calls(30);
    expect(out).toEqual([{ client: 'a', server: 'b', count: 1 }]);
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(call.kind).toBe('prometheus');
    expect(call.tool).toBe('prometheus_query');
    expect(call.args.query).toBe('sum by (client,server) (increase(x[30m]))');
  });

  it('calls() substitutes EVERY {window} occurrence, not just the first', async () => {
    getDatasource.mockResolvedValue({ id: 3, kind: 'prometheus', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://prom' });
    invokeMcpLambdaTool.mockResolvedValue({ result: [] });
    const template = 'sum by (client,server) (increase(x[{window}m]) / increase(y[{window}m]))';
    await new MetricsCallsSource(3, 'prometheus', template).calls(30);
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(call.args.query).toBe('sum by (client,server) (increase(x[30m]) / increase(y[30m]))');
  });

  it('calls() returns [] (no throw) when the instance is unavailable or the query fails', async () => {
    getDatasource.mockResolvedValue(null);
    expect(await new MetricsCallsSource(3, 'mimir', 'x').calls(30)).toEqual([]);
    getDatasource.mockResolvedValue({ id: 3, kind: 'mimir', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://x' });
    invokeMcpLambdaTool.mockRejectedValue(new Error('down'));
    expect(await new MetricsCallsSource(3, 'mimir', 'x').calls(30)).toEqual([]);
  });
});
