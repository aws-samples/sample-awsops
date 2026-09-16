// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import EksPage from './page';
import FleetKindPage from '@/components/eks/FleetKindPage';
import EksExplorerPage from './explorer/page';
import EksFleetCostPage from './cost/page';
import { setActiveScope } from '@/lib/account-context';

const TARGET = '222222221802';
const ID = `arn:aws:eks:us-east-1:${TARGET}:cluster/shared`;
const HOST_QUERY = 'regions=__all__&includeGlobal=1';
const TARGET_QUERY = `accounts=${TARGET}&regions=us-east-1&includeGlobal=1`;
const targetScope = { accounts: [TARGET], regions: ['us-east-1'], includeGlobal: true };
const host = { name: 'host-cluster', access: 'connected', region: 'ap-northeast-2' };
const target = { id: ID, name: 'shared', accountId: TARGET, region: 'us-east-1', access: 'connected', runtime: true };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const node = (name: string) => ({
  name, status: 'Ready', roles: 'worker', version: 'v1.31', instanceType: 'm6g.large', zone: 'a', age: '1d',
  cpuCapacity: 4, cpuAllocatable: 3.5, memCapacity: 8192, memAllocatable: 7168,
});
const pod = (name: string) => ({ name, namespace: 'default', node: 'node1', status: 'Running', cpuRequest: 1, memRequest: 128 });
const fleet = (cluster: typeof host, count: number) => ({
  ...cluster, reachable: true, counts: { nodes: count, nodesReady: count, pods: count, podsRunning: count, deployments: 0, services: 0 },
  nodeAgg: [], instanceTypes: [], podStatus: { Running: count }, podsByNamespace: [], events: [],
});
const allocation = (name: string) => ({
  available: true, source: 'opencost', namespaces: [], nodes: [],
  pods: [{ pod: name, namespace: 'default', node: 'node1', cpuCost: 1, ramCost: 1, networkCost: 0, pvCost: 0, gpuCost: 0, totalCost: 2 }],
  kpi: { dailyTotal: 2, monthly: 60, podCount: 1, topNamespace: null }, hasNetwork: false, hasPv: false, hasGpu: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function mockApi(overrides: {
  list?: (url: URL) => Response | Promise<Response>;
  fleet?: (url: URL) => Response | Promise<Response>;
  resource?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;
} = {}) {
  return vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const isTarget = url.searchParams.get('accounts')?.includes(TARGET) || false;
    if (url.pathname === '/api/eks') return overrides.list?.(url) ?? response({ clusters: [isTarget ? target : host], admin: true });
    if (url.pathname === '/api/eks/fleet') return overrides.fleet?.(url) ?? response({ clusters: [fleet(isTarget ? target : host, isTarget ? 2 : 6)] });
    const resource = overrides.resource?.(url, init);
    if (resource) return resource;
    if (url.pathname.endsWith('/register')) return response({ registered: true });
    const isQualified = decodeURIComponent(url.pathname).includes(ID);
    if (url.pathname.endsWith('/incluster')) return response({ rows: url.searchParams.get('kind') === 'nodes' ? [node(isQualified ? 'target-row' : 'host-row')] : [pod(isQualified ? 'target-row' : 'host-row')] });
    if (url.pathname.endsWith('/allocation')) return response(allocation(isQualified ? 'target-row' : 'host-row'));
    return response({ available: false, rows: [], found: false });
  }));
}
beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pages = [
  { name: 'overview', render: () => <EksPage />, marker: 'shared' },
  { name: 'fleet', render: () => <FleetKindPage kind="nodes" />, marker: 'target-row' },
  { name: 'explorer', render: () => <EksExplorerPage />, marker: 'target-row' },
  { name: 'cost', render: () => <EksFleetCostPage />, marker: 'target-row' },
];
describe.each(pages)('$name scope lifecycle', ({ name, render: page, marker }) => {
  it('waits for persisted scope and sends the full account/region selection without a host probe', async () => {
    setActiveScope({ ...targetScope, accounts: [TARGET, '333333333333'], regions: ['us-east-1', 'us-west-2'] });
    mockApi();
    render(page());
    await waitFor(() => expect(screen.getAllByText(marker).length).toBeGreaterThan(0));
    const discovery = vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/eks?') || url.startsWith('/api/eks/fleet'));
    expect(discovery.length).toBeGreaterThan(0);
    for (const url of discovery) {
      const params = new URL(url, 'http://localhost').searchParams;
      expect(params.get('accounts')).toBe(`${TARGET},333333333333`);
      expect(params.get('regions')).toBe('us-east-1,us-west-2');
    }
  });

  it('clears host data on selection and refreshes the current target scope', async () => {
    const pendingTarget = deferred<Response>();
    let delayTarget = true;
    mockApi({ list: (url) => url.searchParams.get('accounts') === TARGET && delayTarget
      ? pendingTarget.promise : response({ clusters: [url.searchParams.has('accounts') ? target : host], admin: true }) });
    render(page());
    await waitFor(() => expect(screen.getAllByText(name === 'overview' ? 'host-cluster' : 'host-row').length).toBeGreaterThan(0));
    act(() => setActiveScope(targetScope));
    expect(screen.queryAllByText('host-row')).toHaveLength(0);
    expect(screen.queryAllByText('host-cluster')).toHaveLength(0);
    delayTarget = false;
    await act(async () => pendingTarget.resolve(response({ clusters: [target], admin: true })));
    await waitFor(() => expect(screen.getAllByText(marker).length).toBeGreaterThan(0));
    vi.mocked(fetch).mockClear();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0));
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    if (name === 'explorer') expect(urls).toContain(`/api/eks/${encodeURIComponent(ID)}/incluster?kind=pods`);
    else expect(urls).toContain(`/api/eks?${TARGET_QUERY}`);
    expect(urls).not.toContain(`/api/eks?${HOST_QUERY}`);
    expect(urls).not.toContain('/api/eks?account=self');
  });

  it('discards a late host discovery response after switching accounts', async () => {
    const lateHost = deferred<Response>();
    mockApi({ list: (url) => url.searchParams.has('accounts') ? response({ clusters: [target], admin: true }) : lateHost.promise });
    render(page());
    act(() => setActiveScope(targetScope));
    await waitFor(() => expect(screen.getAllByText(marker).length).toBeGreaterThan(0));
    const callsBefore = vi.mocked(fetch).mock.calls.length;
    await act(async () => lateHost.resolve(response({ clusters: [host], admin: true })));
    expect(screen.queryAllByText('host-row')).toHaveLength(0);
    expect(screen.queryAllByText('host-cluster')).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.slice(callsBefore).some(([url]) => String(url).includes('/host-cluster/'))).toBe(false);
  });

  it('discloses collection failures and truncation instead of claiming a complete fleet', async () => {
    mockApi({ list: () => response({ clusters: [], errors: [{ accountId: TARGET, region: 'us-east-1', message: 'scope unavailable' }], truncated: true }) });
    render(page());
    await waitFor(() => expect(screen.getByText(/scope unavailable/)).toBeTruthy());
    expect(screen.getByText(/scope unavailable/).textContent).toContain(TARGET);
    expect(screen.getByText(/일부 결과만 표시/)).toBeTruthy();
  });
});

describe.each(pages.filter((page) => page.name !== 'overview'))('$name discovery completeness', ({ render: page }) => {
  it.each([
    { name: 'partial account errors', errors: [{ accountId: TARGET, region: 'us-east-1', message: 'scope unavailable' }], truncated: false },
    { name: 'truncation without errors', errors: [], truncated: true },
  ])('keeps zero collected clusters unknown for $name', async ({ errors, truncated }) => {
    mockApi({ list: () => response({ clusters: [], errors, truncated }) });
    render(page());
    await screen.findByRole('status');
    await screen.findByRole('button', { name: 'Refresh' });
    expect(screen.queryByText(/클러스터가 없습니다/)).toBeNull();
    expect(screen.queryByText(/클러스터를 등록하세요/)).toBeNull();
    expect(screen.getByText(/클러스터 유무를 확인할 수 없습니다/).textContent).toMatch(/범위를 좁혀 다시 조회/);
    if (errors.length) expect(screen.getByRole('status').textContent).toContain('scope unavailable');
    if (truncated) expect(screen.getByRole('status').textContent).toContain('일부 결과만 표시');
  });

  it('shows registration guidance when complete discovery confirms no connected clusters', async () => {
    mockApi({ list: () => response({ clusters: [], errors: [], truncated: false }) });
    render(page());
    expect(await screen.findByText(/클러스터가 없습니다/)).toBeTruthy();
    expect(screen.getByText(/클러스터를 등록하세요/)).toBeTruthy();
    expect(screen.queryByText(/클러스터 유무를 확인할 수 없습니다/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

it.each(pages.filter((page) => page.name !== 'overview'))('$name closes selected details on a region-only change', async ({ render: page }) => {
  setActiveScope(targetScope);
  const pending = deferred<Response>();
  mockApi({ list: (url) => url.searchParams.get('regions') === 'us-west-2'
    ? pending.promise : response({ clusters: [target] }) });
  render(page());
  const cell = (await screen.findAllByText('target-row')).find((element) => element.closest('tr'))!;
  fireEvent.click(cell);
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  act(() => setActiveScope({ ...targetScope, regions: ['us-west-2'] }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryAllByText('target-row')).toHaveLength(0);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === `/api/eks?accounts=${TARGET}&regions=us-west-2&includeGlobal=1`)).toBe(true);
  await act(async () => pending.resolve(response({ clusters: [] })));
});

it('overview discards late host fleet totals after switching scope', async () => {
  const pending = deferred<Response>();
  mockApi({ fleet: (url) => url.searchParams.has('accounts') ? response({ clusters: [fleet(target, 2)] }) : pending.promise });
  render(<EksPage />);
  await screen.findByRole('link', { name: 'host-cluster' });
  act(() => setActiveScope(targetScope));
  await screen.findByText(/2 nodes/);
  await act(async () => pending.resolve(response({ clusters: [fleet(host, 6)] })));
  expect(screen.queryByText(/6 nodes/)).toBeNull();
  expect(screen.getByText('Nodes').closest('.shadow-card')?.textContent).toContain('2');
});

it('a registration completing after scope switch cannot reload the old host scope', async () => {
  const pending = deferred<Response>();
  mockApi({
    list: (url) => response({ clusters: [url.searchParams.has('accounts') ? target : { ...host, access: 'entry-only' }], admin: true }),
    resource: (url) => url.pathname === '/api/eks/host-cluster/register' ? pending.promise : undefined,
  });
  render(<EksPage />);
  fireEvent.click(await screen.findByRole('button', { name: '조회 등록' }));
  act(() => setActiveScope(targetScope));
  await screen.findByRole('link', { name: 'shared' });
  const before = vi.mocked(fetch).mock.calls.length;
  await act(async () => pending.resolve(response({ registered: true })));
  expect(vi.mocked(fetch).mock.calls).toHaveLength(before);
  expect(screen.queryByText(/host-cluster 등록 완료/)).toBeNull();
});

it('overview sends qualified IDs for registration, auth and unregister, and links to the same target', async () => {
  setActiveScope(targetScope);
  let registered = false;
  mockApi({ list: () => response({ clusters: [{ ...target, access: registered ? 'connected' : 'entry-only' }], admin: true }) });
  render(<EksPage />);
  const register = await screen.findByRole('button', { name: '조회 등록' });
  registered = true;
  fireEvent.click(register);
  await waitFor(() => expect(screen.getByRole('link', { name: 'shared' }).getAttribute('href')).toBe(`/eks/${encodeURIComponent(ID)}`));
  expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === `/api/eks/${encodeURIComponent(ID)}/register` && init?.method === 'POST')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '인증 등록' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'test-token' } });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === `/api/eks/${encodeURIComponent(ID)}/register` && init?.body === '{"auth":{"mode":"sa-token","token":"test-token"}}')).toBe(true));
  await waitFor(() => expect(screen.queryByRole('button', { name: '저장' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '해제' }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === `/api/eks/${encodeURIComponent(ID)}/register` && init?.method === 'DELETE')).toBe(true));
});

it('overview joins same-name fleet members by ID and filters them independently', async () => {
  const other = { ...target, id: 'arn:aws:eks:us-west-2:333333333333:cluster/shared', accountId: '333333333333', region: 'us-west-2' };
  setActiveScope({ accounts: '__all__', regions: '__all__', includeGlobal: true });
  mockApi({
    list: () => response({ clusters: [target, other] }),
    fleet: () => response({ clusters: [fleet(target, 2), fleet(other, 7)] }),
  });
  render(<EksPage />);
  await waitFor(() => expect(screen.getAllByRole('link', { name: 'shared' })).toHaveLength(2));
  const first = screen.getAllByRole('link', { name: 'shared' })[0].closest('[role="button"]')!;
  expect(within(first as HTMLElement).getByText(/2 nodes/)).toBeTruthy();
  const second = screen.getAllByRole('link', { name: 'shared' })[1].closest('[role="button"]')!;
  expect(within(second as HTMLElement).getByText(/7 nodes/)).toBeTruthy();
  fireEvent.click(first);
  expect(screen.getByText('Nodes').closest('.shadow-card')?.textContent).toContain('2');
  expect(screen.getByText('Nodes').closest('.shadow-card')?.textContent).not.toContain('9');
});
