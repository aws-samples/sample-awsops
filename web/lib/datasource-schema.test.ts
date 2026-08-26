import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
import { upsertSchema, getSchema, listConfiguredSchemas, renderSchemaForPrompt, prioritizeSchemaForQuery, isSchemaStale } from './datasource-schema';

beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [] }); });

describe('datasource-schema (keyed by integration_id)', () => {
  it('upserts with ON CONFLICT (account_id, integration_id) and serialized jsonb', async () => {
    await upsertSchema('acct', 7, 'prometheus', { metrics: ['up'] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(account_id, integration_id\)/);
    expect(params[0]).toBe('acct'); expect(params[1]).toBe(7); expect(params[2]).toBe('prometheus');
    expect(JSON.parse(params[3])).toEqual({ metrics: ['up'] });
  });
  it('rejects an oversized schema with NO query', async () => {
    const huge = { blob: 'x'.repeat(300_000) };
    await expect(upsertSchema('a', 1, 'clickhouse', huge)).rejects.toThrow(/size|limit|large/i);
    expect(query).not.toHaveBeenCalled();
  });
  it('getSchema returns the row (by integration_id) or null', async () => {
    query.mockResolvedValueOnce({ rows: [{ integration_id: 9, kind: 'loki', schema: { labels: ['app'] }, fetched_at: 't' }] });
    expect((await getSchema('a', 9))!.integrationId).toBe(9);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getSchema('a', 404)).toBeNull();
  });
  it('listConfiguredSchemas is account-scoped and maps integration_id/kind', async () => {
    query.mockResolvedValueOnce({ rows: [{ integration_id: 3, kind: 'tempo', schema: {}, fetched_at: 't' }] });
    const rows = await listConfiguredSchemas('acct');
    expect(query.mock.calls[0][1]).toEqual(['acct']);
    expect(rows[0]).toMatchObject({ integrationId: 3, kind: 'tempo' });
  });
  it('surfaces the captured server version from schema.version (null when absent/non-string)', async () => {
    query.mockResolvedValueOnce({ rows: [{ integration_id: 5, kind: 'prometheus', schema: { version: '2.48.0', metrics: ['up'] }, fetched_at: 't' }] });
    expect((await getSchema('a', 5))!.version).toBe('2.48.0'); // version-aware DSL input
    query.mockResolvedValueOnce({ rows: [{ integration_id: 6, kind: 'loki', schema: { labels: ['app'] }, fetched_at: 't' }] });
    expect((await getSchema('a', 6))!.version).toBeNull();
  });
});

describe('renderSchemaForPrompt', () => {
  it('emits SQL tables WITH columns and types (not just names) — the core ClickHouse fix', () => {
    const schema = {
      version: '24.8.1',
      tables: [
        { name: 'otel_traces', columns: [{ name: 'ServiceName', type: 'String' }, { name: 'SpanName', type: 'String' }, { name: 'Duration', type: 'UInt64' }] },
        { name: 'otel_logs', columns: [{ name: 'Body', type: 'String' }] },
      ],
    };
    const out = renderSchemaForPrompt(schema, 'clickhouse');
    expect(out).toContain('otel_traces(ServiceName String, SpanName String, Duration UInt64)');
    expect(out).toContain('otel_logs(Body String)');
  });

  it('renders metric/label datasources as name lists (no tables)', () => {
    const out = renderSchemaForPrompt({ metrics: ['up', 'node_cpu_seconds_total'], labels: ['job', 'instance'] }, 'prometheus');
    expect(out).toContain('metrics: up, node_cpu_seconds_total');
    expect(out).toContain('labels: job, instance');
    expect(out).not.toContain('('); // no SQL table parens
  });

  it('bounds tables, columns, and total size so a huge schema never blows the prompt', () => {
    const tables = Array.from({ length: 100 }, (_, i) => ({
      name: `t${i}`,
      columns: Array.from({ length: 200 }, (_, c) => ({ name: `c${c}`, type: 'String' })),
    }));
    const out = renderSchemaForPrompt({ tables }, 'clickhouse');
    expect(out.length).toBeLessThanOrEqual(6200); // ~PROMPT_MAX_CHARS (6000) + the short disclosure line
    expect(out).toMatch(/\+\d+ more tables/); // truncation is disclosed, never silent
  });

  it('is defensive against malformed/empty schema (returns empty string, never throws)', () => {
    expect(renderSchemaForPrompt(null)).toBe('');
    expect(renderSchemaForPrompt('not-an-object')).toBe('');
    expect(renderSchemaForPrompt({ tables: [{ noName: true }, null, 'x'] })).toBe('');
    expect(renderSchemaForPrompt({})).toBe('');
  });

  it('hard-caps a single column/table line so one pathological nested type cannot blow the budget [3]', () => {
    const hugeType = `Tuple(${'a UInt64, '.repeat(3000)})`; // ~30KB type string
    const out = renderSchemaForPrompt({ tables: [{ name: 'big', columns: [{ name: 'col', type: hugeType }] }] });
    expect(out.length).toBeLessThanOrEqual(1300); // PROMPT_MAX_LINE_CHARS + slack, NOT 30KB
    expect(out.startsWith('big(')).toBe(true);
  });

  it('respects a caller-supplied maxChars budget [6/7/14]', () => {
    const tables = Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, columns: [{ name: 'c', type: 'String' }] }));
    const out = renderSchemaForPrompt({ tables }, 'clickhouse', 300);
    expect(out.length).toBeLessThanOrEqual(380); // ~300 budget + one disclosure line
    expect(out).toMatch(/more tables/);
  });

  it('renders OpenSearch domains WITH their nested indices, not domain names only [5]', () => {
    const out = renderSchemaForPrompt({ domains: [{ name: 'logs-domain', indices: ['app-2026.06', 'app-2026.05'] }] }, 'opensearch');
    expect(out).toBe('logs-domain: app-2026.06, app-2026.05');
  });
});

describe('prioritizeSchemaForQuery (Prometheus relevance ordering)', () => {
  // Prometheus returns metrics alphabetically; the relevant ones are deep in the list and get dropped by
  // the render cap. Prioritizing by the NL query floats them to the front so they survive.
  const metrics = ['ALERTS', 'aggregator_discovery_total', 'alertmanager_alerts', 'apiserver_request_total',
    'container_memory_working_set_bytes', 'kube_pod_container_resource_limits', 'kube_pod_container_resource_requests', 'kube_pod_status_phase'];

  it('floats metrics matching the NL query to the front (a "pod resource" query) [prom]', () => {
    const out = prioritizeSchemaForQuery({ metrics }, 'pod resource조회') as { metrics: string[] };
    // kube_pod_container_resource_* match BOTH "pod" and "resource" → score 2 → first
    expect(out.metrics.slice(0, 2).sort()).toEqual(['kube_pod_container_resource_limits', 'kube_pod_container_resource_requests']);
    expect(out.metrics.indexOf('kube_pod_status_phase')).toBeLessThan(out.metrics.indexOf('aggregator_discovery_total')); // "pod"=1 beats 0
  });

  it('adapts to the query terms — "memory usage" floats container_memory*', () => {
    const out = prioritizeSchemaForQuery({ metrics }, 'memory usage') as { metrics: string[] };
    expect(out.metrics[0]).toBe('container_memory_working_set_bytes');
  });

  it('leaves order unchanged when nothing matches or no usable terms (Korean-only / short)', () => {
    expect((prioritizeSchemaForQuery({ metrics }, '조회') as { metrics: string[] }).metrics).toEqual(metrics);
    expect((prioritizeSchemaForQuery({ metrics }, 'xyz123notamatch') as { metrics: string[] }).metrics).toEqual(metrics);
  });

  it('is a stable, non-mutating pass-through for non-metric / malformed schemas', () => {
    const orig = { metrics };
    prioritizeSchemaForQuery(orig, 'pod');
    expect(orig.metrics).toEqual(metrics); // original not mutated
    expect(prioritizeSchemaForQuery(null, 'pod')).toBeNull();
    expect(prioritizeSchemaForQuery({ tables: [{ name: 't' }] }, 'pod')).toEqual({ tables: [{ name: 't' }] });
  });
});

describe('isSchemaStale (lazy-refresh TTL)', () => {
  const now = Date.parse('2026-06-18T12:00:00Z');
  it('stale when missing / unparseable / older than TTL; fresh when recent', () => {
    expect(isSchemaStale(undefined, now)).toBe(true);
    expect(isSchemaStale('not-a-date', now)).toBe(true);
    expect(isSchemaStale('2026-06-18T00:00:00Z', now)).toBe(true);  // 12h old > 6h default TTL
    expect(isSchemaStale('2026-06-18T11:30:00Z', now)).toBe(false); // 30m old < 6h
  });
  it('respects a custom TTL', () => {
    expect(isSchemaStale('2026-06-18T11:00:00Z', now, 30 * 60 * 1000)).toBe(true); // 1h old > 30m TTL
  });
});
