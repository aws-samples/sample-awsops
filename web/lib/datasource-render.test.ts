import { describe, it, expect } from 'vitest';
import { normalizeResult } from './datasource-render';

describe('normalizeResult', () => {
  it.each(['prometheus', 'mimir', 'loki'])('%s keeps valid metric siblings beside omitted markers', kind => {
    for (const resultType of ['vector', 'matrix']) {
      const valid = { metric: { __name__: 'up' },
        ...(resultType === 'vector' ? { value: [1700000000, '7'] } : { values: [[1700000000, '7']] }) };
      const r = normalizeResult(kind, `${kind}_query`, {
        resultType, result: [null, valid, null], collectionStatus: 'unknown',
      });
      expect(r.shape).toBe(resultType === 'vector' ? 'table' : 'series');
      expect(r.rows).toHaveLength(1);
      expect(r.droppedEntries).toBe(2);
      expect(r.collectionStatus).toBe('unknown');
      expect(r.collectionNote).toBeTruthy();
      if (resultType === 'vector') expect(r.rows![0].value).toBe(7);
      else expect(r.series![0][r.seriesKeys![0]]).toBe(7);
      expect(r.note ?? '').not.toContain('결과 파싱 실패');
    }
  });
  it('keeps valid log siblings while counting malformed streams and samples', () => {
    const r = normalizeResult('loki', 'loki_query_range', {
      resultType: 'streams', result: [null, { stream: { job: 'api' },
        values: [null, ['1700000000000000000', 'kept'], ['bad-time', 'omitted']] }],
      collectionStatus: 'ok',
    });
    expect(r.shape).toBe('logs');
    expect(r.rows).toHaveLength(1);
    expect(r.rows![0].line).toBe('kept');
    expect(r.droppedEntries).toBe(3);
    expect(r.collectionStatus).toBe('unknown');
  });
  it.each(['vector', 'matrix'])('invalid %s timestamps cannot erase valid siblings or fabricate epoch zero', resultType => {
    const valid = { metric: { __name__: 'up' }, ...(resultType === 'vector'
      ? { value: [1, '0'] } : { values: [[1, '0'], null, [1e20, '1']] }) };
    const invalid = { metric: { __name__: 'bad' }, ...(resultType === 'vector'
      ? { value: [1e20, '1'] } : { values: null }) };
    const r = normalizeResult('prometheus', 'prometheus_query', {
      resultType, result: [valid, invalid], collectionStatus: 'ok',
    });
    expect(r.shape).toBe(resultType === 'vector' ? 'table' : 'series');
    expect(r.rows).toHaveLength(1);
    expect(r.droppedEntries).toBe(resultType === 'vector' ? 1 : 3);
    expect(r.collectionStatus).toBe('unknown');
  });
  it('does not certify all-omitted markers as a successful empty response', () => {
    const r = normalizeResult('mimir', 'mimir_query', {
      resultType: 'vector', result: [null, null], collectionStatus: 'empty',
    });
    expect(r.shape).toBe('empty');
    expect(r.droppedEntries).toBe(2);
    expect(r.collectionStatus).toBe('unknown');
    expect(r.note).not.toBe('결과 없음');
  });
  it('omits invalid label maps without echoing their values or dropping valid siblings', () => {
    const r = normalizeResult('prometheus', 'prometheus_query', { resultType: 'vector',
      result: [{ metric: { __name__: 'up' }, value: [1, '1'] },
        { metric: { bad: { raw: 'PRIVATE' } }, value: [1, '2'] }], collectionStatus: 'ok' });
    expect(r.rows).toHaveLength(1);
    expect(r.droppedEntries).toBe(1);
    expect(r.collectionStatus).toBe('unknown');
    expect(JSON.stringify(r)).not.toContain('PRIVATE');
  });
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
    expect(r.rows![1].timestamp).toBe('2023-11-14T22:13:21.000Z');
    expect(r.columns!.map((c) => c.key)).toEqual(['timestamp', 'line', 'labels']);
  });

  it('loki metric LogQL (matrix) → series, not garbled log lines', () => {
    // The diag-signal chips this repo adds for loki are aggregates — `sum by(job)(count_over_time(…))` —
    // which Loki answers with resultType 'matrix' and {metric, values:[[ts, "n"]]}. The stream path read
    // the numeric sample as a log line (review MAJOR).
    const body = {
      resultType: 'matrix',
      result: [{ metric: { job: 'varlogs' }, values: [[1700000000, '3'], [1700000060, '5']] }],
    };
    const r = normalizeResult('loki', 'loki_query_range', body);
    expect(r.shape).toBe('series');
    expect(r.seriesKeys).toEqual(['{job="varlogs"}']);
    expect(r.series).toHaveLength(2);
  });

  it('loki instant metric (vector) → table', () => {
    const body = { resultType: 'vector', result: [{ metric: { job: 'varlogs' }, value: [1700000000, '7'] }] };
    const r = normalizeResult('loki', 'loki_query_range', body);
    expect(r.shape).toBe('table');
    expect(r.rows![0].value).toBe(7);
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

describe('year-boundary ordering (review: 30d windows crossing Jan 1)', () => {
  it('prometheus matrix points spanning New Year sort chronologically, not lexically', () => {
    const dec = Math.floor(Date.parse('2026-12-31T23:00:00Z') / 1000);
    const jan = Math.floor(Date.parse('2027-01-01T01:00:00Z') / 1000);
    const r = normalizeResult('prometheus', 'prometheus_query_range', {
      resultType: 'matrix',
      result: [{ metric: { job: 'x' }, values: [[jan, '2'], [dec, '1']] }],
    });
    expect(r.shape).toBe('series');
    const ts = (r.series ?? []).map((p) => String(p.t));
    expect(ts).toEqual(['12-31 23:00', '01-01 01:00']); // December FIRST — epoch order, label unchanged
  });

  it('mergeSeries consumers (dynatrace) also sort by epoch across New Year', () => {
    const dec = Date.parse('2026-12-31T23:00:00Z');
    const jan = Date.parse('2027-01-01T01:00:00Z');
    const r = normalizeResult('dynatrace', 'dynatrace_query', {
      result: [{ metricId: 'm', data: [{ dimensions: [], timestamps: [jan, dec], values: [2, 1] }] }],
    });
    if (r.shape === 'series') {
      const ts = (r.series ?? []).map((p) => String(p.t));
      expect(ts).toEqual(['12-31 23:00', '01-01 01:00']);
    } else {
      // if the dynatrace fixture shape doesn't match the normalizer, this test must be adjusted —
      // fail loudly rather than skipping silently
      expect(r.shape).toBe('series');
    }
  });
});


describe('bounded instant scalar results', () => {
  it.each(['prometheus', 'mimir'])('%s renders one scalar sample, including real zero', kind => {
    const result = normalizeResult(kind, `${kind}_query`, { resultType: 'scalar', result: [1.5, '0'], collectionStatus: 'ok' });
    expect(result.shape).toBe('table');
    expect(result.rows).toEqual([{ value: 0, timestamp: '1970-01-01T00:00:01.500Z' }]);
  });
  it('preserves a string sample without interpreting it as two vector rows', () => {
    const result = normalizeResult('prometheus', 'prometheus_query', { resultType: 'string', result: [1, 'value'], truncated: false });
    expect(result.rows).toEqual([{ value: 'value', timestamp: '1970-01-01T00:00:01.000Z' }]);
  });
});


it.each([1e20, -1e20])('scalar timestamps outside Date range stay non-throwing: %s', timestamp => {
  expect(normalizeResult('prometheus', 'prometheus_query', {
    resultType: 'scalar', result: [timestamp, '0'], collectionStatus: 'ok',
  }).shape).toBe('empty');
});

describe('collection evidence disclosure', () => {
  it.each(['unknown', null, 0])('discloses malformed truncation metadata: %s', truncated => {
    const result = normalizeResult('tempo', 'tempo_search', { traces: [], truncated });
    expect(result.collectionStatus).toBe('unknown');
    expect(result.note).toBe(result.collectionNote);
    expect(result.collectionNote).toBeTruthy();
  });
  it.each(['prometheus', 'mimir', 'tempo', 'clickhouse'])('%s never labels marked incomplete empty data as confirmed empty', kind => {
    for (const collectionStatus of ['partial', 'unknown', 'error'] as const) {
      const result = normalizeResult(kind, `${kind}_query`, { resultType: 'vector', result: [], traces: [], rows: [], collectionStatus });
      expect(result.collectionStatus).toBe(collectionStatus);
      expect(result.collectionNote).toBeTruthy();
      expect(result.note).toBe(result.collectionNote);
      expect(['결과 없음', '행 없음', '트레이스 없음']).not.toContain(result.note);
    }
  });
  it('preserves confirmed empty and useful partial rows distinctly', () => {
    const empty = normalizeResult('prometheus', 'prometheus_query', { resultType: 'vector', result: [], collectionStatus: 'empty' });
    expect(empty.note).toBe('결과 없음');
    expect(empty.collectionStatus).toBe('empty');
    expect(empty.collectionNote).toBeUndefined();
    const partial = normalizeResult('prometheus', 'prometheus_query', { resultType: 'vector', collectionStatus: 'partial', result: [{ metric: { __name__: 'up' }, value: [1, '0'] }] });
    expect(partial.rows?.[0].value).toBe(0);
    expect(partial.collectionNote).toBeTruthy();
  });
  it('preserves scalar format failure and surfaces unknown collection separately', () => {
    const result = normalizeResult('mimir', 'mimir_query', { resultType: 'scalar', result: [], collectionStatus: 'unknown', truncated: true });
    expect(result.note).toBe('응답 형식 오류');
    expect(result.collectionStatus).toBe('unknown');
    expect(result.collectionNote).toBeTruthy();
    expect(result.truncated).toBe(true);
  });
  it('honors a legacy truncation marker without inventing completion', () => {
    const result = normalizeResult('clickhouse', 'clickhouse_query', { rows: [], truncated: true });
    expect(result.collectionStatus).toBe('partial');
    expect(result.note).toBe(result.collectionNote);
  });
});
