// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import CardDashboard from './CardDashboard';

const CARDS = {
  ready: [
    { cardKey: 'up_targets', title: '정상 타깃 수', viz: 'stat', unit: '', query: { tool: 'prometheus_query', expr: 'count(up == 1)', range: null } },
    { cardKey: 'cpu_usage', title: '노드 CPU 사용률', viz: 'timeseries', unit: '%', query: { tool: 'prometheus_query', expr: 'cpu_expr', range: { window: 3600, step: 60 } } },
    // ClickHouse keeps the original column name (`count()`), not a `value` column
    { cardKey: 'otel_span_rate', title: '최근 1시간 스팬 수', viz: 'stat', unit: 'spans', query: { tool: 'clickhouse_query', expr: 'ch_count_expr', range: null } },
    { cardKey: 'slow_traces', title: '느린 트레이스 (>1s)', viz: 'table', unit: '', query: { tool: 'tempo_search', expr: 'empty_table_expr', range: null } },
  ],
  unavailable: [
    { cardKey: 'memory_available', title: '가용 메모리', missing: ['node_memory_MemAvailable_bytes'], indeterminate: false },
    { cardKey: 'pod_restarts', title: '최근 1시간 파드 재시작', missing: ['kube_pod_container_status_restarts_total'], indeterminate: true },
  ],
};

// POST /api/datasources/query normalizes server-side → { result: NormalizedResult }.
const INSTANT_RESULT = { result: { shape: 'table', rows: [{ metric: '', value: 7, timestamp: '2026-08-28T00:00:00Z' }], columns: [{ key: 'metric', label: 'metric' }, { key: 'value', label: 'value' }, { key: 'timestamp', label: 'timestamp' }] } };
const SERIES_RESULT = { result: { shape: 'series', series: [{ t: '08-28 00:00', node: 1 }, { t: '08-28 00:01', node: 2 }], seriesXKey: 't', seriesKeys: ['node'] } };
// The count arrives as a STRING on purpose: ClickHouse quotes 64-bit ints in JSON by default
// (output_format_json_quote_64bit_integers=1) and the connector deliberately KEEPS that default
// (JSON numbers would silently round UInt64 > 2^53) — statValue's string coercion is the
// load-bearing path for every ClickHouse stat card, never legacy tolerance.
const CH_COUNT_RESULT = { result: { shape: 'table', rows: [{ 'count()': '42' }], columns: [{ key: 'count()', label: 'count()' }] } };
const EMPTY_RESULT = { result: { shape: 'empty', note: '트레이스 없음' } };

function stubFetch({ failExpr }: { failExpr?: string } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).includes('/cards')) return { ok: true, json: async () => CARDS };
    const body = JSON.parse(init?.body ?? '{}');
    if (failExpr && body.query === failExpr) return { ok: false, json: async () => ({ error: 'boom' }) };
    if (body.query === 'ch_count_expr') return { ok: true, json: async () => CH_COUNT_RESULT };
    if (body.query === 'empty_table_expr') return { ok: true, json: async () => EMPTY_RESULT };
    return { ok: true, json: async () => (body.range ? SERIES_RESULT : INSTANT_RESULT) };
  }));
}

beforeEach(() => stubFetch());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CardDashboard', () => {
  it('renders ready card values after executing stored queries', async () => {
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText('정상 타깃 수')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('7')).toBeTruthy()); // instant stat value
    expect(screen.getByText('노드 CPU 사용률')).toBeTruthy();
  });

  it('sends the stored range to the query API for timeseries cards', async () => {
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText('정상 타깃 수')).toBeTruthy());
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(f.mock.calls.length).toBe(5)); // cards + 4 queries
    const bodies = f.mock.calls.filter(([u]) => String(u).includes('/query')).map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(bodies.find((b) => b.query === 'cpu_expr')?.range).toEqual({ window: 3600, step: 60 });
    expect(bodies.find((b) => b.query === 'count(up == 1)')?.range).toBeUndefined();
    expect(bodies.every((b) => b.id === 7)).toBe(true);
  });

  it('renders unavailable cards dimmed with missing tooltip', async () => {
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText('가용 메모리')).toBeTruthy());
    const el = screen.getByText('가용 메모리').closest('[title]');
    expect(el?.getAttribute('title')).toContain('node_memory_MemAvailable_bytes');
  });

  it('shows a per-card error while other cards still render', async () => {
    stubFetch({ failExpr: 'count(up == 1)' });
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText(/카드 쿼리 실패/)).toBeTruthy());
    expect(screen.getByText('노드 CPU 사용률')).toBeTruthy();
  });

  it('says the schema cache was truncated for indeterminate cards', async () => {
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText('최근 1시간 파드 재시작')).toBeTruthy());
    expect(screen.getByText('스키마 캐시가 잘려 존재 여부 미확정')).toBeTruthy();
    const el = screen.getByText('최근 1시간 파드 재시작').closest('[title]');
    expect(el?.getAttribute('title')).toContain('미확정:');
    // the confidently-missing card keeps the original copy
    expect(screen.getByText('스키마에 필요한 항목이 없어 비활성')).toBeTruthy();
  });

  it('reads a stat from the first numeric cell when there is no `value` column, coercing a string count', async () => {
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText('42')).toBeTruthy());
  });

  it('renders the note instead of a blank table on an empty result', async () => {
    render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect(screen.getByText('트레이스 없음')).toBeTruthy());
  });

  it('renders nothing when the instance has no card rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ready: [], unavailable: [] }) })));
    const { container } = render(<CardDashboard instanceId={7} />);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1));
    expect(container.textContent).toBe('');
  });
});
