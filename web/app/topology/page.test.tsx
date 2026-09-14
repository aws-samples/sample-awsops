// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TopologyPage from './page';
import { setActiveAccount } from '@/lib/account-context';

const region = 'us-east-1', vpcId = 'vpc-app';
const row = (resource_id: string, data: object) => ({ resource_id, region, data });
const targets = row('tg-app', { vpc_id: vpcId, target_type: 'ip', target_health_descriptions:
  ['10.0.1.2', '10.0.1.3'].map(Id => ({ Target: { Id, Port: 80 } })) });
const task = (name: string) => row(`task-${name}`, {
  task_group: `service:${name}`, cluster_arn: 'cluster/ecs-app',
  attachments: [{ Details: [{ Name: 'subnetId', Value: 'subnet-app' }, { Name: 'privateIPv4Address', Value: '10.0.1.2' }] }],
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serve(options: { lateTask?: Promise<Response>; subnetFailed?: boolean; failures?: Set<string>; eks?: object; eksFailed?: boolean } = {}) {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost'); requests.push(url);
    if (url.pathname === '/api/eks' && options.eksFailed) return Response.json({ message: 'secret=not-a-real-credential-1234567890' }, { status: 503 });
    if (url.pathname === '/api/eks' && options.eks) return Response.json(options.eks);
    if (url.pathname === '/api/eks') return Response.json({ clusters: [
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
      const rows = type === 'target_group' ? [targets] : type === 'ecs_task' ? [task(host ? 'ecs-api' : 'member-api')]
        : type === 'subnet' ? [row('subnet-app', { vpc_id: vpcId, tags: { Name: 'App subnet' } })] : [];
      return Response.json({ rows, run: { finished_at: '2026-09-11T12:00:00Z' } });
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
    { eks: { clusters: Array.from({ length: 25 }, (_, i) => ({ name: `cluster-${i}`, region, vpcId, access: 'connected' })) } },
  ])('discloses unavailable EKS resolution without hiding other inventory: %j', async options => {
    serve(options); render(<TopologyPage />);
    await screen.findByRole('alert', { name: 'EKS 식별 상태' });
    search('ecs-api'); expect(screen.getByRole('button', { name: /ecs-api/ })).toBeTruthy();
    expect(document.body.textContent).not.toContain('not-a-real-credential');
  });
  it('does not label successful empty EKS enumeration as a failure', async () => {
    serve({ eks: { clusters: [] } }); render(<TopologyPage />);
    await screen.findByRole('option', { name: 'ECS · ecs-app' });
    expect(screen.queryByRole('alert', { name: 'EKS 식별 상태' })).toBeNull();
  });

  it('resolves ECS through real subnet inventory and EKS through the scoped producer', async () => {
    const requests = serve(); render(<TopologyPage />);
    await screen.findByRole('option', { name: 'ECS · ecs-app' });
    await waitFor(() => expect(document.querySelector('.react-flow')).not.toBeNull());
    search('ecs-api'); expect(screen.getByRole('button', { name: /ecs-api/ })).toBeTruthy();
    search('shop/service-good'); expect(screen.getByRole('button', { name: /service-good/ })).toBeTruthy();
    search('shop/service-wrong'); expect(screen.queryByRole('button', { name: /service-wrong/ })).toBeNull();
    expect(requests.filter(url => url.pathname === '/api/inventory/subnet')).toHaveLength(1);
  });

  it('does not present a failed subnet read as an empty successful inventory', async () => {
    serve({ subnetFailed: true }); render(<TopologyPage />);
    expect(await screen.findByText(/503.*subnet|subnet.*503/)).toBeTruthy();
    expect(screen.queryByText(/그래프로 그릴 리소스가 없습니다/)).toBeNull();
  });

  it('renders successful inventory types when an unrelated type fails', async () => {
    serve({ failures: new Set(['alb_listener_rule']) }); render(<TopologyPage />);
    await screen.findByText(/alb_listener_rule.*503/);
    search('ecs-api');
    expect(screen.getByRole('button', { name: /ecs-api/ })).toBeTruthy();
  });

  it('retains previous same-account data after total refresh failure but clears it on account switch', async () => {
    const failures = new Set<string>(); serve({ failures }); render(<TopologyPage />);
    await screen.findByRole('option', { name: 'ECS · ecs-app' });
    await waitFor(() => expect(document.querySelector('.react-flow')).not.toBeNull());
    failures.add('*');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('조회 실패로 이전 결과를 표시합니다.');
    expect(document.querySelector('.react-flow')).not.toBeNull();
    search('ecs-api'); expect(screen.getByRole('button', { name: /ecs-api/ })).toBeTruthy();
    act(() => setActiveAccount('123456789012'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /ecs-api/ })).toBeNull());
    expect(screen.queryByText('조회 실패로 이전 결과를 표시합니다.')).toBeNull();
    expect(screen.queryByText(/그래프로 그릴 리소스가 없습니다/)).toBeNull();
  });

  it('ignores a late host load after account selection changes', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const requests = serve({ lateTask: pending }); render(<TopologyPage />);
    await waitFor(() => expect(requests.some(url => url.pathname.endsWith('/ecs_task'))).toBe(true));
    act(() => setActiveAccount('123456789012'));
    await screen.findByRole('option', { name: 'ECS · ecs-app' });
    await act(async () => { resolve(Response.json({ rows: [task('ecs-api')] })); });
    search('ecs-api'); expect(screen.queryByRole('button', { name: /ecs-api/ })).toBeNull();
    search('member-api'); expect(screen.getByRole('button', { name: /member-api/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'EKS · good' })).toBeNull();
  });
});
