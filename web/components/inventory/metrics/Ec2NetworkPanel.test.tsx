// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { Ec2NetworkPanel } from './Ec2NetworkPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const samples = (n: number, v = 1e6) =>
  Array.from({ length: n }, (_, i) => ({ t: new Date(Date.now() - (n - i) * 3600_000).toISOString(), v }));

function setFetch(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(String(url)).toContain('/api/inventory/ec2/metrics?id=');
    expect(String(url)).toContain('trends=1');
    return { ok, status: ok ? 200 : 500, json: async () => body };
  }));
}

describe('Ec2NetworkPanel (gap L139)', () => {
  it('renders both charts and the Total In/Out (24h) tiles summed from the series', async () => {
    setFetch({ trends: { netIn: samples(24, 2e6), netOut: samples(24, 1e6) } });
    render(<Ec2NetworkPanel instanceId="i-0abc12345" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Total In (24h)')).toBeTruthy());
    expect(screen.getByText('48.0 MB')).toBeTruthy();  // 24 × 2MB
    expect(screen.getByText('24.0 MB')).toBeTruthy();  // 24 × 1MB
    expect(screen.getByText('Network In (MB/h, KST)')).toBeTruthy();
    expect(screen.getByText('Network Out (MB/h, KST)')).toBeTruthy();
  });

  it("a null series reads 데이터 불가 and its total tile reads '—'", async () => {
    setFetch({ trends: { netIn: samples(3), netOut: null } });
    render(<Ec2NetworkPanel instanceId="i-0abc12345" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('데이터 불가')).toBeTruthy());
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('a 200 without trends (rolling-deploy skew) takes the error branch, never pinned loading', async () => {
    setFetch({ cards: [] });
    render(<Ec2NetworkPanel instanceId="i-0abc12345" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('메트릭 추이 조회 실패')).toBeTruthy());
  });

  it('sends account and region; Escape closes', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ trends: { netIn: null, netOut: null } }) }));
    vi.stubGlobal('fetch', f);
    const onClose = vi.fn();
    render(<Ec2NetworkPanel instanceId="i-0abc12345" accountId="123456789012" region="us-west-2" onClose={onClose} />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain('account=123456789012');
    expect(url).toContain('region=us-west-2');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
