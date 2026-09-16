// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from './page';
import { setActiveScope, type ScopeSelection } from '@/lib/account-context';

// Independent widgets perform unrelated API reads. Keep the actual EKS charts and tiles.
vi.mock('@/components/insights/InsightCard', () => ({ default: () => null }));
vi.mock('@/components/overview/AiOps', () => ({ default: () => null }));

const ACCOUNT = '222222222222';
const REGION = 'ap-northeast-2';
const MEMBER: ScopeSelection = { accounts: [ACCOUNT], regions: [REGION], includeGlobal: true };
const CLUSTER = {
  id: `arn:aws:eks:${REGION}:${ACCOUNT}:cluster/shared`,
  name: 'shared', accountId: ACCOUNT, region: REGION, reachable: true,
  counts: { nodes: 2, nodesReady: 1, pods: 3, podsRunning: 3, deployments: 1, services: 1 },
  podStatus: { Running: 3 },
  events: [{ reason: 'TestWarning', object: 'pod/test', message: 'member-event', count: 1, lastSeenTs: 1 }],
};
const OVERVIEW = {
  jobs: { queued: 0, running: 0, succeeded: 0, failed: 0 }, clusterCount: 1, mtdCost: 0, compliance: null,
  clusterScope: { accountId: ACCOUNT, region: REGION, names: ['shared'], truncated: false },
};
const MICRO = '1/2 ready · 3 pods · 1 deploys';
const json = (body: unknown, status = 200) => Response.json(body, { status });
const fleets = () => vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input), 'http://x').pathname === '/api/eks/fleet');
function serve(options: {
  overview?: unknown;
  fleet?: () => Response | Promise<Response>;
} = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, _init?: RequestInit) => {
    const url = new URL(input, 'http://x');
    if (url.pathname === '/api/overview') return json(options.overview ?? OVERVIEW);
    if (url.pathname === '/api/inventory/summary') return json({ byType: [], byCategory: [], total: 0, ec2Types: [] });
    if (url.pathname === '/api/cost' || url.pathname === '/api/inventory/trend') return json({ trend: [] });
    if (url.pathname === '/api/me') return json({ isAdmin: false });
    if (url.pathname === '/api/eks/fleet') return options.fleet?.() ?? json({ clusters: [CLUSTER], truncated: false });
    throw new Error(`Unexpected request ${input}`);
  }));
}
const eksTile = () => within(screen.getByRole('link', { name: 'EKS 클러스터' }));
function expectNoSuccessfulEmpty() {
  expect(screen.queryAllByText(/^(EKS 데이터 없음|파드 없음|최근 이벤트 없음)$/)).toHaveLength(0);
}
beforeEach(() => { localStorage.clear(); setActiveScope(MEMBER); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

it('sends the persisted member account and region to the fleet API on initial load and refresh', async () => {
  serve();
  render(<Home />);
  await screen.findByText('member-event');
  expect(fleets()).toHaveLength(1);
  expect(fleets()[0][0]).toBe('/api/eks/fleet?accounts=222222222222&regions=ap-northeast-2&includeGlobal=1');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fleets()).toHaveLength(2));
  expect(fleets()[1][0]).toBe('/api/eks/fleet?accounts=222222222222&regions=ap-northeast-2&includeGlobal=1');
});

it('fuses only a complete singleton fleet matching the headline population and labels both chart populations', async () => {
  serve();
  render(<Home />);
  await screen.findByText('member-event');
  expect(eksTile().getByText(MICRO)).toBeTruthy();
  expect(screen.getAllByText(/선택 범위의 등록 클러스터/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText(`shared (${ACCOUNT} / ${REGION})`)).toBeTruthy();
});

it.each([
  { name: 'all accounts', scope: { ...MEMBER, accounts: '__all__' as const } },
  { name: 'multiple accounts', scope: { ...MEMBER, accounts: [ACCOUNT, '333333333333'] } },
  { name: 'all regions', scope: { ...MEMBER, regions: '__all__' as const } },
  { name: 'multiple regions', scope: { ...MEMBER, regions: [REGION, 'us-west-2'] } },
  { name: 'another singleton region', scope: { ...MEMBER, regions: ['us-west-2'] } },
])('does not fuse equal cardinalities for $name', async ({ scope }) => {
  setActiveScope(scope);
  serve();
  render(<Home />);
  await screen.findByText('member-event');
  expect(eksTile().queryByText(MICRO)).toBeNull();
});

it.each([
  { name: 'legacy headline without metadata', overview: { ...OVERVIEW, clusterScope: undefined } },
  { name: 'different names despite equal counts', overview: { ...OVERVIEW, clusterScope: { ...OVERVIEW.clusterScope, names: ['another'] } } },
  { name: 'different headline account', overview: { ...OVERVIEW, clusterScope: { ...OVERVIEW.clusterScope, accountId: '111111111111' } } },
  { name: 'truncated headline', overview: { ...OVERVIEW, clusterScope: { ...OVERVIEW.clusterScope, truncated: true } } },
  { name: 'duplicate headline names', overview: { ...OVERVIEW, clusterCount: 2, clusterScope: { ...OVERVIEW.clusterScope, names: ['shared', 'shared'] } } },
])('requires population evidence: $name', async ({ overview }) => {
  serve({ overview });
  render(<Home />);
  await screen.findByText('member-event');
  expect(eksTile().queryByText(MICRO)).toBeNull();
});

it.each([
  { name: 'fleet truncation', body: { clusters: [CLUSTER], truncated: true } },
  { name: 'collection errors', body: { clusters: [CLUSTER], truncated: false, errors: [{ accountId: ACCOUNT, region: REGION, message: 'member omitted' }] } },
  { name: 'unreachable clusters', body: { clusters: [CLUSTER, { ...CLUSTER, id: 'unreachable', name: 'unreachable', reachable: false, error: 'unreachable member', events: [{ message: 'must-not-aggregate' }], podStatus: { Failed: 99 } }], truncated: false } },
])('discloses $name and withholds fused counts while retaining reachable observations', async ({ body }) => {
  serve({ fleet: () => json(body) });
  render(<Home />);
  await screen.findByText('member-event');
  expect(eksTile().queryByText(MICRO)).toBeNull();
  expect(screen.getByRole('status').textContent).toMatch(/EKS.*불완전/);
  expect(screen.getByRole('status').textContent).toMatch(/누락|조회 실패/);
  expect(screen.queryByText('must-not-aggregate')).toBeNull();
  expect(screen.queryByText('Failed')).toBeNull();
});

it.each([
  { name: 'HTTP failure', fleet: () => json({ message: 'fleet unavailable' }, 503) },
  { name: 'transport failure', fleet: () => Promise.reject(new Error('fleet unavailable')) },
  { name: 'error-shaped 200', fleet: () => json({ clusters: [], status: 'error', message: 'fleet unavailable' }) },
  { name: 'truncated empty result', fleet: () => json({ clusters: [], truncated: true }) },
  { name: 'partial-error empty result', fleet: () => json({ clusters: [], errors: [{ accountId: ACCOUNT, region: REGION, message: 'fleet unavailable' }], truncated: false }) },
])('keeps $name visibly incomplete instead of a successful empty fleet', async ({ fleet }) => {
  serve({ fleet });
  render(<Home />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/EKS.*불완전/));
  expectNoSuccessfulEmpty();
  expect(eksTile().queryByText(MICRO)).toBeNull();
  expect(screen.getAllByText(/확인할 수 없습니다/).length).toBeGreaterThanOrEqual(2);
});

it('shows a complete empty registered population only after successful collection', async () => {
  serve({ fleet: () => json({ clusters: [], truncated: false }) });
  render(<Home />);
  await waitFor(() => expect(screen.getAllByText('선택 범위에 등록된 클러스터가 없습니다')).toHaveLength(2));
  expect(screen.queryByRole('status')).toBeNull();
});

it('marks a six-second timeout incomplete, aborts the read, and ignores the late response', async () => {
  let resolve!: (response: Response) => void;
  serve({ fleet: () => new Promise<Response>((done) => { resolve = done; }) });
  vi.useFakeTimers();
  await act(async () => { render(<Home />); });
  expect(fleets()).toHaveLength(1);
  expectNoSuccessfulEmpty();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(fleets()[0][1]?.signal?.aborted).toBe(true);
  expect(screen.getByRole('status').textContent).toMatch(/시간 초과/);
  expectNoSuccessfulEmpty();
  await act(async () => { resolve(json({ clusters: [CLUSTER], truncated: false })); });
  expect(screen.queryByText('member-event')).toBeNull();
  expect(eksTile().queryByText(MICRO)).toBeNull();
});

it('clears a formerly complete fleet on refresh and does not reuse it after failure', async () => {
  let fail = false;
  serve({ fleet: () => fail ? json({ message: 'refresh failed' }, 503) : json({ clusters: [CLUSTER], truncated: false }) });
  render(<Home />);
  await screen.findByText('member-event');
  fail = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.queryByText('member-event')).toBeNull();
  expect(eksTile().queryByText(MICRO)).toBeNull();
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/불완전/));
  expectNoSuccessfulEmpty();
});
