import { describe, it, expect } from 'vitest';
import { normalizeResult } from './datasource-render';

describe('normalizeResult', () => {
  it('prometheus matrix → series (first) + rows listing all series + truncated', () => {
    const body = {
      truncated: true,
      resultType: 'matrix',
      result: [
        { metric: { __name__: 'up', job: 'api' }, values: [[1700000000, '1'], [1700000060, '1']] },
        { metric: { __name__: 'up', job: 'web' }, values: [[1700000000, '0']] },
      ],
    };
    const r = normalizeResult('prometheus', 'prometheus_query_range', body);
    expect(r.shape).toBe('series');
    expect(r.seriesXKey).toBe('t');
    // Multi-series (v1 parity): one key per series, merged on the timestamp axis.
    expect(r.seriesKeys).toHaveLength(2);
    expect(r.series).toHaveLength(2); // two distinct timestamps
    expect(r.series![0][r.seriesKeys![0]]).toBe(1); // up{job="api"} @t0
    expect(r.series![0][r.seriesKeys![1]]).toBe(0); // up{job="web"} @t0
    expect(r.rows).toHaveLength(2); // one row per series
    expect(r.truncated).toBe(true);
  });

  it('prometheus vector → table {metric,value,timestamp}', () => {
    const body = { resultType: 'vector', result: [{ metric: { __name__: 'up', job: 'api' }, value: [1700000000, '1'] }] };
    const r = normalizeResult('prometheus', 'prometheus_query', body);
    expect(r.shape).toBe('table');
    expect(r.rows![0].value).toBe(1);
    expect(String(r.rows![0].metric)).toContain('up');
    expect(r.columns!.map((c) => c.key)).toContain('metric');
  });

  it('prometheus vector preserves non-finite samples (NaN/+Inf) as null (not coerced to 0)', () => {
    const body = { resultType: 'vector', result: [
      { metric: { __name__: 'a' }, value: [1700000000, 'NaN'] },
      { metric: { __name__: 'b' }, value: [1700000000, '+Inf'] },
      { metric: { __name__: 'c' }, value: [1700000000, '2.5'] },
    ] };
    const r = normalizeResult('prometheus', 'prometheus_query', body);
    expect(r.rows![0].value).toBeNull();
    expect(r.rows![1].value).toBeNull();
    expect(r.rows![2].value).toBe(2.5);
  });

  it('mimir matrix behaves like prometheus (series)', () => {
    const body = { resultType: 'matrix', result: [{ metric: { __name__: 'm' }, values: [[1, '5']] }] };
    expect(normalizeResult('mimir', 'mimir_query_range', body).shape).toBe('series');
  });

  it('loki streams → logs table {timestamp,line,labels}', () => {
    const body = {
      resultType: 'streams',
      result: [{ stream: { job: 'varlogs' }, values: [['1700000000000000000', 'boom error'], ['1700000001000000000', 'ok']] }],
    };
    const r = normalizeResult('loki', 'loki_query_range', body);
    expect(r.shape).toBe('logs');
    expect(r.rows).toHaveLength(2);
    expect(r.rows![0].line).toBe('boom error');
    expect(r.columns!.map((c) => c.key)).toEqual(['timestamp', 'line', 'labels']);
  });

  it('tempo {traces} → traces table', () => {
    const body = { truncated: false, traces: [{ traceID: 'abc', rootServiceName: 'api', rootTraceName: 'GET /', durationMs: 12 }] };
    const r = normalizeResult('tempo', 'tempo_search', body);
    expect(r.shape).toBe('traces');
    expect(r.rows![0].traceID).toBe('abc');
    expect(r.columns!.map((c) => c.key)).toContain('durationMs');
  });

  it('clickhouse {rowCount,rows,meta} → table (rows from body.rows, columns from meta)', () => {
    const body = { rowCount: 1, rows: [{ name: 'system.tables', total: 42 }], meta: [{ name: 'name', type: 'String' }, { name: 'total', type: 'UInt64' }] };
    const r = normalizeResult('clickhouse', 'clickhouse_query', body);
    expect(r.shape).toBe('table');
    expect(r.rows).toHaveLength(1);
    expect(r.columns!.map((c) => c.key)).toEqual(['name', 'total']);
  });

  it('clickhouse with no rows → empty (not a phantom table from body.data)', () => {
    const body = { rowCount: 0, rows: [], meta: [{ name: 'x', type: 'Int' }], data: [{ x: 1 }] };
    const r = normalizeResult('clickhouse', 'clickhouse_query', body);
    expect(r.shape).toBe('empty'); // must read body.rows, not body.data
  });

  it('malformed / missing body → empty with a note, never throws', () => {
    expect(normalizeResult('prometheus', 'prometheus_query', null).shape).toBe('empty');
    expect(normalizeResult('prometheus', 'prometheus_query', { resultType: 'matrix', result: [] }).shape).toBe('empty');
    expect(normalizeResult('clickhouse', 'clickhouse_query', {}).note).toBeTruthy();
    // unknown kind degrades gracefully
    expect(normalizeResult('mystery', 'x', { foo: 1 }).shape).toBe('empty');
  });
});
