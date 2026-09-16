// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { DEFAULT_SCOPE, setActiveScope, type ScopeSelection } from '@/lib/account-context';
import InventoryTypePage from './page';

let currentType = 'ec2';
vi.mock('next/navigation', () => ({ useParams: () => ({ type: currentType }) }));
vi.mock('@/components/ui/DataTable', () => ({
  default: ({ rows, onRowClick }: { rows: Record<string, unknown>[]; onRowClick: (r: Record<string, unknown>) => void }) =>
    <div data-testid="rows">{rows.map((r) =>
      <button key={String(r.resource_id)} onClick={() => onRowClick(r)}>{String(r.resource_id)}</button>)}</div>,
}));
vi.mock('@/components/ui/DetailPanel', () => ({
  default: ({ data, actions }: { data: Record<string, unknown> | null; actions?: ReactNode }) =>
    data ? <aside data-testid="detail">{String(data.resource_id)}{actions}</aside> : null,
}));
vi.mock('@/components/inventory/VpcResourceMap', () => ({
  default: ({ vpcId }: { vpcId: string }) => <aside data-testid="map">{vpcId}</aside>,
}));
vi.mock('@/components/charts/DonutBreakdown', () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock('@/components/charts/BarDistribution', () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock('@/components/inventory/NodeMetricsTables', () => ({
  ElasticacheNodeMetrics: () => null, OpensearchDomainMetrics: () => null, MskBrokerNodes: () => null,
  RdsInstanceMetrics: () => null, DynamoTableMetrics: () => null, AlbMetrics: () => null,
  NlbMetrics: () => null, S3Metrics: () => null, EbsMetrics: () => null, Ec2Metrics: () => null,
  LambdaMetrics: () => null, TgwSection: () => null,
}));

const MEMBER: ScopeSelection = { accounts: ['222222222222'], regions: '__all__', includeGlobal: true };
const STAMP = '2026-09-16T01:00:00.000Z';
const response = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const inventory = (id: string | null, count = 1) => ({
  rows: id === null ? [] : Array.from({ length: count }, (_, i) => ({
    resource_id: count === 1 ? id : `${id}-${i}`,
    region: 'ap-northeast-2',
    data: { instance_state: 'running', instance_type: 't3.micro', name: id },
  })),
  run: { finished_at: STAMP },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler) {
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (/^\/api\/inventory\/[^/]+(?:\/metrics|\/refresh)?$/.test(url.pathname)) return Promise.resolve(handler(url, init));
    return Promise.resolve(response({}));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const isList = (url: URL) => !url.pathname.endsWith('/metrics') && !url.pathname.endsWith('/refresh')
  && url.searchParams.get('view') !== 'agg';
const isMember = (url: URL) => url.searchParams.get('accounts') === MEMBER.accounts[0];
async function switchScope(scope: ScopeSelection) {
  await act(async () => { setActiveScope(scope); });
}
async function settle(work: () => void) {
  await act(async () => { work(); await Promise.resolve(); });
}

beforeEach(() => { currentType = 'ec2'; localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

describe('inventory selection owns visible state', () => {
  it('waits for persisted member selection before the first inventory or metric request', async () => {
    localStorage.setItem('awsops:scope', JSON.stringify(MEMBER));
    const fetch = mockFetch(url => response(isList(url) ? inventory('member') : { cards: [] }));
    render(<InventoryTypePage />);
    await screen.findByRole('button', { name: 'member' });
    expect(fetch.mock.calls.length).toBeGreaterThan(0);
    for (const [url] of fetch.mock.calls) expect(new URL(String(url), 'http://localhost').searchParams.get('accounts'))
      .toBe('222222222222');
  });

  it.each(['success', 'error'] as const)('ignores late old-scope %s even when fetch ignores abort', async outcome => {
    const old = deferred<Response>();
    const fetch = mockFetch(url => !isList(url) ? response({ cards: [] })
      : isMember(url) ? response(inventory('member')) : old.promise);
    render(<InventoryTypePage />);
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => isList(new URL(String(u), 'http://localhost')))).toBe(true));
    await switchScope(MEMBER);
    const oldRead = fetch.mock.calls.find(([u]) => isList(new URL(String(u), 'http://localhost')));
    expect(oldRead?.[1]?.signal?.aborted).toBe(true);
    await screen.findByRole('button', { name: 'member' });
    await settle(() => outcome === 'success' ? old.resolve(response(inventory('old-host'))) : old.reject(new Error('old-scope-error')));
    expect(screen.queryByRole('button', { name: 'member' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'old-host' })).toBeNull();
    expect(screen.queryByText(/old-scope-error/)).toBeNull();
  });

  it.each([
    MEMBER,
    { ...DEFAULT_SCOPE, regions: ['us-east-1'] },
    { ...DEFAULT_SCOPE, includeGlobal: false },
  ] as ScopeSelection[])('clears rows, details and counts while a new selection loads: %j', async scope => {
    let second = false;
    const pending = deferred<Response>();
    mockFetch(url => !isList(url) ? response({ cards: [] })
      : second ? pending.promise : response(inventory('old-row')));
    render(<InventoryTypePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'old-row' }));
    expect(screen.queryByTestId('detail')).not.toBeNull();
    second = true;
    await switchScope(scope);
    expect(screen.queryByRole('button', { name: 'old-row' })).toBeNull();
    expect(screen.queryByTestId('detail')).toBeNull();
    expect(screen.queryByText(/0개 리소스|1개 리소스/)).toBeNull();
    await settle(() => pending.resolve(response(inventory(null))));
    await screen.findByText(/0개 리소스/);
  });

  it('clears map selection and filters across resource types', async () => {
    currentType = 'vpc';
    mockFetch(url => response(isList(url) ? inventory(url.pathname.endsWith('/vpc') ? 'vpc-old' : 'lambda-new') : { cards: [] }));
    const view = render(<InventoryTypePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'vpc-old' }));
    fireEvent.click(screen.getByRole('button', { name: '리소스 맵 열기' }));
    expect(screen.queryByTestId('map')).not.toBeNull();
    currentType = 'lambda';
    view.rerender(<InventoryTypePage />);
    await screen.findByRole('button', { name: 'lambda-new' });
    expect(screen.queryByTestId('map')).toBeNull();
    expect(screen.queryByTestId('detail')).toBeNull();
    currentType = 'vpc';
    view.rerender(<InventoryTypePage />);
    await screen.findByRole('button', { name: 'vpc-old' });
    expect(screen.queryByTestId('map')).toBeNull();
  });

  it('does not carry an old account search filter into the new account', async () => {
    mockFetch(url => response(isList(url) ? inventory(isMember(url) ? 'member' : 'old-host') : { cards: [] }));
    render(<InventoryTypePage />);
    await screen.findByRole('button', { name: 'old-host' });
    fireEvent.change(screen.getByPlaceholderText('검색…'), { target: { value: 'old-host' } });
    await switchScope(MEMBER);
    await screen.findByRole('button', { name: 'member' });
    expect((screen.getByPlaceholderText('검색…') as HTMLInputElement).value).toBe('');
  });

  it('does not reload an obsolete scope when its collection request completes', async () => {
    const queued = deferred<Response>();
    const fetch = mockFetch((url, init) => init?.method === 'POST' ? queued.promise
      : response(isList(url) ? inventory(isMember(url) ? 'member' : 'old-host') : { cards: [] }));
    render(<InventoryTypePage />);
    await screen.findByRole('button', { name: 'old-host' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await switchScope(MEMBER);
    await screen.findByRole('button', { name: 'member' });
    const oldReads = () => fetch.mock.calls.filter(([u, init]) => {
      const url = new URL(String(u), 'http://localhost');
      return isList(url) && !isMember(url) && init?.method !== 'POST';
    }).length;
    const before = oldReads();
    await settle(() => queued.resolve(response({ ok: true })));
    expect(oldReads()).toBe(before);
    expect(screen.queryByRole('button', { name: 'member' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false);
  });

  it('clears an earlier error after a successful retry in the same selection', async () => {
    let failed = true;
    mockFetch((url, init) => init?.method === 'POST' ? response({ ok: true })
      : !isList(url) ? response({ cards: [] })
        : failed ? response({}, 500) : response(inventory('recovered')));
    render(<InventoryTypePage />);
    await screen.findByText('Error: 500');
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'recovered' });
    expect(screen.queryByText('Error: 500')).toBeNull();
  });

  it.each(['success', 'error'] as const)('refreshes metrics and ignores a late preceding metric %s', async outcome => {
    const stale = deferred<Response>();
    let refreshes = 0;
    const fetch = mockFetch((url, init) => {
      if (init?.method === 'POST') { refreshes++; return response({ ok: true }); }
      if (isList(url)) return response(inventory(refreshes ? 'fresh-row' : 'first-row'));
      return refreshes ? response({ cards: [{ label: 'fresh metric', value: 42 }] }) : stale.promise;
    });
    render(<InventoryTypePage />);
    await screen.findByRole('button', { name: 'first-row' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'fresh-row' });
    await screen.findByText('fresh metric');
    const metrics = fetch.mock.calls.filter(([u]) => String(u).includes('/metrics'));
    expect(metrics).toHaveLength(2);
    expect(metrics[0][1]?.signal?.aborted).toBe(true);
    await settle(() => outcome === 'success'
      ? stale.resolve(response({ cards: [{ label: 'old metric', value: 9 }] }))
      : stale.reject(new Error('old metric error')));
    expect(screen.queryByText('fresh metric')).not.toBeNull();
    expect(screen.queryByText('old metric')).toBeNull();
    expect(screen.queryByText(/old metric error/)).toBeNull();
  });

  it('keeps the current full count when an older aggregate resolves later', async () => {
    const oldAgg = deferred<Response>();
    const fetch = mockFetch(url => {
      if (url.pathname.endsWith('/metrics')) return response({ cards: [] });
      if (url.searchParams.get('view') === 'agg') {
        return isMember(url) ? response({ total: 700, state: [], dist: [], facets: {} }) : oldAgg.promise;
      }
      return response(inventory(isMember(url) ? 'member' : 'host', 500));
    });
    render(<InventoryTypePage />);
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes('view=agg'))).toBe(true));
    await switchScope(MEMBER);
    await screen.findByText(/700개 리소스/);
    await settle(() => oldAgg.resolve(response({ total: 900, state: [], dist: [], facets: {} })));
    expect(screen.queryByText(/700개 리소스/)).not.toBeNull();
    expect(screen.queryByText(/900개 리소스/)).toBeNull();
  });

  it('retains disclosed sample counts when aggregation is unavailable', async () => {
    mockFetch(url => url.pathname.endsWith('/metrics') ? response({ cards: [] })
      : url.searchParams.get('view') === 'agg' ? response({}, 503)
        : response(inventory('row', 500)));
    render(<InventoryTypePage />);
    await screen.findByText(/500개 리소스/);
    expect(await screen.findAllByText(/표본 기준/)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^row-/ })).toHaveLength(500);
  });
});
