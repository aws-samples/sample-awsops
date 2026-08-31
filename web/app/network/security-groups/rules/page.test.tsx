// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import RulesPage from './page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup);
beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

const ROWS = [
  { account_id: '123456789012', region: 'ap-northeast-2', vpc_id: 'vpc-aaa111', rule_id: 'sgr-1', group_id: 'sg-1', is_egress: false, protocol: 'tcp', from_port: 443, to_port: 443, peer_kind: 'cidr', peer_value: '10.0.0.0/16', description: null, compatible_match_count: 3, overlap_match_count: 0, last_observed_at: null, status: 'observed_compatible' },
  { account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-2', group_id: 'sg-2', is_egress: false, protocol: 'tcp', from_port: 22, to_port: 22, peer_kind: 'internet', peer_value: '0.0.0.0/0', description: null, compatible_match_count: 0, overlap_match_count: 2, last_observed_at: null, status: 'overlapping' },
  { account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-3', group_id: 'sg-3', is_egress: true, protocol: 'tcp', from_port: 0, to_port: 0, peer_kind: 'sg', peer_value: 'sg-9', description: null, compatible_match_count: 0, overlap_match_count: 0, last_observed_at: null, status: 'no_observed_evidence' },
  { account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-4', group_id: 'sg-4', is_egress: false, protocol: 'tcp', from_port: 80, to_port: 80, peer_kind: 'cidr', peer_value: '10.1.0.0/16', description: null, compatible_match_count: 0, overlap_match_count: 0, last_observed_at: null, status: 'unassessable' },
  { account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-5', group_id: 'sg-5', is_egress: false, protocol: 'tcp', from_port: 8080, to_port: 8080, peer_kind: 'cidr', peer_value: '10.2.0.0/16', description: null, compatible_match_count: 0, overlap_match_count: 0, last_observed_at: null, status: 'not_configured' },
];

function mockFetches(isAdmin: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/me')) return { ok: true, status: 200, json: async () => ({ sub: 'u', groups: [], isAdmin }) } as Response;
    if (u.includes('/api/sg/rules')) return { ok: true, status: 200, json: async () => ({ rows: ROWS, total: ROWS.length, page: 1, pageSize: 50 }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
}

describe('/network/security-groups/rules', () => {
  it('renders every traffic-evidence status as a distinct badge (never color-only)', async () => {
    mockFetches(false);
    render(<RulesPage />);
    await waitFor(() => expect(screen.getAllByText('sg-1').length).toBeGreaterThan(0));
    expect(screen.getAllByText('관측된 호환 트래픽').length).toBeGreaterThan(0);
    expect(screen.getAllByText('중첩 매칭 (귀속 불확실)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('관측된 증거 없음').length).toBeGreaterThan(0);
    expect(screen.getAllByText('평가 불가').length).toBeGreaterThan(0);
    expect(screen.getAllByText('소스 미설정').length).toBeGreaterThan(0);
  });

  it('hides admin-only controls for a non-admin', async () => {
    mockFetches(false);
    render(<RulesPage />);
    await waitFor(() => expect(screen.getAllByText('sg-1').length).toBeGreaterThan(0));
    expect((screen.getByText('스캔 새로고침').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Flow Log 설정').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables admin-only controls for an admin', async () => {
    mockFetches(true);
    render(<RulesPage />);
    await waitFor(() => expect(screen.getAllByText('sg-1').length).toBeGreaterThan(0));
    await waitFor(() => expect((screen.getByText('스캔 새로고침').closest('button') as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByText('Flow Log 설정').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows CSV/JSON export controls and opens a detail drawer with the graph + Path Check link', async () => {
    mockFetches(false);
    render(<RulesPage />);
    await waitFor(() => expect(screen.getAllByText('sg-1').length).toBeGreaterThan(0));
    expect(screen.getByText('CSV')).toBeTruthy();
    expect(screen.getByText('JSON')).toBeTruthy();

    fireEvent.click(screen.getAllByText('sg-1')[0]);
    await waitFor(() => expect(screen.getByTestId('policy-graph')).toBeTruthy());
    expect(screen.getByText('이 경로 점검하기').closest('a')?.getAttribute('href')).toContain('/network-paths?prefill=');
  });

  it('renders the real VPC id in the VPC column and a dash for rows with an unknown VPC (gap 5)', async () => {
    mockFetches(false);
    render(<RulesPage />);
    await waitFor(() => expect(screen.getAllByText('sg-1').length).toBeGreaterThan(0));
    expect(screen.getAllByText('vpc-aaa111').length).toBeGreaterThan(0);
    // sgr-2..sgr-5 in ROWS carry no vpc_id — rendered as a dash, never fabricated.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('applies a VPC filter to the rules API query', async () => {
    mockFetches(false);
    render(<RulesPage />);
    await waitFor(() => expect(screen.getAllByText('sg-1').length).toBeGreaterThan(0));
    fireEvent.change(screen.getByPlaceholderText('VPC ID'), { target: { value: 'vpc-aaa111' } });
    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls.some((u) => u.includes('/api/sg/rules') && u.includes('vpcId=vpc-aaa111'))).toBe(true);
    });
  });
});
