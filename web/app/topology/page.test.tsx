// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { FlowNode } from '@/lib/flow-topology';
import { ALL_ACCOUNTS, DEFAULT_SCOPE, setActiveAccount, setActiveScope } from '@/lib/account-context';
import ScopeSelector from '@/components/shell/ScopeSelector';

vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ lang: 'en', tt: (s: string) => s, t: (s: string) => s }),
}));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => 'light' }));
// Keep the page's real data fetching, flow builder and layout; inspect the graph handed to the canvas.
vi.mock('next/dynamic', () => ({
  default: () => ({ nodes, onNodeClick }: {
    nodes: { id: string; data: { label: ReactNode; fnode: FlowNode } }[];
    onNodeClick: (event: unknown, node: unknown) => void;
  }) =>
    <div aria-label="flow graph">{nodes.map(n =>
      <button key={n.id} data-testid={n.data.fnode.kind} data-region={n.data.fnode.meta?.region}
        data-vpc={n.data.fnode.meta?.vpcId} onClick={() => onNodeClick({}, n)}>{n.data.fnode.label}</button>)}</div>,
}));
import TopologyPage from './page';

const region = 'us-east-1', vpcId = 'vpc-a', ip = '10.0.1.10';
const captured = '2026-09-01T10:00:00Z', failed = '2026-09-14T10:00:00Z';
const pod = { name: 'orders-a', namespace: 'shop', podIP: ip, workload: 'orders', status: 'Running' };
const member = '123456789012';
const run = { status: 'succeeded', last_success_at: captured, finished_at: failed, row_count: 20000 };
const memberCapture = '2026-09-13T12:00:00Z';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function serve(options: {
  pods?: unknown[]; rowCapture?: string | null; clusterVpc?: string; ecs?: boolean;
  hostPods?: Promise<Response>; hostInventory?: Promise<Response>; memberInventory?: Promise<Response>;
  subnetStatus?: number; subnetRows?: unknown[]; subnetReject?: boolean;
  runStatus?: string; eksStatus?: number; podStatus?: number; clusterAccess?: string; emptyGraph?: boolean;
} = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, _init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const accountId = url.searchParams.get('accounts') === 'self' ? 'self' : member;
    if (url.pathname === '/api/accounts') return Response.json({
      accounts: [{ accountId: '111111111111', alias: 'Host', isHost: true },
        { accountId: member, alias: 'Member', isHost: false }],
    });
    if (url.pathname === '/api/accounts/regions') return Response.json({ regions: [] });
    if (url.pathname === '/api/eks' && options.eksStatus) return Response.json({ error: 'EKS read failed' }, { status: options.eksStatus });
    if (url.pathname === '/api/eks') return Response.json({
      clusters: options.ecs ? [] : [{ name: 'production', access: options.clusterAccess ?? 'connected', region, vpcId: options.clusterVpc ?? vpcId }], region,
    });
    if (url.searchParams.get('kind') === 'pods' && options.podStatus) return Response.json({ error: 'pod read failed' }, { status: options.podStatus });
    if (url.searchParams.get('kind') === 'pods') return options.hostPods ?? Response.json({ rows: options.pods ?? [pod] });
    if (url.searchParams.get('kind') === 'endpoints') return Response.json({
      rows: [{ name: 'orders-service', namespace: 'shop', ips: [ip], targets: [{ ip, pod: pod.name }] }],
    });
    if (url.pathname.startsWith('/api/inventory/')) {
      if (url.pathname.endsWith('/subnet') && options.subnetReject) throw new Error('subnet transport unavailable');
      if (url.pathname.endsWith('/subnet') && options.subnetStatus) {
        return Response.json({ error: 'subnet read failed' }, { status: options.subnetStatus });
      }
      if (url.pathname.endsWith('/subnet') && options.subnetRows) {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return Response.json({ rows: options.subnetRows.slice(offset, offset + 500).map(row => ({ data: {}, ...row as object, account_id: accountId })), run, consistency: 'repeatable-read' });
      }
      const host = url.searchParams.get('accounts') === 'self';
      if (url.pathname.endsWith('/target_group')) {
        const pending = host ? options.hostInventory : options.memberInventory;
        if (pending) return pending; // Deliberately ignores abort: late completions must also be rejected.
      }
      return Response.json({
      rows: url.pathname.endsWith('/target_group') && !options.emptyGraph ? [{
        resource_id: 'tg-orders', region, account_id: accountId,
        captured_at: options.rowCapture === undefined ? (host ? captured : memberCapture) : options.rowCapture,
        data: { vpc_id: vpcId, target_type: 'ip', target_health_descriptions: [{ Target: { Id: ip, Port: 80 } }] },
      }] : options.ecs && url.pathname.endsWith('/subnet') ? [{
        resource_id: 'subnet-a', region, account_id: accountId, captured_at: captured, data: { vpc_id: vpcId },
      }] : options.ecs && url.pathname.endsWith('/ecs_task') ? [{
        resource_id: 'task-orders', region, account_id: accountId, captured_at: captured, data: {
          last_status: 'RUNNING', task_group: 'service:ecs-orders', cluster_arn: 'cluster/production',
          attachments: [{ Details: [{ Name: 'subnetId', Value: 'subnet-a' }, { Name: 'privateIPv4Address', Value: ip }] }],
        },
      }] : [],
      run: { ...run, status: options.runStatus ?? 'succeeded', error: options.runStatus === 'failed' ? 'collection failed' : null },
      consistency: 'repeatable-read',
    });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
}
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function ready() {
  render(<TopologyPage />);
  await waitFor(() => expect(screen.queryByText('로딩 중…')).toBeNull());
  return screen.getByTestId('target');
}

describe('sample topology evidence', () => {
  it('keeps week-old inventory stale in the Refresh chip after another read', async () => {
    const old = '2026-09-07T12:00:00Z';
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-14T12:00:00Z'));
    try {
      serve({ rowCapture: old, runStatus: 'succeeded' });
      await ready();
      const label = new Date(old).toLocaleString('en-US');
      expect(screen.getByText(/^업데이트:/).textContent).toContain(label);
      expect(screen.getByText(/^업데이트:/).textContent).toContain('(오래됨)');
      const reads = vi.mocked(fetch).mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(reads));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toHaveProperty('disabled', false));
      expect(screen.getByText(/^업데이트:/).textContent).toContain(label);
      expect(screen.getByText(/^업데이트:/).textContent).toContain('(오래됨)');
    } finally { clock.mockRestore(); }
  });
  it('supplies collected subnets to corroborate an ECS attachment IP', async () => {
    serve({ ecs: true });
    expect((await ready()).textContent).toBe('ecs-orders');
  });
  it('discloses a failed subnet read while retaining the unresolved target', async () => {
    serve({ ecs: true, subnetStatus: 503 });
    expect((await ready()).textContent).toBe(ip);
    expect(screen.getByLabelText('Inventory collection evidence').textContent).toContain('subnet: failed');
  });
  it('discloses the subnet cap when attachment evidence lies beyond the returned rows', async () => {
    serve({ ecs: true, subnetRows: Array.from({ length: 10000 }, (_, index) => ({
      resource_id: `subnet-other-${index}`, region, captured_at: captured, data: { vpc_id: vpcId },
    })) });
    expect((await ready()).textContent).toBe(ip);
    expect(screen.getByText(/Response limit reached.*subnet.*10000/)).toBeTruthy();
  });
  it('retains the graph and discloses a rejected subnet transport', async () => {
    serve({ ecs: true, subnetReject: true, runStatus: 'succeeded' });
    expect((await ready()).textContent).toBe(ip);
    expect(screen.getByLabelText('Inventory collection evidence').textContent).toContain('subnet: failed');
    expect(document.body.textContent).not.toContain('subnet transport unavailable');
  });
  it('does not turn a host read failure into unknown aggregate health', async () => {
    serve({ subnetStatus: 503, runStatus: 'succeeded' });
    await ready();
    const text = screen.getByLabelText('Inventory collection evidence').textContent;
    expect(text).toContain('Inventory read failures: subnet: failed');
    expect(text).not.toContain('Run health unknown');
  });
  it('still discloses actual unknown run metadata after successful reads', async () => {
    serve({ runStatus: 'unrecognized' });
    render(<TopologyPage />);
    await screen.findByLabelText('Inventory collection evidence');
    const text = screen.getByLabelText('Inventory collection evidence').textContent;
    expect(text).toContain('Aggregate sync runs: unknown (15)');
    expect(text).toContain('Run health unknown');
    expect(text).toContain('Inventory read failures: target_group: failed, ecs_task: failed, subnet: failed');
    expect(screen.queryByTestId('target')).toBeNull();
  });
  it.each(['entry-only', 'no-entry'])('separates %s onboarding coverage from EKS read failure', async clusterAccess => {
    serve({ clusterAccess, runStatus: 'succeeded' });
    expect((await ready()).textContent).toBe(ip);
    const text = screen.getByLabelText('Inventory collection evidence').textContent;
    expect(text).toContain(`EKS ownership scope: configured region ${region}`);
    expect(text).toContain('other regions are not assessed');
    expect(text).toContain('Not-connected clusters not queried: 1');
    expect(text).toContain('EKS ownership evidence is partial');
    expect(text).not.toContain('EKS ownership read failed');
    expect(screen.getByRole('alert', { name: 'EKS 식별 상태' }).textContent).toContain('cluster_not_connected');
    expect(screen.getByRole('alert', { name: 'EKS 식별 상태' }).textContent).not.toContain('cluster_unreadable');
  });
  it('discloses the configured-region boundary even after successful connected reads', async () => {
    serve({ runStatus: 'succeeded' });
    expect((await ready()).textContent).toBe('shop/orders-service');
    const text = screen.getByLabelText('Inventory collection evidence').textContent;
    expect(text).toContain(`EKS ownership scope: configured region ${region}`);
    expect(text).toContain('other regions are not assessed');
    expect(text).not.toContain('Not-connected clusters not queried:');
  });
  it('keeps capped coverage visible when the graph has no nodes', async () => {
    serve({ emptyGraph: true, runStatus: 'succeeded', subnetRows: Array.from({ length: 10000 }, (_, i) => ({ resource_id: `subnet-${i}`, region })) });
    render(<TopologyPage />);
    await waitFor(() => expect(screen.queryByText('로딩 중…')).toBeNull());
    expect(screen.queryByLabelText('flow graph')).toBeNull();
    expect(screen.getByLabelText('Inventory collection evidence').textContent).toMatch(/Response limit reached.*subnet.*10000/);
  });
  it.each([
    { eksStatus: 503, expected: 'EKS ownership read failed' },
    { podStatus: 503, expected: 'EKS ownership evidence is partial' },
    { clusterVpc: '', expected: 'EKS ownership read failed' },
  ])('discloses EKS evidence degradation: $expected', async ({ expected, ...options }) => {
    serve({ ...options, runStatus: 'succeeded' });
    expect((await ready()).textContent).toBe(ip);
    expect(screen.getByLabelText('Inventory collection evidence').textContent).toContain(expected);
  });
  it.each([{ accounts: [member] }, { accounts: ALL_ACCOUNTS }, { accounts: ['self', member] }])('collapses unavailable run health and explains EKS opt-out for $accounts', async ({ accounts }) => {
    setActiveScope({ ...DEFAULT_SCOPE, accounts });
    serve({ runStatus: 'succeeded' });
    await ready();
    const text = screen.getByLabelText('Inventory collection evidence').textContent ?? '';
    expect(text.match(/Run health unknown for this account scope/g)).toHaveLength(1);
    expect(text).not.toContain('route53: unknown');
    expect(text).not.toContain('Some capture times unknown');
    expect(text).toContain('EKS ownership was not attempted for this account scope');
    expect(eksRequests()).toHaveLength(0);
  });
  it('does not report a running sync as a failure', async () => {
    serve({ runStatus: 'running' });
    await ready();
    const text = screen.getByLabelText('Inventory collection evidence').textContent;
    expect(text).toContain('Aggregate sync runs: running (18)');
    expect(text).not.toContain('Aggregate sync issues:');
    expect(text).not.toContain('Run health unknown');
  });
  it('keeps a real member-scope subnet failure separate from unavailable run health', async () => {
    setActiveScope({ ...DEFAULT_SCOPE, accounts: [member] });
    serve({ runStatus: 'succeeded', subnetStatus: 503 });
    await ready();
    const evidence = screen.getByLabelText('Inventory collection evidence');
    expect(evidence.querySelector('[role="status"]')?.textContent).toBe('Inventory read failures: subnet: failed');
    expect(evidence.textContent).toContain('Run health unknown for this account scope');
  });
  it.each(['failed', 'partial'])('discloses aggregate %s sweeps in member scope without using their clocks', async runStatus => {
    setActiveScope({ ...DEFAULT_SCOPE, accounts: [member] });
    serve({ runStatus, rowCapture: null });
    await ready();
    const evidence = screen.getByLabelText('Inventory collection evidence');
    expect(evidence.textContent).toContain(`Aggregate sync runs: ${runStatus} (18)`);
    expect(evidence.textContent).toContain(`Aggregate sync issues: route53: ${runStatus}`);
    expect(evidence.textContent).toContain('Run health unknown for this account scope');
    expect(evidence.textContent).not.toContain(new Date(captured).toLocaleString());
  });
  it('labels aggregate success separately from unknown member run health', async () => {
    setActiveScope({ ...DEFAULT_SCOPE, accounts: [member] });
    serve({ runStatus: 'succeeded' });
    await ready();
    const text = screen.getByLabelText('Inventory collection evidence').textContent;
    expect(text).toContain('Aggregate sync runs: succeeded (18)');
    expect(text).toContain('Run health unknown for this account scope');
    expect(text).not.toContain('Aggregate sync issues:');
  });
  it('does not reload unchanged account queries on a region-only selection change', async () => {
    serve({ runStatus: 'succeeded' });
    await ready();
    const count = vi.mocked(fetch).mock.calls.length;
    await act(async () => setActiveScope({ ...DEFAULT_SCOPE, regions: ['ap-northeast-2'] }));
    expect(vi.mocked(fetch).mock.calls).toHaveLength(count);
  });
  it('resolves a corroborated pod using its independently listed region and VPC', async () => {
    serve();
    const target = await ready();
    expect(target.textContent).toBe('shop/orders-service');
    expect(target.getAttribute('data-region')).toBe(region);
    expect(target.getAttribute('data-vpc')).toBe(vpcId);
  });
  it('leaves the same IP in another VPC unresolved', async () => {
    serve({ clusterVpc: 'vpc-other' });
    expect((await ready()).textContent).toBe(ip);
  });
  it('does not infer pod ownership from Endpoints without pod inventory', async () => {
    serve({ pods: [] });
    expect((await ready()).textContent).toBe(ip);
  });
  it('shows retained capture evidence and failed collection, never failed-attempt freshness', async () => {
    serve({ runStatus: 'failed' });
    await ready();
    expect(document.body.textContent).not.toContain(new Date(failed).toLocaleString());
    const evidence = screen.getByLabelText('Inventory collection evidence');
    expect(evidence.textContent).toContain(new Date(captured).toLocaleString());
    expect(evidence.textContent).not.toContain(new Date(failed).toLocaleString());
    expect(evidence.textContent).toContain('failed');
  });
  it('uses last success when the host rows have no capture timestamp', async () => {
    serve({ rowCapture: null });
    await ready();
    expect(screen.getByLabelText('Inventory collection evidence').textContent)
      .toContain(new Date(captured).toLocaleString());
  });
  it('does not borrow the host last-success evidence for a member scope', async () => {
    setActiveScope({ ...DEFAULT_SCOPE, accounts: [member] });
    serve({ rowCapture: null });
    await ready();
    const evidence = screen.getByLabelText('Inventory collection evidence');
    expect(evidence.textContent).toContain('unknown');
    expect(evidence.textContent).not.toContain(new Date(captured).toLocaleString());
    expect(screen.getByTestId('target').textContent).toBe(ip);
  });
});

function eksRequests() {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith('/api/eks'));
}
function pendingInventoryResponse() {
  return Response.json({ rows: [{
    resource_id: 'tg-orders', region, account_id: member, captured_at: memberCapture,
    data: { vpc_id: vpcId, target_type: 'ip', target_health_descriptions: [{ Target: { Id: ip, Port: 80 } }] },
  }], run, consistency: 'repeatable-read' });
}
async function hostPodsStarted() {
  await waitFor(() => expect(eksRequests().some(([url]) => String(url).includes('kind=pods'))).toBe(true));
}

describe('topology scope lifecycle through real hooks and events', () => {
  it('follows member and all-account selection through the mounted ScopeSelector, including Refresh', async () => {
    serve();
    render(<><ScopeSelector /><TopologyPage /></>);
    await waitFor(() => expect(screen.getByTestId('target').textContent).toBe('shop/orders-service'));
    fireEvent.click(await screen.findByLabelText('Member'));
    fireEvent.click(screen.getByLabelText('Host (scope.host)'));
    await waitFor(() => expect(screen.getByTestId('target').textContent).toBe(ip));
    const hostReads = eksRequests().length;
    fireEvent.click(screen.getByLabelText('scope.allAccounts'));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) =>
      String(url).includes('accounts=__all__'))).toBe(true));
    await screen.findByRole('button', { name: 'Refresh' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'Refresh' });
    expect(screen.getByTestId('target').textContent).toBe(ip);
    expect(eksRequests()).toHaveLength(hostReads);
  });

  it.each([member, ALL_ACCOUNTS])('never starts a speculative host load for saved scope %s', async account => {
    setActiveScope({ ...DEFAULT_SCOPE, accounts: account === ALL_ACCOUNTS ? account : [account] });
    const late = deferred<Response>();
    serve({ hostPods: late.promise });
    await ready();
    expect(eksRequests()).toHaveLength(0);
    await act(async () => { late.resolve(Response.json({ rows: [pod] })); });
    expect(screen.getByTestId('target').textContent).toBe(ip);
  });

  // The legacy setter also emits scopechange. Before the fix its accountchange lets these
  // tests reproduce the publication race independently of the missing scope subscription.
  it.each([member, ALL_ACCOUNTS])('rejects late host results after scope %s completes', async account => {
    const late = deferred<Response>();
    serve({ hostPods: late.promise });
    render(<TopologyPage />);
    await hostPodsStarted();
    act(() => setActiveAccount(account));
    await waitFor(() => expect(screen.getByTestId('target').textContent).toBe(ip));
    fireEvent.click(screen.getByTestId('target'));
    const currentEvidence = screen.getByLabelText('Inventory collection evidence').textContent;
    await act(async () => { late.resolve(Response.json({ rows: [pod] })); });
    expect(screen.getByTestId('target').textContent).toBe(ip);
    expect(document.body.textContent).not.toContain('shop/orders-service');
    expect(screen.getByLabelText('Inventory collection evidence').textContent).toBe(currentEvidence);
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([member, ALL_ACCOUNTS])('clears visible host graph, details and evidence while scope %s loads', async account => {
    const next = deferred<Response>();
    serve({ memberInventory: next.promise });
    await ready();
    fireEvent.click(screen.getByTestId('target'));
    expect(document.body.textContent).toContain('shop/orders-service');
    act(() => setActiveAccount(account));
    expect(screen.queryByTestId('target')).toBeNull();
    expect(document.body.textContent).not.toContain('shop/orders-service');
    expect(screen.queryByLabelText('Inventory collection evidence')).toBeNull();
    expect(document.body.textContent).not.toContain(new Date(captured).toLocaleString());
    await act(async () => { next.resolve(pendingInventoryResponse()); });
    expect(screen.getByTestId('target').textContent).toBe(ip);
  });

  it.each(['resolve', 'reject'] as const)('late host %s cannot clear a member load busy state or publish an error', async outcome => {
    const host = deferred<Response>(), next = deferred<Response>();
    serve({ hostInventory: host.promise, memberInventory: next.promise });
    render(<TopologyPage />);
    await hostPodsStarted();
    act(() => setActiveAccount(member));
    await act(async () => {
      if (outcome === 'reject') host.reject(new Error('late host failure'));
      else host.resolve(pendingInventoryResponse());
    });
    expect(document.body.textContent).not.toContain('late host failure');
    expect(screen.queryByTestId('target')).toBeNull();
    expect((screen.getByRole('button', { name: '수집 중…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { next.resolve(pendingInventoryResponse()); });
    expect(screen.getByTestId('target').textContent).toBe(ip);
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('cancels every in-flight host fetch when switching scope and current fetches on unmount', async () => {
    const late = deferred<Response>();
    serve({ hostPods: late.promise });
    const view = render(<TopologyPage />);
    await hostPodsStarted();
    const hostCalls = [...vi.mocked(fetch).mock.calls];
    act(() => setActiveScope({ ...DEFAULT_SCOPE, accounts: [member] }));
    await waitFor(() => expect(screen.getByTestId('target').textContent).toBe(ip));
    expect(hostCalls.length).toBeGreaterThan(0);
    for (const [, init] of hostCalls) expect(init?.signal?.aborted).toBe(true);
    const currentCalls = vi.mocked(fetch).mock.calls.slice(hostCalls.length);
    view.unmount();
    for (const [, init] of currentCalls) expect(init?.signal?.aborted).toBe(true);
    await act(async () => { late.resolve(Response.json({ rows: [pod] })); });
  });
});
