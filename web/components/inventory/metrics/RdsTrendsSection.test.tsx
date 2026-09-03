// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { RdsTrendsSection } from './RdsTrendsSection';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const samples = (n: number, v = 40) =>
  Array.from({ length: n }, (_, i) => ({ t: new Date(Date.now() - (n - i) * 300_000).toISOString(), v: v + i }));

function setFetch(trends: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(String(url)).toContain('trends=1'); // opt-in param must be sent
    return { ok, status: ok ? 200 : 500, json: async () => ({ instance: null, trends }) };
  }));
}

const BASE = {
  spark: { cpu: samples(10), freeableMemory: samples(2, 2 * 1024 ** 3), connections: null, readIops: samples(10), writeIops: samples(10), freeStorage: samples(10, 5 * 1024 ** 3) },
  mem24h: samples(24, 2 * 1024 ** 3),
  cpu14d: samples(14, 30),
};

describe('RdsTrendsSection (gap L141/L142/L155)', () => {
  it('renders sparklines, the ≤2-point Avg/Max/Min fallback, and 데이터 불가 for a missing series', async () => {
    setFetch(BASE);
    render(<RdsTrendsSection instanceId="db-1" />);
    await waitFor(() => expect(screen.getByText('최근 1시간 (5분 단위)')).toBeTruthy());
    // freeableMemory has 2 points → fallback grid (Avg/Max/Min), not a line
    expect(screen.getAllByText('Avg').length).toBeGreaterThanOrEqual(1);
    // connections series missing → honest 데이터 불가
    expect(screen.getAllByText('데이터 불가').length).toBe(1);
    // 24h + 14d blocks render with their stat tiles
    expect(screen.getByText('여유 메모리 24시간 (GB, KST)')).toBeTruthy();
    expect(screen.getByText('CPU 14일 일별 추이 (%)')).toBeTruthy();
  });
  it('null 24h/14d series render 데이터 불가, not empty charts', async () => {
    setFetch({ ...BASE, mem24h: null, cpu14d: null });
    render(<RdsTrendsSection instanceId="db-1" />);
    await waitFor(() => expect(screen.getAllByText('데이터 불가').length).toBe(3)); // connections + 2 blocks
  });
  it('fetch failure surfaces an inline error', async () => {
    setFetch(null, false);
    render(<RdsTrendsSection instanceId="db-1" />);
    await waitFor(() => expect(screen.getByText('메트릭 추이 조회 실패')).toBeTruthy());
  });
});
