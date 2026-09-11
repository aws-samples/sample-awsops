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
    expect((await src.recentSpans(60, 2)).items).toHaveLength(2);
    expect((await src.recentSpans(60, 99)).items).toHaveLength(3);
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
      rows: [{ TraceId: 't', SpanId: 's', Timestamp: new Date().toISOString(), Duration: 1,
        ServiceName: 'a', SpanAttributes: {}, ResourceAttributes: {} }],
    });
    const out = await new ClickHouseOtelTraceSource().recentSpans(30, 100);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].service).toBe('a');
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(call.kind).toBe('clickhouse');
    expect(call.tool).toBe('clickhouse_query');
    expect(String(call.args.sql)).toMatch(/SELECT[\s\S]*otel_traces/);
    expect(String(call.args.sql)).toMatch(/LIMIT 100/);
  });

  it('reports query failure separately from a successful empty read', async () => {
    getDefaultDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', isDefault: true });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch' });
    invokeMcpLambdaTool.mockRejectedValue(new Error('UNKNOWN_TABLE'));
    expect(await new ClickHouseOtelTraceSource().recentSpans(30, 100)).toMatchObject({
      items: [], status: 'error', sourceId: 'clickhouse:7', reasons: ['query_failed'],
    });
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
    await new ClickHouseOtelTraceSource(42, template).recentSpans(15, 50, 1_000_000);
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(String(call.args.sql)).toBe('SELECT TraceId FROM my_custom_spans WHERE Timestamp >= fromUnixTimestamp64Milli(1000000) - INTERVAL 15 MINUTE LIMIT 50');
  });

  it('substitutes EVERY occurrence of {window}/{cap}, not just the first — an LLM-generated template' +
    ' (graph_querygen.py) can plausibly reference a placeholder more than once', async () => {
    getDatasource.mockResolvedValue({ id: 42, kind: 'clickhouse', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch-42' });
    invokeMcpLambdaTool.mockResolvedValue({ rows: [] });
    const template = 'SELECT TraceId FROM t WHERE Timestamp >= now() - INTERVAL {window} MINUTE ' +
      'AND Timestamp <= now() + INTERVAL {window} MINUTE LIMIT {cap} SETTINGS max_rows = {cap}';
    await new ClickHouseOtelTraceSource(42, template).recentSpans(15, 50, 1_000_000);
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(String(call.args.sql)).toBe(
      'SELECT TraceId FROM t WHERE Timestamp >= fromUnixTimestamp64Milli(1000000) - INTERVAL 15 MINUTE ' +
      'AND Timestamp <= fromUnixTimestamp64Milli(1000000) + INTERVAL 15 MINUTE LIMIT 50 SETTINGS max_rows = 50',
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
        return { batches: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{
          spanId: 's', kind: 1, startTimeUnixNano: String((Date.now() - 1000) * 1e6),
          endTimeUnixNano: String((Date.now() - 999) * 1e6),
        }] }] }] };
      }
      throw new Error('unexpected tool');
    });
    const out = await new TempoTraceSource(9).recentSpans(60, 1000);
    expect(out.items).toHaveLength(2); // one span per trace, 2 traces
    const searchCall = invokeMcpLambdaTool.mock.calls.find((c) => c[0].tool === 'tempo_search')![0];
    expect(searchCall.kind).toBe('tempo');
    expect(searchCall.args.limit).toBe(20);
  });

  it('reports an error when the search call fails', async () => {
    getDatasource.mockResolvedValue({ id: 9, kind: 'tempo', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://tempo' });
    invokeMcpLambdaTool.mockRejectedValue(new Error('down'));
    expect(await new TempoTraceSource(9).recentSpans(60, 1000)).toMatchObject({
      items: [], status: 'error', reasons: ['query_failed'],
    });
  });

  it('one bad trace fetch does not drop the others', async () => {
    getDatasource.mockResolvedValue({ id: 9, kind: 'tempo', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://tempo' });
    invokeMcpLambdaTool.mockImplementation(async ({ tool, args }: { tool: string; args: { trace_id?: string } }) => {
      if (tool === 'tempo_search') return { traces: [{ traceID: 'good' }, { traceID: 'bad' }] };
      if (args.trace_id === 'bad') throw new Error('fetch failed');
      return { batches: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{
        spanId: 's', kind: 1, startTimeUnixNano: String((Date.now() - 1000) * 1e6),
        endTimeUnixNano: String((Date.now() - 999) * 1e6),
      }] }] }] };
    });
    const out = await new TempoTraceSource(9).recentSpans(60, 1000);
    expect(out.items).toHaveLength(1);
    expect(out.status).toBe('partial');
    expect(out.reasons).toContain('trace_fetch_failed');
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
    expect(out.items).toEqual([{ client: 'a', server: 'b', count: 1,
      clientIdentity: { sourceId: 'prometheus:3' }, serverIdentity: { sourceId: 'prometheus:3' } }]);
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

  it('calls() distinguishes missing configuration from query failure', async () => {
    getDatasource.mockResolvedValue(null);
    expect(await new MetricsCallsSource(3, 'mimir', 'x').calls(30)).toMatchObject({
      items: [], status: 'unavailable', reasons: ['missing_configuration'],
    });
    getDatasource.mockResolvedValue({ id: 3, kind: 'mimir', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://x' });
    invokeMcpLambdaTool.mockRejectedValue(new Error('down'));
    expect(await new MetricsCallsSource(3, 'mimir', 'x').calls(30)).toMatchObject({
      items: [], status: 'error', reasons: ['query_failed'],
    });
  });
});

const END_MS = Date.parse('2026-09-01T12:00:00.000Z');
const attrs = (values: Record<string, string>) =>
  Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } }));
const resource = {
  'service.name': 'checkout', 'cloud.account.id': '123456789012', 'cloud.region': 'ap-northeast-2',
  'deployment.environment.name': 'prod', 'deployment.environment': 'legacy',
  'service.namespace': 'payments', 'service.version': 'v2',
  'k8s.namespace.name': 'shop', 'k8s.cluster.name': 'mall',
  'k8s.pod.name': 'checkout-1', 'k8s.deployment.name': 'checkout',
};
const otelRow = (over: Record<string, unknown> = {}) => ({
  TraceId: 'trace', SpanId: 'span', ServiceName: 'checkout', SpanKind: 'CLIENT',
  Timestamp: new Date(END_MS - 1000).toISOString(), Duration: 1_000_000,
  ResourceAttributes: resource, SpanAttributes: {}, ...over,
});
const tempoSpan = (over: Record<string, unknown> = {}) => ({
  spanId: 'span', kind: 3, startTimeUnixNano: String((END_MS - 1000) * 1e6),
  endTimeUnixNano: String(END_MS * 1e6), ...over,
});
const tempoTrace = (spans: unknown[] = [tempoSpan()]) => ({
  batches: [{ resource: { attributes: attrs(resource) }, scopeSpans: [{ spans }] }],
});

describe('trace metadata allowlist', () => {
  const identity = {
    accountId: '123456789012', region: 'ap-northeast-2', environment: 'prod',
    serviceNamespace: 'payments', serviceVersion: 'v2', k8sNamespace: 'shop', k8sCluster: 'mall',
    k8sPod: 'checkout-1', k8sDeployment: 'checkout',
  };

  it('ClickHouse preserves scope, operation, status, messaging and links without raw attributes', () => {
    const result = mapOtelRow(otelRow({
      SpanName: 'publish orders', StatusCode: 'Error',
      'Links.TraceId': ['previous'], 'Links.SpanId': ['producer'],
      'Links.Attributes': [{ authorization: 'secret' }], StatusMessage: 'password=secret',
      SpanAttributes: {
        'messaging.system': 'kafka', 'messaging.destination.name': 'orders',
        'db.connection_string': 'postgres://user:secret@db', authorization: 'secret',
      },
    }));
    expect(result).toMatchObject({
      ...identity, name: 'publish orders', status: 'error',
      messagingSystem: 'kafka', messagingDestination: 'orders',
      links: [{ traceId: 'previous', spanId: 'producer' }],
    });
    expect(result).not.toHaveProperty('ResourceAttributes');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('Tempo preserves resource scope and linked span IDs, discarding status messages/link attributes', () => {
    const result = mapTempoTrace('trace', tempoTrace([tempoSpan({
      name: 'publish orders', status: { code: 2, message: 'secret' },
      links: [{ traceId: 'previous', spanId: 'producer', attributes: attrs({ token: 'secret' }) }],
      attributes: attrs({ 'messaging.system': 'kafka', 'messaging.destination': 'orders', token: 'secret' }),
    })]));
    expect(result[0]).toMatchObject({
      ...identity, name: 'publish orders', status: 'error',
      messagingSystem: 'kafka', messagingDestination: 'orders',
      links: [{ traceId: 'previous', spanId: 'producer' }],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([['Ok', 1, 'ok'], ['Error', 2, 'error'], ['Unset', 0, 'unset']] as const)(
    'normalizes status %s in both backends', (ch, otlp, expected) => {
      expect(mapOtelRow(otelRow({ StatusCode: ch })).status).toBe(expected);
      expect(mapTempoTrace('trace', tempoTrace([tempoSpan({ status: { code: otlp } })]))[0].status).toBe(expected);
    },
  );

  it('uses the legacy environment fallback and leaves missing scope unknown', () => {
    expect(mapOtelRow(otelRow({ ResourceAttributes: { 'deployment.environment': 'staging' } })))
      .toMatchObject({ environment: 'staging' });
    const result = mapTempoTrace('trace', {
      resourceSpans: [{ resource: { attributes: attrs({ 'deployment.environment': 'staging' }) },
        scopeSpans: [{ spans: [tempoSpan()] }] }],
    });
    expect(result[0]).toMatchObject({ environment: 'staging' });
    expect(result[0].accountId).toBeUndefined();
    expect(result[0].serviceNamespace).toBeUndefined();
  });
});

describe('SourceRead provenance and bounds', () => {
  beforeEach(() => {
    getDatasource.mockReset(); getDefaultDatasource.mockReset(); resolveConnConfig.mockReset(); invokeMcpLambdaTool.mockReset();
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://fixture', token: 'private-token' });
  });
  const configure = (kind: string, id = 7) => {
    getDatasource.mockResolvedValue({ id, kind });
    getDefaultDatasource.mockResolvedValue({ id, kind });
  };
  const factories = [
    ['clickhouse', () => new ClickHouseOtelTraceSource().recentSpans(30, 10, END_MS), { rows: [] }],
    ['tempo', () => new TempoTraceSource(7).recentSpans(30, 10, END_MS), { traces: [] }],
    ['prometheus', () => new MetricsCallsSource(7, 'prometheus', 'x[{window}m]').calls(30, END_MS), { resultType: 'vector', result: [] }],
    ['mimir', () => new MetricsCallsSource(7, 'mimir', 'x[{window}m]').calls(30, END_MS), { resultType: 'vector', result: [] }],
  ] as const;

  it.each(factories)('%s returns ok with exact window for successful empty data', async (kind, read, payload) => {
    configure(kind);
    invokeMcpLambdaTool.mockResolvedValue(payload);
    expect(await read()).toEqual({
      items: [], status: 'ok', sourceId: `${kind}:7`, reasons: [],
      windowStartMs: END_MS - 1_800_000, windowEndMs: END_MS,
    });
  });

  it.each(factories)('%s never turns errors/malformed payloads/truncation into valid empty data', async (kind, read) => {
    configure(kind);
    for (const payload of [null, {}, { error: 'private-token' }, { truncated: true, preview: 'private-token' }]) {
      invokeMcpLambdaTool.mockResolvedValue(payload);
      const result = await read();
      expect(result.status).toBe('error');
      expect(result.items).toEqual([]);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain('private-token');
    }
  });

  it.each(factories)('%s reports missing/failed config without leaking secrets or throwing', async (kind, read) => {
    getDatasource.mockResolvedValue(null); getDefaultDatasource.mockResolvedValue(null);
    expect(await read()).toMatchObject({ status: 'unavailable', reasons: ['missing_configuration'] });
    configure(kind, 42);
    resolveConnConfig.mockRejectedValue(new Error('private-token'));
    const failed = await read();
    expect(failed).toMatchObject({ status: 'error', sourceId: `${kind}:42`, reasons: ['configuration_failed'] });
    expect(JSON.stringify(failed)).not.toContain('private-token');
  });

  it('FakeTraceSource supplies provenance and cap status without mutating seeded identities', async () => {
    const seeded = [span(), span({ spanId: 's2' })];
    const result = await new FakeTraceSource(seeded).recentSpans(30, 1, END_MS);
    expect(result).toMatchObject({
      status: 'partial', reasons: ['cap_reached'], sourceId: 'fake:default',
      windowStartMs: END_MS - 1_800_000, windowEndMs: END_MS,
      items: [{ sourceId: 'fake:default' }],
    });
    expect(seeded[0].sourceId).toBeUndefined();
    expect(await new FakeTraceSource(seeded, false).recentSpans(30, 10, END_MS))
      .toMatchObject({ items: [], status: 'unavailable' });
  });

  it('ClickHouse bounds results locally, stamps the resolved default ID and marks the SQL cap', async () => {
    configure('clickhouse', 42);
    invokeMcpLambdaTool.mockResolvedValue({ rows: [otelRow(), otelRow({ SpanId: 's2' }), otelRow({ SpanId: 's3' })] });
    const result = await new ClickHouseOtelTraceSource().recentSpans(30, 2, END_MS);
    expect(result).toMatchObject({ status: 'partial', sourceId: 'clickhouse:42', reasons: ['cap_reached'] });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((s) => s.sourceId === 'clickhouse:42')).toBe(true);
    const { sql, max_rows } = invokeMcpLambdaTool.mock.calls[0][0].args;
    expect(max_rows).toBe(2);
    expect(sql).toContain(`fromUnixTimestamp64Milli(${END_MS})`);
    expect(sql).toMatch(/Timestamp\s*<=/);
  });

  it('ClickHouse limits the connector to 1000 rows even for larger requested caps', async () => {
    configure('clickhouse');
    invokeMcpLambdaTool.mockResolvedValue({ rows: Array.from({ length: 1000 }, (_, i) => otelRow({ SpanId: String(i) })) });
    const result = await new ClickHouseOtelTraceSource().recentSpans(30, 5000, END_MS);
    expect(invokeMcpLambdaTool.mock.calls[0][0].args.max_rows).toBe(1000);
    expect(result.status).toBe('partial');
    expect(result.reasons).toContain('cap_reached');
  });

  it('ClickHouse rejects malformed rows and reports truncation while preserving valid data', async () => {
    configure('clickhouse');
    invokeMcpLambdaTool.mockResolvedValue({ truncated: true, rows: [otelRow(), null, {}, otelRow({ Duration: 'NaN' })] });
    const result = await new ClickHouseOtelTraceSource().recentSpans(30, 10, END_MS);
    expect(result.items).toHaveLength(1);
    expect(result.status).toBe('partial');
    expect(result.reasons).toEqual(expect.arrayContaining(['malformed_rows', 'payload_truncated']));
  });

  it('ClickHouse validates nested envelopes and excludes spans outside the requested window', async () => {
    configure('clickhouse');
    invokeMcpLambdaTool.mockResolvedValue({ result: { rows: [
      otelRow(), otelRow({ Timestamp: new Date(END_MS + 1000).toISOString() }),
      otelRow({ Timestamp: new Date(END_MS - 1_800_001).toISOString() }),
    ], truncated: true } });
    const result = await new ClickHouseOtelTraceSource().recentSpans(30, 10, END_MS);
    expect(result.items).toHaveLength(1);
    expect(result.status).toBe('partial');
    expect(result.reasons).toContain('payload_truncated');
  });

  it('ClickHouse cannot hide a malformed primary row envelope behind an empty fallback', async () => {
    configure('clickhouse');
    for (const payload of [{ rows: null, data: [] }, { rows: {}, result: { rows: [] } }]) {
      invokeMcpLambdaTool.mockResolvedValue(payload);
      expect(await new ClickHouseOtelTraceSource().recentSpans(30, 10, END_MS))
        .toMatchObject({ items: [], status: 'error', reasons: ['malformed_payload'] });
    }
  });

  it('ClickHouse reports malformed link/status fields while retaining valid span identity', async () => {
    configure('clickhouse');
    invokeMcpLambdaTool.mockResolvedValue({ rows: [
      otelRow({ Links: 'invalid', StatusCode: 'not-a-status' }),
    ] });
    const result = await new ClickHouseOtelTraceSource().recentSpans(30, 10, END_MS);
    expect(result).toMatchObject({ status: 'partial', reasons: ['malformed_rows'] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].status).toBeUndefined();
    expect(result.items[0].links).toEqual([]);
  });

  it('Tempo searches with explicit shared start/end seconds, then caps and stamps fetched spans', async () => {
    configure('tempo', 42);
    invokeMcpLambdaTool.mockResolvedValueOnce({ traces: [{ traceID: 'a' }, { traceID: 'b' }] })
      .mockResolvedValue(tempoTrace([tempoSpan(), tempoSpan({ spanId: 's2' }), tempoSpan({ spanId: 's3' })]));
    const result = await new TempoTraceSource(7).recentSpans(30, 2, END_MS + 123);
    expect(invokeMcpLambdaTool.mock.calls[0][0].args).toEqual({
      query: '{}', limit: 20, start: (END_MS - 1_800_000) / 1000, end: END_MS / 1000,
    });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((s) => s.sourceId === 'tempo:42')).toBe(true);
    expect(result.status).toBe('partial');
    expect(result.reasons).toContain('cap_reached');
    expect(invokeMcpLambdaTool.mock.calls.filter(([c]) => c.tool === 'tempo_get_trace')).toHaveLength(1);
  });

  it('Tempo keeps partial-fetch provenance and never exports a raw error', async () => {
    configure('tempo');
    invokeMcpLambdaTool.mockResolvedValueOnce({ traces: [{ traceID: 'bad' }, { traceID: 'good' }] })
      .mockRejectedValueOnce(new Error('private-token')).mockResolvedValueOnce(tempoTrace());
    const result = await new TempoTraceSource(7).recentSpans(30, 10, END_MS);
    expect(result).toMatchObject({ status: 'partial', reasons: ['trace_fetch_failed'] });
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('Tempo marks a fully failed fetch as error and a saturated search as partial', async () => {
    configure('tempo');
    invokeMcpLambdaTool.mockResolvedValueOnce({ traces: [{ traceID: 'bad' }] })
      .mockRejectedValueOnce(new Error('private-token'));
    expect(await new TempoTraceSource(7).recentSpans(30, 100, END_MS))
      .toMatchObject({ items: [], status: 'error', reasons: ['trace_fetch_failed'] });
    invokeMcpLambdaTool.mockResolvedValueOnce({ traces: Array.from({ length: 21 }, (_, i) => ({ traceID: String(i) })) })
      .mockResolvedValue(tempoTrace());
    const result = await new TempoTraceSource(7).recentSpans(30, 100, END_MS);
    expect(result.items).toHaveLength(20);
    expect(result.status).toBe('partial');
    expect(result.reasons).toContain('cap_reached');
  });

  it('Tempo reports malformed nested spans and byte truncation without losing good spans', async () => {
    configure('tempo');
    invokeMcpLambdaTool.mockResolvedValueOnce({ traces: [{ traceID: 'a' }, null, { traceID: '' }, { traceID: 'b' }] })
      .mockResolvedValueOnce(tempoTrace([tempoSpan(), null, {}, tempoSpan({ startTimeUnixNano: 'NaN' })]))
      .mockResolvedValueOnce({ truncated: true, preview: 'private-token' });
    const result = await new TempoTraceSource(7).recentSpans(30, 100, END_MS);
    expect(result.items).toHaveLength(1);
    expect(result.status).toBe('partial');
    expect(result.reasons).toEqual(expect.arrayContaining(['malformed_rows', 'payload_truncated']));
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('Tempo reports invalid resource/status objects rather than silently losing scope', async () => {
    configure('tempo');
    invokeMcpLambdaTool.mockResolvedValueOnce({ traces: [{ traceID: 'a' }] })
      .mockResolvedValueOnce({ batches: [{
        resource: 'invalid',
        scopeSpans: [{ spans: [tempoSpan({ status: { code: 9 } })] }],
      }] });
    const result = await new TempoTraceSource(7).recentSpans(30, 10, END_MS);
    expect(result).toMatchObject({ status: 'partial', reasons: ['malformed_rows'] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].environment).toBeUndefined();
    expect(result.items[0].status).toBeUndefined();
  });

  it('Tempo does not count spans outside the shared window against the cap', async () => {
    configure('tempo');
    invokeMcpLambdaTool.mockResolvedValueOnce({ truncated: true, traces: [{ traceID: 'a' }] })
      .mockResolvedValueOnce(tempoTrace([
        tempoSpan({ startTimeUnixNano: String((END_MS - 1_800_001) * 1e6) }),
        tempoSpan(),
        tempoSpan({ startTimeUnixNano: String((END_MS + 1000) * 1e6), endTimeUnixNano: String((END_MS + 2000) * 1e6) }),
      ]));
    const result = await new TempoTraceSource(7).recentSpans(30, 1, END_MS);
    expect(result.items).toHaveLength(1);
    expect(result).toMatchObject({ status: 'partial', reasons: ['payload_truncated'] });
  });

  it.each(['clickhouse', 'tempo'])('%s honors a zero cap without invoking a query', async (kind) => {
    configure(kind);
    const source = kind === 'clickhouse' ? new ClickHouseOtelTraceSource(7) : new TempoTraceSource(7);
    expect(await source.recentSpans(30, 0, END_MS)).toMatchObject({ items: [], status: 'partial', reasons: ['cap_reached'] });
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });
});

describe('metrics identity and query provenance', () => {
  beforeEach(() => {
    getDatasource.mockReset(); resolveConnConfig.mockReset(); invokeMcpLambdaTool.mockReset();
    getDatasource.mockResolvedValue({ id: 42, kind: 'mimir' });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://metrics' });
  });

  it('keeps prod and staging servicegraph identities distinct, with per-side scope precedence', () => {
    const result = extractServiceGraphCalls({ resultType: 'vector', result: ['prod', 'staging'].map((env) => ({
      metric: {
        client: 'checkout', server: 'orders', client_service_namespace: 'payments',
        server_service_namespace: 'fulfilment', deployment_environment_name: env,
        client_cloud_account_id: '111111111111', server_cloud_account_id: '222222222222',
        cloud_region: 'ap-northeast-2', k8s_cluster_name: 'shared',
        client_k8s_namespace_name: 'shop', server_k8s_namespace_name: 'orders',
        authorization: 'private-token',
      }, value: [0, '5'],
    })) });
    expect(result[0]).toMatchObject({
      clientIdentity: { serviceNamespace: 'payments', environment: 'prod', accountId: '111111111111',
        region: 'ap-northeast-2', k8sCluster: 'shared', k8sNamespace: 'shop' },
      serverIdentity: { serviceNamespace: 'fulfilment', environment: 'prod', accountId: '222222222222',
        region: 'ap-northeast-2', k8sCluster: 'shared', k8sNamespace: 'orders' },
    });
    expect(result[1].clientIdentity?.environment).toBe('staging');
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('maps Istio workload namespace/cluster and legacy environment labels independently', () => {
    const [result] = extractServiceGraphCalls({ result: [{
      metric: { source_workload: 'checkout', destination_workload: 'orders',
        source_workload_namespace: 'shop', destination_workload_namespace: 'back',
        source_cluster: 'east', destination_cluster: 'west',
        source_service_namespace: 'retail', destination_service_namespace: 'fulfilment',
        source_deployment_environment: 'prod', destination_environment: 'staging',
        source_region: 'r1', destination_region: 'r2',
        source_account_id: '111', destination_account_id: '222' },
      value: [0, '3'],
    }] });
    expect(result).toMatchObject({
      clientIdentity: { k8sNamespace: 'shop', k8sCluster: 'east', environment: 'prod',
        serviceNamespace: 'retail', region: 'r1', accountId: '111' },
      serverIdentity: { k8sNamespace: 'back', k8sCluster: 'west', environment: 'staging',
        serviceNamespace: 'fulfilment', region: 'r2', accountId: '222' },
    });
  });

  it('uses the shared instant-query time and stamps both endpoint identities with the resolved source', async () => {
    invokeMcpLambdaTool.mockResolvedValue({ resultType: 'vector', result: [
      { metric: { client: 'a', server: 'b', environment: 'prod' }, value: [0, '2'] },
    ] });
    const result = await new MetricsCallsSource(7, 'mimir', 'increase(x[{window}m])').calls(30, END_MS + 123);
    expect(invokeMcpLambdaTool.mock.calls[0][0].args).toEqual({ query: 'increase(x[30m])', time: (END_MS + 123) / 1000 });
    expect(result).toMatchObject({ sourceId: 'mimir:42', status: 'ok', items: [{
      clientIdentity: { sourceId: 'mimir:42', environment: 'prod' },
      serverIdentity: { sourceId: 'mimir:42', environment: 'prod' },
    }] });
  });

  it('separates malformed vector samples from legitimate zero traffic, and discloses truncation', async () => {
    const valid = { metric: { client: 'a', server: 'b' }, value: [0, '1'] };
    invokeMcpLambdaTool.mockResolvedValue({ resultType: 'vector', truncated: true, result: [
      valid, null, { ...valid, value: [0, 'NaN'] }, { ...valid, value: [0, null] },
      { ...valid, value: [null, '1'] }, { ...valid, value: ['not-a-timestamp', '1'] },
    ] });
    const source = new MetricsCallsSource(7, 'mimir', 'x');
    const result = await source.calls(30, END_MS);
    expect(result.items).toHaveLength(1);
    expect(result.status).toBe('partial');
    expect(result.reasons).toEqual(expect.arrayContaining(['malformed_rows', 'payload_truncated']));
    invokeMcpLambdaTool.mockResolvedValue({ resultType: 'vector', result: [{ ...valid, value: [0, '0'] }] });
    expect(await source.calls(30, END_MS)).toMatchObject({ items: [], status: 'ok', reasons: [] });
    invokeMcpLambdaTool.mockResolvedValue({ resultType: 'matrix', result: [] });
    expect(await source.calls(30, END_MS)).toMatchObject({ items: [], status: 'error' });
  });
});
