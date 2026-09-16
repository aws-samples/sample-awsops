// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import Home from './page';
import GroupOverviewClient from './inventory/g/[group]/GroupOverviewClient';
import { setActiveScope, type ScopeSelection } from '@/lib/account-context';
import { LanguageProvider } from '@/components/shell/LanguageProvider';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
// These independent widgets/renderers are outside the request/state behavior under test.
vi.mock('@/components/insights/InsightCard', () => ({ default: () => null }));
vi.mock('@/components/overview/AiOps', () => ({ default: () => null }));
vi.mock('@/components/charts/BarDistribution', () => ({ default: () => null }));
vi.mock('@/components/charts/DonutBreakdown', () => ({ default: () => null }));
vi.mock('@/components/charts/DivergingBarList', () => ({ default: () => null }));
vi.mock('@/components/charts/AreaTrend', () => ({ default: () => null }));
vi.mock('@/components/charts/MultiLineTrend', () => ({
  default: ({ right }: { right?: ReactNode }) => <div>{right}</div>,
}));

type View = 'home' | 'group';
type Call = {
  url: URL;
  signal?: AbortSignal | null;
  resolve: (value: Response) => void;
  reject: (error: Error) => void;
};
const MEMBER: ScopeSelection = { accounts: ['222222222222'], regions: '__all__', includeGlobal: true };
const CHANGES: [string, ScopeSelection][] = [
  ['account', { ...MEMBER, accounts: ['333333333333'] }],
  ['region', { ...MEMBER, regions: ['us-west-2'] }],
  ['global', { ...MEMBER, includeGlobal: false }],
];
const OLD_TIME = '2026-09-16T01:00:00.000Z';
const NEW_TIME = '2026-09-16T02:00:00.000Z';
const summary = (count: number, lastSyncAt = OLD_TIME) => ({
  byType: count ? [{ type: 'ec2', label: 'EC2', count }, { type: 'vpc', label: 'VPC', count }] : [],
  byCategory: [], total: count * 2, ec2Types: [], lastSyncAt,
  splits: { ec2Running: count, ec2Stopped: 0, sgOpenIngress: 0, ebsUnencrypted: 0, iamUserNoMfa: 0, s3Public: 0 },
});
const fleet = (message: string) => ({
  clusters: [{
    name: 'fixture-cluster', reachable: true,
    counts: { nodes: 1, nodesReady: 1, pods: 1, podsRunning: 1, deployments: 1, services: 1 },
    podStatus: {}, events: [{ reason: 'Fixture', message, count: 1 }],
  }],
});

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(OLD_TIME));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function serve() {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'https://fixture.test');
    let resolve!: Call['resolve'], reject!: Call['reject'];
    const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
    calls.push({ url, signal: init?.signal, resolve, reject });
    // Summary and fleet responses stay under test control, including after abort.
    if (url.pathname === '/api/overview') resolve(Response.json({
      jobs: { queued: 0, running: 0, succeeded: 0, failed: 0 },
      clusterCount: 1, mtdCost: 0, compliance: null,
    }));
    else if (url.pathname === '/api/cost') resolve(Response.json({ trend: [] }));
    else if (url.pathname === '/api/inventory/trend') resolve(Response.json({ trend: [], types: [] }));
    else if (url.pathname === '/api/me') resolve(Response.json({ isAdmin: false }));
    else if (!['/api/inventory/summary', '/api/eks/fleet'].includes(url.pathname))
      throw new Error(`Unexpected request: ${url.pathname}`);
    return promise;
  }));
  return calls;
}

function mount(view: View, slug = 'compute') {
  return render(<LanguageProvider>{view === 'home' ? <Home /> : <GroupOverviewClient slug={slug} />}</LanguageProvider>);
}
const summaries = (calls: Call[]) => calls.filter(call => call.url.pathname === '/api/inventory/summary');
const fleets = (calls: Call[]) => calls.filter(call => call.url.pathname === '/api/eks/fleet');
async function latestSummary(calls: Call[], minimum = 1) {
  await waitFor(() => expect(summaries(calls).length).toBeGreaterThanOrEqual(minimum));
  return summaries(calls).at(-1)!;
}
async function answer(call: Call, body: unknown) {
  await act(async () => { call.resolve(Response.json(body)); });
}
function tile(container: HTMLElement, type = 'ec2') {
  const element = container.querySelector(`a[href="/inventory/${type}"]`);
  expect(element).not.toBeNull();
  return within(element as HTMLElement);
}
function refreshButton() {
  return screen.getByRole('button', { name: /^(Refresh|수집 중…)$/ }) as HTMLButtonElement;
}

describe.each<View>(['home', 'group'])('%s scoped request lifetime', view => {
  it('restores persisted member scope before the first request, with exact scope parameters', async () => {
    localStorage.setItem('awsops:scope', JSON.stringify({ ...MEMBER, regions: ['us-west-2'], includeGlobal: false }));
    const calls = serve();
    mount(view);
    await latestSummary(calls);
    expect(summaries(calls)).toHaveLength(1);
    expect(summaries(calls)[0].url.searchParams.get('accounts')).toBe('222222222222');
    expect(summaries(calls)[0].url.searchParams.get('regions')).toBe('us-west-2');
    expect(summaries(calls)[0].url.searchParams.get('includeGlobal')).toBe('0');
    if (view === 'home') {
      expect(calls.find(call => call.url.pathname === '/api/overview')?.url.searchParams.get('account')).toBe('222222222222');
      expect(calls.find(call => call.url.pathname === '/api/cost')?.url.search).toBe('');
      expect(calls.filter(call => call.url.pathname === '/api/inventory/trend')
        .every(call => call.url.searchParams.get('accounts') === '222222222222' && !call.url.searchParams.has('regions'))).toBe(true);
    }
  });

  it.each(CHANGES)('clears old counts and captured time immediately on a %s change', async (_name, next) => {
    localStorage.setItem('awsops:scope', JSON.stringify(MEMBER));
    const calls = serve();
    const { container } = mount(view);
    await answer(await latestSummary(calls), summary(74));
    expect(tile(container).getByText('74')).toBeTruthy();
    const oldStamp = screen.getByText(/^업데이트:/).textContent!;
    const previousCalls = summaries(calls).length;
    vi.setSystemTime(new Date(NEW_TIME));
    act(() => setActiveScope(next));
    expect(tile(container).queryByText('74')).toBeNull();
    expect(tile(container).queryByText('0')).toBeNull();
    expect(screen.queryByText(oldStamp)).toBeNull();
    expect(refreshButton().disabled).toBe(true);
    const current = await latestSummary(calls, previousCalls + 1);
    expect(current.url.searchParams.get('accounts')).toBe((next.accounts as string[]).join(','));
    expect(current.url.searchParams.get('regions')).toBe(next.regions === '__all__' ? '__all__' : next.regions.join(','));
    expect(current.url.searchParams.get('includeGlobal')).toBe(next.includeGlobal ? '1' : '0');
    await answer(current, summary(55, NEW_TIME));
    expect(tile(container).getByText('55')).toBeTruthy();
    expect(refreshButton().disabled).toBe(false);
  });

  it.each(['success', 'failure'])('ignores an old-scope %s after the member result has loaded', async outcome => {
    const calls = serve();
    const { container } = mount(view);
    const old = await latestSummary(calls);
    act(() => setActiveScope(MEMBER));
    const current = await latestSummary(calls, 2);
    await answer(current, summary(55, NEW_TIME));
    await act(async () => {
      if (outcome === 'success') old.resolve(Response.json(summary(74)));
      else old.reject(new Error('OLD_SCOPE_FAILURE'));
    });
    expect(tile(container).getByText('55')).toBeTruthy();
    expect(tile(container).queryByText('74')).toBeNull();
    expect(screen.queryAllByText(/OLD_SCOPE_FAILURE/)).toHaveLength(0);
    expect(refreshButton().disabled).toBe(false);
    expect(old.signal?.aborted).toBe(true);
  });

  it('clears an old error, ignores old finalizers while loading, and accepts an empty result as zero', async () => {
    const calls = serve();
    const { container } = mount(view);
    const first = await latestSummary(calls);
    await act(async () => { first.reject(new Error('OLD_SCOPE_FAILURE')); });
    await screen.findAllByText(/OLD_SCOPE_FAILURE/);
    fireEvent.click(refreshButton());
    const oldRefresh = await latestSummary(calls, 2);
    act(() => setActiveScope(MEMBER));
    const current = await latestSummary(calls, 3);
    expect(screen.queryAllByText(/OLD_SCOPE_FAILURE/)).toHaveLength(0);
    await act(async () => { oldRefresh.reject(new Error('STALE_REFRESH_FAILURE')); });
    expect(refreshButton().disabled).toBe(true);
    expect(screen.queryAllByText(/STALE_REFRESH_FAILURE/)).toHaveLength(0);
    expect(tile(container).queryByText('0')).toBeNull();
    await answer(current, summary(0, NEW_TIME));
    expect(tile(container).getByText('0')).toBeTruthy();
    expect(refreshButton().disabled).toBe(false);
    expect(screen.getByText(/^업데이트:/)).toBeTruthy();
  });
});

it('group identity remounts summary, captured time and loading state even when scope is unchanged', async () => {
  const calls = serve();
  const { container, rerender } = mount('group');
  await answer(await latestSummary(calls), summary(74));
  const oldStamp = screen.getByText(/^업데이트:/).textContent!;
  rerender(<LanguageProvider><GroupOverviewClient slug="network" /></LanguageProvider>);
  expect(tile(container, 'vpc').queryByText('74')).toBeNull();
  expect(screen.queryByText(oldStamp)).toBeNull();
  expect(refreshButton().disabled).toBe(true);
  await answer(await latestSummary(calls, 2), summary(12, NEW_TIME));
  expect(tile(container, 'vpc').getByText('12')).toBeTruthy();
});

it('group keeps a newer overlapping refresh in charge of error, loading and captured state', async () => {
  const calls = serve();
  const { container } = mount('group');
  await answer(await latestSummary(calls), summary(74));
  const oldStamp = screen.getByText(/^업데이트:/).textContent!;
  const button = refreshButton();
  act(() => { button.click(); button.click(); });
  const current = await latestSummary(calls, 3);
  const superseded = summaries(calls)[1];
  await act(async () => { superseded.reject(new Error('SUPERSEDED_REFRESH')); });
  expect(refreshButton().disabled).toBe(true);
  expect(screen.queryAllByText(/SUPERSEDED_REFRESH/)).toHaveLength(0);
  expect(superseded.signal?.aborted).toBe(true);
  vi.setSystemTime(new Date(NEW_TIME));
  await answer(current, summary(55, NEW_TIME));
  expect(tile(container).getByText('55')).toBeTruthy();
  expect(refreshButton().disabled).toBe(false);
  expect(screen.queryByText(oldStamp)).toBeNull();
});

it('home never starts a stale load’s deferred fleet phase after a scope change', async () => {
  const calls = serve();
  mount('home');
  const old = await latestSummary(calls);
  act(() => setActiveScope(MEMBER));
  await answer(await latestSummary(calls, 2), summary(55, NEW_TIME));
  await waitFor(() => expect(fleets(calls)).toHaveLength(1));
  await answer(old, summary(74));
  expect(fleets(calls)).toHaveLength(1);
  expect(fleets(calls)[0].url.search).toBe(''); // Keep the existing unscoped fleet API contract.
});

it('home keeps the newest fleet result when an older refresh ignores cancellation', async () => {
  const calls = serve();
  mount('home');
  await answer(await latestSummary(calls), summary(74));
  await waitFor(() => expect(fleets(calls)).toHaveLength(1));
  const oldFleet = fleets(calls)[0];
  fireEvent.click(refreshButton());
  await answer(await latestSummary(calls, 2), summary(55, NEW_TIME));
  await waitFor(() => expect(fleets(calls)).toHaveLength(2));
  await answer(fleets(calls)[1], fleet('NEW_FLEET_RESULT'));
  await screen.findByText('NEW_FLEET_RESULT');
  await answer(oldFleet, fleet('OLD_FLEET_RESULT'));
  expect(screen.queryByText('OLD_FLEET_RESULT')).toBeNull();
  expect(screen.getByText('NEW_FLEET_RESULT')).toBeTruthy();
  expect(oldFleet.signal?.aborted).toBe(true);
});

it('home aborts in-flight reads on unmount and cannot start a deferred fleet phase', async () => {
  const calls = serve();
  const { unmount } = mount('home');
  const old = await latestSummary(calls);
  unmount();
  expect(old.signal?.aborted).toBe(true);
  await answer(old, summary(74));
  expect(fleets(calls)).toHaveLength(0);
});

it('home retains the six-second fleet timeout and rejects a reply arriving after it', async () => {
  const calls = serve();
  mount('home');
  const pending = await latestSummary(calls);
  vi.useRealTimers();
  vi.useFakeTimers();
  await answer(pending, summary(55));
  expect(fleets(calls)).toHaveLength(1);
  const late = fleets(calls)[0];
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(late.signal?.aborted).toBe(true);
  await answer(late, fleet('PAST_FLEET_DEADLINE'));
  expect(screen.queryByText('PAST_FLEET_DEADLINE')).toBeNull();
  expect(refreshButton().disabled).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
