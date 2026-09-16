// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import TopologyPage from './page';
import NetworkFlowPage from '../network-flow/page';
import { DEFAULT_SCOPE, setActiveAccount, setActiveScope } from '@/lib/account-context';
import * as topology from '@/lib/flow-topology';

const region = 'us-east-1', vpcId = 'vpc-app';
const row = (resource_id: string, data: object) => ({ account_id: 'self', resource_id, region, captured_at: '2026-09-11T11:00:00Z', data });
// One global type-sweep ledger, shared by host/member reads; not this scope's row count.
const RUN = { status: 'succeeded', finished_at: '2026-09-11T12:00:00Z', last_success_at: '2026-09-11T12:00:00Z', row_count: 20000 };
type Body = { rows: ReturnType<typeof row>[]; run: typeof RUN };
const SCOPE_CHANGES = [
  { ...DEFAULT_SCOPE, accounts: ['123456789012'] },
  { ...DEFAULT_SCOPE, regions: ['us-west-2'] },
  { ...DEFAULT_SCOPE, includeGlobal: false },
];
const targets = row('tg-app', { captured_at: '2099-01-01T00:00:00Z', vpc_id: vpcId, target_type: 'ip', target_health_descriptions:
  ['10.0.1.2', '10.0.1.3'].map(Id => ({ Target: { Id, Port: 80 } })) });
const task = (name: string) => row(`task-${name}`, {
  task_group: `service:${name}`, cluster_arn: 'cluster/ecs-app', last_status: 'RUNNING',
  attachments: [{ Details: [{ Name: 'subnetId', Value: 'subnet-app' }, { Name: 'privateIPv4Address', Value: '10.0.1.2' }] }],
});
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function serve(options: { failures?: Set<string>; eks?: object; failure?: 'http' | 'envelope' | 'malformed'; failedType?: string; nfm?: object;
  inventoryReply?: (url: URL, body: Body, signal?: AbortSignal | null) => Response | Promise<Response>;
} = {}) {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost'); requests.push(url);
    if (url.pathname === '/api/accounts') return Response.json({ accounts: [{ accountId: '111111111111', isHost: true }] });
    if (url.pathname === '/api/nfm') return Response.json(options.nfm ?? { monitors: [], scopeCount: 0 });
    if (url.pathname === '/api/nfm/query') return Response.json({ rows: [], unit: 'Bytes', tookMs: 1 });
    if (url.pathname === '/api/graph') return Response.json({ class: 'trace', account: 'self', nodes: [], edges: [], captured_at: null });
    if (url.pathname === '/api/eks' && options.eks) return Response.json({ region, truncated: false, ...options.eks });
    if (url.pathname === '/api/eks') return Response.json({ region, truncated: false, clusters: [
      { name: 'good', region, vpcId, access: 'connected' },
      { name: 'wrong', region, vpcId: 'vpc-other', access: 'connected' },
    ] });
    if (url.pathname.endsWith('/incluster')) {
      const cluster = url.pathname.split('/')[3];
      return Response.json({ rows: url.searchParams.get('kind') === 'pods'
        ? [{ name: `${cluster}-pod`, namespace: 'shop', podIP: '10.0.1.3', workload: cluster, status: 'Running' }]
        : [{ name: `service-${cluster}`, namespace: 'shop', ips: ['10.0.1.3'],
          targets: [{ ip: '10.0.1.3', pod: `${cluster}-pod` }] }] });
    }
    if (url.pathname.startsWith('/api/inventory/')) {
      const type = url.pathname.split('/').pop(), host = url.searchParams.get('accounts') === 'self';
      if (options.failures?.has(type!) || options.failures?.has('*')) return Response.json({ error: 'Unavailable' }, { status: 503 });
      if (options.failure && (!options.failedType || options.failedType === type)) {
        return Response.json(options.failure === 'malformed' ? { rows: null } : { status: 'error', message: 'fixture unavailable' }, { status: options.failure === 'http' ? 503 : 200 });
      }
      const all = type === 'target_group' ? [targets] : type === 'ecs_task' ? [task(host ? 'ecs-api' : 'member-api')]
        : type === 'subnet' ? [row('subnet-app', { vpc_id: vpcId, tags: { Name: 'App subnet' } })] : [];
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit'));
      const rows = all.slice(offset, offset + limit).map(r => ({ ...r, account_id: url.searchParams.get('accounts') === '__all__' ? r.account_id : host ? 'self' : url.searchParams.get('accounts')! }));
      const body = { rows, run: { ...RUN }, consistency: 'statement-snapshot' };
      return options.inventoryReply?.(url, body, init?.signal) ?? Response.json(body);
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  return requests;
}
function search(value: string) {
  fireEvent.change(screen.getByPlaceholderText('리소스 이름 검색…'), { target: { value } });
}

function mount(initial = '/topology', component = <TopologyPage />) {
  window.history.replaceState({}, '', initial);
  let update!: (href: string) => void;
  const entries = [initial];
  let index = 0;
  const publish = (href: string) => {
    window.history.replaceState({}, '', href);
    update(href);
  };
  const router: AppRouterInstance = {
    push: vi.fn(href => { entries.splice(++index); entries.push(href); publish(href); }),
    replace: vi.fn(href => { entries[index] = href; publish(href); }),
    back: () => { if (index > 0) publish(entries[--index]); },
    forward: () => { if (index + 1 < entries.length) publish(entries[++index]); },
    refresh: () => {}, prefetch: () => {},
  };
  function Harness() {
    const [href, setHref] = useState(initial);
    update = setHref;
    // Outside Next's compiler, next/link reads RouterContext; use the same navigation
    // adapter as useRouter so the real Link handler still drives this harness.
    return <RouterContext.Provider value={router as unknown as NextRouter}>
      <AppRouterContext.Provider value={router}>
      <SearchParamsContext.Provider value={new URL(href, 'http://localhost').searchParams}>
        {component}
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>
    </RouterContext.Provider>;
  }
  render(<Harness />);
  return router;
}

async function flowReady() {
  await screen.findByRole('link', { name: '서비스 + 네트워크 →' });
  await waitFor(() => expect(screen.queryByText('로딩 중…')).toBeNull());
}
async function e2eReady() {
  await screen.findByRole('region', { name: 'NFM 소스' });
}


describe('canonical scope and retained-evidence integration', () => {
it.each(['flow', 'e2e'])('keeps healthy EKS nodes with a partial notice in %s when another VPC is unreadable', async view => {
    serve({ eks: { clusters: [{ name: 'good', region, vpcId, access: 'connected' },
      { name: 'blocked', region, vpcId: 'vpc-other', access: 'no-entry' }] } });
    mount(`/topology?view=${view}`);
    expect(await screen.findByRole('alert', { name: 'EKS 식별 상태' })).toHaveProperty('textContent', expect.stringContaining('연결되지 않은 EKS 클러스터 범위'));
    fireEvent.change(view === 'flow' ? screen.getByPlaceholderText('리소스 이름 검색…')
      : screen.getByRole('searchbox', { name: '서비스 또는 리소스 검색' }), { target: { value: 'service-good' } });
    expect(screen.getByRole('button', { name: /service-good/ })).toBeTruthy();
    act(() => setActiveAccount('123456789012'));
    await waitFor(() => expect(screen.queryByRole('alert', { name: 'EKS 식별 상태' })).toBeNull());
  });

it('renders successful inventory types when an unrelated type fails', async () => {
    serve({ failures: new Set(['alb_listener_rule']) }); mount();
    await screen.findByText(/alb_listener_rule: invalid inventory response/);
    search('ecs-api');
    expect(screen.getByRole('button', { name: /ecs-api/ })).toBeTruthy();
  });

it('uses router navigation for view controls and preserves unrelated deep-link parameters', async () => {
    serve();
    const router = mount('/topology?monitor=vpc-monitor&range=1800');
    await flowReady();
    fireEvent.click(screen.getByRole('link', { name: '서비스 + 네트워크 →' }));
    await e2eReady();
    expect(router.push).toHaveBeenCalledWith('/topology?monitor=vpc-monitor&range=1800&view=e2e', { scroll: false });
    fireEvent.click(screen.getByRole('link', { name: '구성 흐름으로 돌아가기' }));
    await flowReady();
    expect(router.push).toHaveBeenLastCalledWith('/topology?monitor=vpc-monitor&range=1800', { scroll: false });
  });

it.each([
    { accounts: ['123456789012'], regions: ['us-east-1'], includeGlobal: false },
    { accounts: '__all__' as const, regions: '__all__' as const, includeGlobal: true },
  ])('restores persisted scope before any inventory or host observation request: %j', async scope => {
    window.localStorage.setItem('awsops:scope', JSON.stringify(scope));
    const requests = serve();
    mount('/topology?view=e2e');
    await e2eReady();
    await waitFor(() => expect(within(screen.getByRole('region', { name: '구성 소스' }))
      .queryByText('구성을 불러오는 중…')).toBeNull());
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(url => url.pathname.startsWith('/api/inventory/'))).toBe(true);
    expect(requests.every(url => url.searchParams.get('accounts') ===
      (scope.accounts === '__all__' ? '__all__' : scope.accounts.join(',')))).toBe(true);
    expect(requests.every(url => url.searchParams.get('regions') ===
      (scope.regions === '__all__' ? '__all__' : scope.regions.join(',')))).toBe(true);
    expect(requests.every(url => url.searchParams.get('includeGlobal') === (scope.includeGlobal ? '1' : '0'))).toBe(true);
    expect(requests.filter(url => ['/api/nfm', '/api/graph', '/api/eks', '/api/nfm/query'].includes(url.pathname))).toEqual([]);
  });

it('passes existing subnet inventory into ECS resolution without a second subnet request', async () => {
    const requests = serve();
    mount();
    await flowReady();
    fireEvent.change(screen.getByPlaceholderText('리소스 이름 검색…'), { target: { value: 'ecs-api' } });
    expect(await screen.findByRole('button', { name: /^ecs-api\s*target$/ })).toBeTruthy();
    expect(requests.filter(url => url.pathname === '/api/inventory/subnet')).toHaveLength(1);
  });

it('updates the cluster filter from same-page navigation and writes filter controls to the URL', async () => {
    serve();
    const router = mount('/topology?cluster=ecs%3Aecs-app');
    await flowReady();
    // The cluster select is identified by its option, avoiding assumptions about toolbar order.
    const select = screen.getByRole('option', { name: 'Cluster: 전체' }).parentElement as HTMLSelectElement;
    expect(select.value).toBe('ecs:ecs-app');
    act(() => router.push('/topology'));
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'ecs:ecs-app' } });
    expect(new URLSearchParams(window.location.search).get('cluster')).toBe('ecs:ecs-app');
    expect(new URLSearchParams(window.location.search).get('clusterScope')).toBe('accounts=self&regions=__all__&includeGlobal=1');
    act(() => router.back());
    expect(select.value).toBe('');
  });

it.each(SCOPE_CHANGES)('clears a previous scope cluster while retaining other URL settings: %j', async nextScope => {
    let changed = false;
    serve({ inventoryReply: (url, body) => Response.json({
      ...body, rows: changed && url.pathname.endsWith('/ecs_task') ? body.rows.map(row => ({
        ...row, data: { ...row.data, cluster_arn: 'cluster/new-scope' },
      })) : body.rows,
    }) });
    const router = mount('/topology?monitor=retained-monitor&range=1800&cluster=ecs%3Aecs-app');
    await flowReady();
    expect((screen.getByRole('option', { name: 'Cluster: 전체' }).parentElement as HTMLSelectElement).value).toBe('ecs:ecs-app');
    changed = true;
    act(() => setActiveScope(nextScope));
    await screen.findByRole('option', { name: 'ECS · new-scope' });
    await waitFor(() => expect((screen.getByRole('option', { name: 'Cluster: 전체' }).parentElement as HTMLSelectElement).value).toBe(''));
    expect(router.replace).toHaveBeenCalledWith('/topology?monitor=retained-monitor&range=1800', { scroll: false });
    const expected = nextScope.accounts[0] === 'self' ? 'ecs-api' : 'member-api';
    search(expected);
    expect(await screen.findByRole('button', { name: new RegExp(expected) })).toBeTruthy();
  });

it.each(SCOPE_CHANGES)('rejects historical cluster filters after a scope change even when the cluster name still exists: %j', async nextScope => {
    serve();
    const router = mount('/topology?cluster=ecs%3Aecs-app&monitor=kept');
    await flowReady();
    const select = () => screen.getByRole('option', { name: 'Cluster: 전체' }).parentElement as HTMLSelectElement;
    expect(select().value).toBe('ecs:ecs-app');
    fireEvent.change(select(), { target: { value: 'eks:good' } });
    act(() => setActiveScope(nextScope));
    await flowReady();
    await waitFor(() => expect(select().value).toBe(''));
    act(() => router.back());
    await flowReady();
    await waitFor(() => expect(select().value).toBe(''));
    expect(new URLSearchParams(window.location.search).get('cluster')).toBeNull();
    expect(new URLSearchParams(window.location.search).get('monitor')).toBe('kept');
    search(nextScope.accounts[0] === 'self' ? 'ecs-api' : 'member-api');
    expect(await screen.findByRole('button', { name: /(?:ecs|member)-api/ })).toBeTruthy();
    act(() => router.forward());
    await waitFor(() => expect(select().value).toBe(''));
  });

it.each(SCOPE_CHANGES)('clears selected resource details on scope changes: %j', async nextScope => {
    serve();
    mount();
    await flowReady();
    // Use the target group (always present, independently of ECS attribution).
    fireEvent.change(screen.getByPlaceholderText('리소스 이름 검색…'), { target: { value: 'tg-app' } });
    fireEvent.click(await screen.findByRole('button', { name: /^tg-app\s*tg$/ }));
    expect(screen.getByRole('button', { name: 'ARN 복사' })).toBeTruthy();
    act(() => setActiveScope(nextScope));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ARN 복사' })).toBeNull());
  });

it.each(['flow', 'e2e'])('retains configuration after a same-scope failed refresh in %s but never carries it into another account', async view => {
    const options: NonNullable<Parameters<typeof serve>[0]> = {};
    serve(options); mount(`/topology?view=${view}`);
    const find = async (value: string) => {
      const box = view === 'flow' ? await screen.findByPlaceholderText('리소스 이름 검색…')
        : await screen.findByRole('searchbox', { name: '서비스 또는 리소스 검색' });
      fireEvent.change(box, { target: { value } });
    };
    await find('ecs-api'); await screen.findByRole('button', { name: /ecs-api/ });
    options.failure = 'http';
    fireEvent.click(screen.getByRole('button', { name: view === 'flow' ? 'Refresh' : '새로고침' }));
    await screen.findByText('조회 실패로 이전 결과를 표시합니다.');
    await find('ecs-api'); expect(screen.getByRole('button', { name: /ecs-api/ })).toBeTruthy();
    act(() => setActiveAccount('123456789012'));
    await find('ecs-api');
    expect(screen.queryByRole('button', { name: /ecs-api/ })).toBeNull();
    expect(screen.queryByText('조회 실패로 이전 결과를 표시합니다.')).toBeNull();
  });

it.each(['flow', 'e2e'])('shows all inventory failures above the empty state in %s', async view => {
    serve({ failure: 'http' }); mount(`/topology?view=${view}`);
    expect(await screen.findByText(/route53: invalid inventory response/)).toBeTruthy();
    expect(screen.queryByText(/그래프로 그릴 리소스가 없습니다/)).toBeNull();
  });

it.each(['http', 'envelope', 'malformed'] as const)('keeps valid topology while disclosing %s enrichment failure', async failure => {
    serve({ failure, failedType: 'vpc' }); mount(); await flowReady();
    expect(await screen.findByText(/vpc: invalid inventory response/)).toBeTruthy();
    expect(within(screen.getByLabelText('Inventory collection evidence')).getByText(/vpc: 실패/)).toBeTruthy();
    search('ecs-api'); expect(screen.getByRole('button', { name: /ecs-api/ })).toBeTruthy();
  });

it('serializes every network-flow link parameter without query or fragment injection', async () => {
    const monitor = `monitor & ? # " <tag>`, metric = 'metric&view=flow#bad', category = 'category&account=other';
    serve({ nfm: { monitors: [{ name: monitor, status: 'ACTIVE', cluster: null }], scopeCount: 1,
      metrics: ['DATA_TRANSFERRED', metric], categories: ['INTER_AZ', category] } });
    mount('/network-flow', <NetworkFlowPage />);
    const link = await screen.findByRole('link', { name: '서비스 + 네트워크 →' });
    await waitFor(() => expect(new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('monitor')).toBe(monitor));
    fireEvent.change(screen.getByRole('option', { name: metric }).parentElement!, { target: { value: metric } });
    fireEvent.change(screen.getByRole('option', { name: category }).parentElement!, { target: { value: category } });
    const url = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(url.pathname).toBe('/topology'); expect(url.hash).toBe('');
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: 'e2e', monitor, metric, category, range: '3600' });
  });

it.each(['__all__', '123456789012'])('discloses unqueried EKS ownership on %s target details without host reads', async account => {
    setActiveAccount(account);
    const requests = serve(); mount();
    await screen.findByText('이 계정 범위에서는 EKS 소유 근거를 조회하지 않음');
    search('10.0.1.3'); fireEvent.click(screen.getByRole('button', { name: /10.0.1.3/ }));
    expect(await screen.findByText('eks_not_enumerated')).toBeTruthy();
    expect(screen.getByText('cached_configuration')).toBeTruthy();
    expect(requests.some(url => url.pathname === '/api/eks')).toBe(false);
  });
});
