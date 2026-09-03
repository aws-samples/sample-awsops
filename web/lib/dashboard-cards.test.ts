import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));

import { getDashboardCards } from './dashboard-cards';

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
});

describe('getDashboardCards', () => {
  it('splits ready vs unavailable, scoped by integration_id, parses jsonb', async () => {
    query.mockResolvedValueOnce({ rows: [
      { card_key: 'up_targets', title: '정상 타깃 수', viz: 'stat', unit: '', status: 'ready',
        query: { tool: 'prometheus_query', expr: 'count(up == 1)', range: null }, missing: [] },
      { card_key: 'cpu_usage', title: '노드 CPU 사용률', viz: 'timeseries', unit: '%', status: 'ready',
        query: JSON.stringify({ tool: 'prometheus_query', expr: 'x', range: { window: 3600, step: 60 } }), missing: '[]' },
      { card_key: 'memory_available', title: '가용 메모리', viz: 'timeseries', unit: 'bytes', status: 'unavailable',
        query: null, missing: ['node_memory_MemAvailable_bytes'] },
      { card_key: 'pod_restarts', title: '최근 1시간 파드 재시작', viz: 'stat', unit: '', status: 'unknown',
        query: null, missing: ['kube_pod_container_status_restarts_total'] },
    ] });
    const out = await getDashboardCards(7);
    expect(out.ready).toHaveLength(2);
    expect(out.ready[0].query.tool).toBe('prometheus_query');
    expect(out.ready[1].query.range).toEqual({ window: 3600, step: 60 });
    expect(out.unavailable).toHaveLength(2);
    expect(out.unavailable[0].missing).toEqual(['node_memory_MemAvailable_bytes']);
    // 'unavailable' = confidently missing; 'unknown' = truncated schema, absence undetermined
    expect(out.unavailable[0].indeterminate).toBe(false);
    expect(out.unavailable[1].cardKey).toBe('pod_restarts');
    expect(out.unavailable[1].indeterminate).toBe(true);
    expect(out.unavailable[1].missing).toEqual(['kube_pod_container_status_restarts_total']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM datasource_dashboard_cards/);
    expect(sql).toMatch(/account_id = 'self' AND integration_id = \$1/);
    expect(params[0]).toBe(7);
  });

  it('excludes the schema-version sentinel row', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await getDashboardCards(3);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('__schema_version__');
  });
});
