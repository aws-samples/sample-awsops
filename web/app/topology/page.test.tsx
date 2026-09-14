// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TopologyPage from './page';
import { setActiveAccount } from '@/lib/account-context';
import * as topology from '@/lib/flow-topology';

const region = 'us-east-1', vpcId = 'vpc-app';
const row = (resource_id: string, data: object) => ({ account_id: 'self', resource_id, region, captured_at: '2026-09-11T11:00:00Z', data });
// One global type-sweep ledger, shared by host/member reads; not this scope's row count.
const RUN = { status: 'succeeded', finished_at: '2026-09-11T12:00:00Z', last_success_at: '2026-09-11T12:00:00Z', row_count: 20000 };
type Body = { rows: ReturnType<typeof row>[]; run: typeof RUN };
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

function serve(options: { lateTask?: Promise<Response>; subnetFailed?: boolean; failures?: Set<string>; eks?: object; eksFailed?: boolean; subnetCapped?: boolean;
  inventory?: Record<string, ReturnType<typeof row>[]>;
  inventoryReply?: (url: URL, body: Body, signal?: AbortSignal | null) => Response | Promise<Response>;
} = {}) {
  const requests: URL[] = [];
  const inventories = { ...options.inventory };
  if (options.subnetCapped) inventories.subnet = Array.from({ length: 10000 }, (_, i) => row(i ? `extra-${i}` : 'subnet-app', { vpc_id: vpcId }));
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost'); requests.push(url);
    if (url.pathname === '/api/eks' && options.eksFailed) return Response.json({ message: 'secret=not-a-real-credential-1234567890' }, { status: 503 });
    if (url.pathname === '/api/eks' && options.eks) return Response.json({ region, truncated: false, ...options.eks });
    if (url.pathname === '/api/eks') return Response.json({ region, truncated: false, clusters: [
      { name: 'good', region, vpcId, access: 'connected' },
      { name: 'wrong', region, vpcId: 'vpc-other', access: 'connected' },
    ] });
    if (url.pathname.endsWith('/incluster')) {
      const cluster = url.pathname.split('/')[3];
      return Response.json({ rows: url.searchParams.get('kind') === 'pods'
        ? [{ name: `${cluster}-pod`, namespace: 'shop', podIP: '10.0.1.3', workload: cluster }]
        : [{ name: `service-${cluster}`, namespace: 'shop', ips: ['10.0.1.3'],
          targets: [{ ip: '10.0.1.3', pod: `${cluster}-pod` }] }] });
    }
    if (url.pathname.startsWith('/api/inventory/')) {
      const type = url.pathname.split('/').pop(), host = url.searchParams.get('accounts') === 'self';
      if (options.failures?.has(type!) || options.failures?.has('*')) return Response.json({ error: 'Unavailable' }, { status: 503 });
      if (type === 'ecs_task' && host && options.lateTask) return options.lateTask;
      if (type === 'subnet' && options.subnetFailed) return Response.json({ error: 'Unavailable' }, { status: 503 });
      const all = inventories[type!] ?? (type === 'target_group' ? [targets] : type === 'ecs_task' ? [task(host ? 'ecs-api' : 'member-api')]
        : type === 'subnet' ? [row('subnet-app', { vpc_id: vpcId, tags: { Name: 'App subnet' } })] : []);
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit'));
      const rows = all.slice(offset, offset + limit).map(r => ({ ...r, account_id: url.searchParams.get('accounts') === '__all__' ? r.account_id : host ? 'self' : url.searchParams.get('accounts')! }));
      const body = { rows, run: { ...RUN } };
      return options.inventoryReply?.(url, body, init?.signal) ?? Response.json(body);
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  return requests;
}
function search(value: string) {
  fireEvent.change(screen.getByPlaceholderText('리소스 이름 검색…'), { target: { value } });
}

describe('live topology inventory adapter', () => {
  it.each([
    { eksFailed: true },
    { eks: { clusters: [{ name: 'blocked', region, vpcId, access: 'unknown' }] } },
    { eks: { truncated: true, clusters: Array.from({ length: 25 }, (_, i) => ({ name: `cluster-${i}`, region, vpcId, access: 'connected' })) } },
    { eks: { region: undefined, clusters: [] } },
  ])('discloses unavailable EKS resolution without hiding other inventory: %j', async options => {
    serve(options); render(<TopologyPage />);
    await screen.findByRole('alert', { name: 'EKS 식별 상태' });
    await waitFor(() => expect(document.querySelector('.react-flow__node')).not.toBeNull());
    expect(screen.queryByRole('option', { name: 'ECS · ecs-app' })).toBeNull();
    expect(document.body.textContent).not.toContain('not-a-real-credential');
  });
  it.each(['ecs_task', 'subnet-cap'])('does not treat %s read gaps as absent ownership competitors', async gap => {
    serve({ failures: new Set(gap === 'ecs_task' ? ['ecs_task'] : []), subnetCapped: gap === 'subnet-cap' });
    render(<TopologyPage />);
    await screen.findByText('인벤토리 조회 실패 또는 행 수 제한으로 IP 소유권을 확인할 수 없습니다.');
    expect(screen.queryByRole('option', { name: 'EKS · good' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'ECS · ecs-app' })).toBeNull();
  });
  it('keeps healthy EKS nodes visible when another VPC is unreadable', async () => {
    serve({ eks: { clusters: [{ name: 'good', region, vpcId, access: 'connected' },
      { name: 'blocked', region, vpcId: 'vpc-other', access: 'no-entry' }] } });
    render(<TopologyPage />);
    await screen.findByRole('alert', { name: 'EKS 식별 상태' });
    search('service-good'); expect(screen.getByRole('button', { name: /service-good/ })).toBeTruthy();
  });
  it('does not label successful empty EKS enumeration as a failure', async () => {
    serve({ eks: { clusters: [] } }); render(<TopologyPage />);
    await screen.findByRole('option', { name: 'ECS · ecs-app' });
    expect(screen.queryByRole('alert', { name: 'EKS 식별 상태' })).toBeNull();
  });

  it('resolves ECS through real subnet inventory and EKS through the scoped producer', async () => {
    const graph = vi.spyOn(topology, 'buildFlowGraph');
    const requests = serve(); render(<TopologyPage />);
    await screen.findByRole('option', { name: 'ECS · ecs-app' });
    await waitFor(() => expect(document.querySelector('.react-flow')).not.toBeNull());
    search('ecs-api'); expect(screen.getByRole('button', { name: /ecs-api/ })).toBeTruthy();
    search('shop/service-good'); expect(screen.getByRole('button', { name: /service-good/ })).toBeTruthy();
    search('shop/service-wrong'); expect(screen.queryByRole('button', { name: /service-wrong/ })).toBeNull();
    expect(requests.filter(url => url.pathname === '/api/inventory/subnet')).toHaveLength(1);
    expect(graph.mock.calls.at(-1)?.[0].tg?.[0].captured_at).toBe('2026-09-11T11:00:00Z');
  });

  it('does not present a failed subnet read as an empty successful inventory', async () => {
    serve({ subnetFailed: true }); render(<TopologyPage />);
    expect(await screen.findByText(/subnet: invalid inventory response/)).toBeTruthy();
    expect(screen.queryByText(/그래프로 그릴 리소스가 없습니다/)).toBeNull();
  });

  it('renders successful inventory types when an unrelated type fails', async () => {
    serve({ failures: new Set(['alb_listener_rule']) }); render(<TopologyPage />);
    await screen.findByText(/alb_listener_rule: invalid inventory response/);
    search('ecs-api');
    expect(screen.getByRole('button', { name: /ecs-api/ })).toBeTruthy();
  });

  it.each([false, true])('retains same-account graph provenance after total refresh failure (partial: %s)', async partial => {
    const failures = new Set<string>();
    const options = { failures, eks: { clusters: [
      { name: 'good', region, vpcId, access: 'connected' },
      { name: 'blocked', region, vpcId: 'vpc-other', access: partial ? 'no-entry' : 'connected' },
    ] },
      inventoryReply: (url: URL, body: Body) => Response.json(partial && url.pathname.endsWith('/ecs_task')
        ? { ...body, run: { ...body.run, status: 'partial' } } : body) };
    serve(options); render(<TopologyPage />);
    await screen.findByText(/인벤토리 동기화:/);
    await waitFor(() => expect(document.querySelector('.react-flow')).not.toBeNull());
    const label = partial ? 'ambiguous:' : 'ecs-api';
    const syncWarning = '인벤토리 동기화가 완료되지 않아 IP 소유권을 확인할 수 없습니다.';
    expect(!!screen.queryByRole('alert', { name: 'EKS 식별 상태' })).toBe(partial);
    expect(!!screen.queryByText(syncWarning)).toBe(partial);
    failures.add('*');
    options.eks = { clusters: partial ? [] : [{ name: 'blocked', region, vpcId, access: 'no-entry' }] };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('조회 실패로 이전 결과를 표시합니다.');
    expect(document.querySelector('.react-flow')).not.toBeNull();
    search(label); expect(screen.getByRole('button', { name: partial ? /×2/ : /ecs-api/ })).toBeTruthy();
    expect(!!screen.queryByRole('alert', { name: 'EKS 식별 상태' })).toBe(partial);
    expect(!!screen.queryByText(syncWarning)).toBe(partial);
    act(() => setActiveAccount('123456789012'));
    await waitFor(() => expect(screen.queryByRole('button', { name: partial ? /×2/ : /ecs-api/ })).toBeNull());
    expect(screen.queryByRole('alert', { name: 'EKS 식별 상태' })).toBeNull();
    expect(screen.queryByText(syncWarning)).toBeNull();
    expect(screen.queryByText('조회 실패로 이전 결과를 표시합니다.')).toBeNull();
    expect(screen.queryByText(/그래프로 그릴 리소스가 없습니다/)).toBeNull();
  });

  it('ignores a late host load after account selection changes', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const requests = serve({ lateTask: pending }); render(<TopologyPage />);
    await waitFor(() => expect(requests.some(url => url.pathname.endsWith('/ecs_task'))).toBe(true));
    act(() => setActiveAccount('123456789012'));
    const oldRequest = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/ecs_task') && String(url).includes('accounts=self'));
    expect(oldRequest?.[1]?.signal?.aborted).toBe(true);
    await screen.findByRole('option', { name: 'ECS · ecs-app' });
    await act(async () => { resolve(Response.json({ rows: [task('ecs-api')], run: RUN })); });
    search('ecs-api'); expect(screen.queryByRole('button', { name: /ecs-api/ })).toBeNull();
    search('member-api'); expect(screen.getByRole('button', { name: /member-api/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'EKS · good' })).toBeNull();
  });
});

function largeInventory(type: string) {
  return [...Array.from({ length: 500 }, (_, i) => row(`filler-${i}`, {})),
    type === 'ecs_task' ? task('ecs-api') : row('subnet-app', { vpc_id: vpcId })];
}
describe('bounded ownership inventory paging', () => {
  it.each([['self', 'ecs_task'], ['self', 'subnet'], ['123456789012', 'ecs_task'], ['123456789012', 'subnet']])('pages %s / %s without paging display types', async (account, type) => {
    const requests = serve({ inventory: { [type]: largeInventory(type) } });
    render(<TopologyPage />);
    await screen.findByRole('option', { name: 'ECS · ecs-app' });
    if (account !== 'self') {
      requests.length = 0;
      act(() => setActiveAccount(account));
      await waitFor(() => expect(requests.some(u => u.pathname.endsWith(`/${type}`) && u.searchParams.get('offset') === '500')).toBe(true));
      await screen.findByRole('option', { name: 'ECS · ecs-app' });
    }
    expect(requests.filter(u => u.pathname.endsWith(`/${type}`)).map(u => u.searchParams.get('offset'))).toEqual(['0', '500']);
    expect(requests.filter(u => u.pathname.endsWith('/target_group'))).toHaveLength(1);
    expect(requests.filter(u => u.pathname.startsWith('/api/inventory/')).every(u => u.searchParams.get('accounts') === account)).toBe(true);
    expect(screen.queryByText('인벤토리 조회 실패 또는 행 수 제한으로 IP 소유권을 확인할 수 없습니다.')).toBeNull();
    if (account !== 'self') {
      search('ecs:'); fireEvent.click(screen.getByRole('button', { name: /ecs-api|member-api/ }));
      expect(await screen.findByText('cached_configuration')).toBeTruthy();
      expect(requests.some(u => u.pathname === '/api/eks')).toBe(false);
    }
  });

  it.each([false, true])('discloses out-of-region context without exclusive cluster filtering (pin: %s)', async pin => {
    const west = <T extends { region: string }>(value: T) => ({ ...value, region: 'us-west-2' });
    if (pin) window.history.replaceState({}, '', '/?cluster=ecs:ecs-app');
    serve({ inventory: { target_group: [west(targets)], ecs_task: [west(task('ecs-api'))],
      subnet: [west(row('subnet-app', { vpc_id: vpcId }))] } });
    render(<TopologyPage />);
    await screen.findByText(/인벤토리 동기화:/);
    expect(screen.getByText(/EKS 조회 범위 밖의 대상은 소유권 미확인입니다. 조회 리전:/)).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'ECS · ecs-app' })).toBeNull();
    if (pin) { expect(document.querySelectorAll('.react-flow__node')).toHaveLength(0); return; }
    search('ecs-api'); fireEvent.click(screen.getByRole('button', { name: /ecs-api/ }));
    expect(await screen.findByText('eks_not_enumerated')).toBeTruthy();
    expect(screen.getByText('scope_unverified')).toBeTruthy();
  });

  it.each(['finished_at', 'last_success_at', 'row_count', 'missing-run', 'missing-version', 'duplicate', 'malformed', 'http', 'json'])(
    'withholds ownership for a %s paging inconsistency', async defect => {
      const graph = vi.spyOn(topology, 'buildFlowGraph');
      const inventory = largeInventory('ecs_task');
      const requests = serve({ inventory: { ecs_task: inventory }, inventoryReply: (url, body) => {
        if (!url.pathname.endsWith('/ecs_task')) return Response.json(body);
        if (url.searchParams.get('offset') !== '500') return Response.json(body);
        if (defect === 'http') return Response.json({ message: 'secret=canary' }, { status: 503 });
        if (defect === 'json') return new Response('secret=canary is not JSON');
        if (defect === 'missing-run') return Response.json({ rows: body.rows });
        if (defect === 'missing-version') return Response.json({ ...body, run: { ...body.run, last_success_at: undefined } });
        if (defect === 'duplicate') return Response.json({ ...body, rows: [inventory[0]] });
        if (defect === 'malformed') return Response.json({ ...body, rows: [{ ...inventory[500], account_id: undefined }] });
        return Response.json({ ...body, run: { ...body.run, [defect]: defect === 'row_count' ? 502 : '2026-09-11T12:01:00Z' } });
      } });
      render(<TopologyPage />);
      if (['finished_at', 'last_success_at', 'row_count'].includes(defect)) {
        await screen.findByText('인벤토리 동기화가 완료되지 않아 IP 소유권을 확인할 수 없습니다.');
        expect(graph.mock.calls.at(-1)?.[0].ecsTask).toHaveLength(500);
      } else await screen.findByText(/ecs_task: invalid inventory response/);
      expect(screen.queryByRole('option', { name: 'ECS · ecs-app' })).toBeNull();
      expect(document.body.textContent).not.toContain('secret=canary');
      expect(requests.filter(u => u.pathname.endsWith('/ecs_task')).length).toBeLessThanOrEqual(2);
    });

  it('stops at twenty pages and discloses the remaining cap', async () => {
    const requests = serve({ subnetCapped: true }); render(<TopologyPage />);
    await screen.findByText('인벤토리 조회 실패 또는 행 수 제한으로 IP 소유권을 확인할 수 없습니다.');
    expect(requests.filter(u => u.pathname.endsWith('/subnet'))).toHaveLength(20);
    expect(screen.queryByRole('option', { name: 'ECS · ecs-app' })).toBeNull();
  });

  it.each(['running', 'partial', 'failed'])('retains cached %s rows without asserting exclusive ownership', async status => {
    const graph = vi.spyOn(topology, 'buildFlowGraph');
    serve({ inventoryReply: (url, body) => Response.json(url.pathname.endsWith('/ecs_task')
      ? { ...body, run: { ...body.run, status, finished_at: status === 'running' ? null : RUN.finished_at, row_count: status === 'running' ? null : 1 } } : body) });
    render(<TopologyPage />);
    await screen.findByText('인벤토리 동기화가 완료되지 않아 IP 소유권을 확인할 수 없습니다.');
    expect(graph.mock.calls.at(-1)?.[0].ecsTask).toHaveLength(1);
    expect(screen.queryByRole('option', { name: 'ECS · ecs-app' })).toBeNull();
    expect(screen.queryByText(/invalid inventory response/)).toBeNull();
  });

  it.each([false, true])('clears the load deadline after settling (invalid JSON: %s)', async invalid => {
    const scheduled = vi.spyOn(globalThis, 'setTimeout'), cleared = vi.spyOn(globalThis, 'clearTimeout');
    serve({ inventoryReply: (url, body) => invalid && url.pathname.endsWith('/ecs_task') ? new Response('secret=canary') : Response.json(body) });
    render(<TopologyPage />);
    if (invalid) await screen.findByText(/ecs_task: invalid inventory response/);
    else await screen.findByRole('option', { name: 'ECS · ecs-app' });
    const deadlines = scheduled.mock.calls.flatMap((args, i) => args[1] === 30000 ? [scheduled.mock.results[i].value] : []);
    expect(deadlines).toHaveLength(1);
    expect(cleared).toHaveBeenCalledWith(deadlines[0]);
  });

  it.each(['inventory', 'eks-list', 'eks-pods'])('aborts stalled %s reads at the shared thirty-second budget', async stage => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    serve({ inventory: { ecs_task: largeInventory('ecs_task') } });
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const stalled = stage === 'inventory' ? url.pathname.endsWith('/ecs_task') && url.searchParams.get('offset') === '500'
        : stage === 'eks-list' ? url.pathname === '/api/eks' : url.searchParams.get('kind') === 'pods';
      if (!stalled) return normal(input, init);
      signal = init?.signal;
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('secret=canary')), { once: true }));
    });
    render(<TopologyPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(signal?.aborted).toBe(true);
    if (stage === 'inventory') expect(screen.getByText(/ecs_task: invalid inventory response/)).toBeTruthy();
    else expect(screen.getByRole('alert', { name: 'EKS 식별 상태' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveProperty('disabled', false);
    expect(document.body.textContent).not.toContain('secret=canary');
  });
});
