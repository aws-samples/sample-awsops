// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/components/shell/LanguageProvider';
import type { GraphInput, ServiceGraph } from '@/lib/k8s-service-graph';
import type { TraceOverlay } from '@/lib/k8s-trace-overlay';

interface CanvasProps { graph: ServiceGraph; input: GraphInput; query: string; theme: string; onSelectService?: (id: string) => void }
const canvas = vi.hoisted(() => ({ props: null as CanvasProps | null, renders: 0 }));
vi.mock('@/components/topology/ServiceGraphCanvas', () => ({
  default: (props: CanvasProps) => {
    canvas.props = props;
    canvas.renders += 1;
    return (
      <div data-testid="canvas">
        <button type="button" onClick={() => props.onSelectService?.('svc:prod/api')}>select-service</button>
      </div>
    );
  },
}));
// fetchTraceOverlay is the real module unless a test overrides it.
const trace = vi.hoisted(() => ({ override: null as null | ((c: { id: string; hostAccountId?: string }, s?: AbortSignal) => Promise<TraceOverlay>) }));
vi.mock('@/lib/k8s-trace-overlay', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/k8s-trace-overlay')>();
  return {
    ...actual,
    fetchTraceOverlay: (c: Parameters<typeof actual.fetchTraceOverlay>[0], s?: AbortSignal) =>
      (trace.override ? trace.override(c, s) : actual.fetchTraceOverlay(c, s)),
  };
});
// fetchDnsRecords is the real module unless a test overrides it.
import type { DnsRead } from '@/lib/k8s-dns';
const dns = vi.hoisted(() => ({ override: null as null | ((accountId: string, s?: AbortSignal) => Promise<DnsRead>) }));
vi.mock('@/lib/k8s-dns', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/k8s-dns')>();
  return { ...actual, fetchDnsRecords: (a: string, s?: AbortSignal) => (dns.override ? dns.override(a, s) : actual.fetchDnsRecords(a, s)) };
});

import K8sMapView, { TRACE_NOTICE, traceOmittedNotice } from './K8sMapView';
import { applyTerms } from '@/lib/i18n-terms';

const MEMBER_ARN = 'arn:aws:eks:ap-northeast-2:222222222222:cluster/shared';
const ENC_MEMBER = encodeURIComponent(MEMBER_ARN);

const svc = (namespace: string, name: string) => ({ name, namespace, type: 'ClusterIP', clusterIP: '172.20.0.10', ports: '80/TCP', age: '1h' });
const ROWS: Record<string, unknown[]> = {
  services: [svc('prod', 'api'), svc('kube-system', 'kube-dns'), svc('dev', 'web')],
  ingresses: [], pods: [], endpoints: [],
  nodes: [{ name: 'node-a', status: 'Ready', roles: '', version: 'v1.31', instanceType: 'm7g.large', zone: 'apne2-a', age: '9d',
    cpuCapacity: 4, cpuAllocatable: 4, memCapacity: 1, memAllocatable: 1, diskCapacity: 0, diskAllocatable: 0 }],
};
const OK_REFS = { refs: [], secretRefs: [], truncated: false, partial: false };

type Handler = (url: string) => Response | Promise<Response> | undefined;
function stubFetch(listing: Record<string, unknown>, status = 200, handler?: Handler) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const custom = handler?.(url);
    if (custom) return custom;
    if (url.startsWith('/api/eks?')) return new Response(JSON.stringify(listing), { status });
    const kind = /kind=(\w+)/.exec(url)?.[1];
    if (url.includes('/incluster?')) return new Response(JSON.stringify({ kind, rows: ROWS[kind ?? ''] ?? [] }));
    if (url.includes('/db-refs')) return new Response(JSON.stringify(OK_REFS));
    if (url.startsWith('/api/topology')) return new Response('{}', { status: 404 });
    if (url.startsWith('/api/inventory/route53')) return new Response(JSON.stringify({ rows: [] }));
    return new Response(JSON.stringify({ rows: [] }));
  }));
  return calls;
}
const HOST_ONLY = { clusters: [{ id: 'shared', name: 'shared', accountId: '111111111111', access: 'connected' }] };
const HOST_AND_MEMBER = { clusters: [
  { id: 'shared', name: 'shared', accountId: '111111111111', access: 'connected' },
  { id: MEMBER_ARN, name: 'shared', accountId: '222222222222', access: 'connected' },
  { id: 'offline', name: 'offline', accountId: '111111111111', access: 'denied' },
] };
const HOST_ARN = 'arn:aws:eks:us-west-2:111111111111:cluster/west';
const ENC_HOST_ARN = encodeURIComponent(HOST_ARN);
const HOST_ARN_ONLY = { clusters: [{ id: HOST_ARN, name: 'west', accountId: '111111111111', access: 'connected' }] };
const ACCOUNTS = { accounts: [{ accountId: '111111111111', alias: 'Host', isHost: true }, { accountId: '222222222222', alias: 'Member', isHost: false }] };
const accountsHandler = (body: unknown, status = 200): Handler => (u) => (u === '/api/accounts' ? new Response(JSON.stringify(body), { status }) : undefined);
const view = () => render(<LanguageProvider><K8sMapView query="" /></LanguageProvider>);
const graphNamespaces = () => canvas.props?.graph.namespaces.map((n) => n.name) ?? [];
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  canvas.props = null;
  canvas.renders = 0;
  trace.override = null;
  dns.override = null;
  window.localStorage.setItem('awsops:scope', JSON.stringify({ accounts: '__all__', regions: '__all__', includeGlobal: true }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe('K8sMapView', () => {
  it('follows the active scope and reads a member cluster by its encoded full ARN', async () => {
    const calls = stubFetch(HOST_AND_MEMBER);
    view();
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['shared', MEMBER_ARN]);
    expect(options[1].textContent).toBe('shared (222222222222 / ap-northeast-2)');
    expect(calls.find((u) => u.startsWith('/api/eks?'))).toContain('accounts=__all__');
    fireEvent.change(screen.getByRole('combobox', { name: '클러스터' }), { target: { value: MEMBER_ARN } });
    await waitFor(() => expect(calls).toContain(`/api/eks/${ENC_MEMBER}/incluster?kind=pods`));
    for (const kind of ['ingresses', 'services', 'endpoints']) expect(calls).toContain(`/api/eks/${ENC_MEMBER}/incluster?kind=${kind}`);
  });

  it('discloses partial or capped listings instead of presenting them as complete', async () => {
    stubFetch({ clusters: [{ id: 'shared', name: 'shared', access: 'connected' }],
      errors: [{ accountId: '222222222222', region: 'us-east-1', message: 'AccessDenied', reason: 'denied' }], truncated: true });
    view();
    expect(await screen.findByText(/222222222222 \/ us-east-1: AccessDenied/)).toBeTruthy();
    expect(screen.getByText(/일부 결과만 표시됩니다/)).toBeTruthy();
  });

  it('keeps the empty-state guidance when the only note is the informational wildcard-scope note', async () => {
    stubFetch({ clusters: [], errors: [{ accountId: 'self', region: '__all__',
      message: 'All-region discovery covers configured and registered regions only.' }] });
    view();
    expect(await screen.findByText(/연결된 EKS 클러스터가 없습니다/)).toBeTruthy();
    expect(screen.getByText(/All-region discovery covers/)).toBeTruthy();
  });

  it('shows the listing failure rather than an empty map when the scope is rejected', async () => {
    stubFetch({ status: 'error', message: 'EKS region is not enabled for this account' }, 403);
    view();
    expect(await screen.findByText(/EKS region is not enabled/)).toBeTruthy();
  });
});

describe('K8sMapView service graph data', () => {
  it('reads db-refs by the encoded ARN, with no collection scope params on single-cluster routes', async () => {
    const calls = stubFetch(HOST_AND_MEMBER);
    view();
    await screen.findAllByRole('option');
    fireEvent.change(screen.getByRole('combobox', { name: '클러스터' }), { target: { value: MEMBER_ARN } });
    await waitFor(() => expect(calls).toContain(`/api/eks/${ENC_MEMBER}/db-refs`));
    const single = calls.filter((u) => u.startsWith('/api/eks/'));
    expect(single.some((u) => /[?&](accounts|regions|includeGlobal)=/.test(u))).toBe(false);
  });

  it('feeds the canvas a graph built from the in-cluster rows and db refs', async () => {
    const refs = { refs: [{ workload: { namespace: 'prod', name: 'api' }, via: 'env', host: 'a.rds.amazonaws.com', kind: 'rds', resource: null }],
      secretRefs: [{ workload: { namespace: 'prod', name: 'api' }, secret: 'db-password' }], truncated: false, partial: false };
    stubFetch(HOST_ONLY, 200, (u) => (u.includes('/db-refs') ? new Response(JSON.stringify(refs)) : undefined));
    view();
    await waitFor(() => expect(canvas.props?.input.secretRefs).toHaveLength(1));
    expect(canvas.props!.input.dbRefs).toHaveLength(1);
    expect(canvas.props!.graph.nodes.filter((n) => n.kind === 'service').map((n) => n.id).sort()).toEqual(['svc:dev/web', 'svc:prod/api']);
  });

  it('still renders the graph and discloses a db-refs failure', async () => {
    stubFetch(HOST_ONLY, 200, (u) => (u.includes('/db-refs') ? new Response(JSON.stringify({ status: 'error', message: 'boom-secret-detail' }), { status: 502 }) : undefined));
    view();
    expect(await screen.findByText('데이터 저장소 참조를 불러오지 못해 설정 기반 연결을 표시하지 않습니다.')).toBeTruthy();
    expect(screen.getByTestId('canvas')).toBeTruthy();
    expect(canvas.props!.input.dbRefs).toEqual([]);
    expect(canvas.props!.input.secretRefs).toEqual([]);
    expect(graphNamespaces()).toEqual(['dev', 'prod']);
    expect(screen.queryByText(/boom-secret-detail/)).toBeNull();
  });

  it('discloses partial and truncated db-refs', async () => {
    stubFetch(HOST_ONLY, 200, (u) => (u.includes('/db-refs') ? new Response(JSON.stringify({ ...OK_REFS, partial: true, truncated: true })) : undefined));
    view();
    expect(await screen.findByText('일부 워크로드의 설정을 읽지 못해 데이터 저장소 연결이 일부만 표시됩니다.')).toBeTruthy();
    expect(screen.getByText('데이터 저장소 참조 조회가 상한에 도달해 일부만 표시됩니다.')).toBeTruthy();
  });

  it('discloses failed in-cluster kinds by kind name without the error body', async () => {
    stubFetch(HOST_ONLY, 200, (u) => (u.includes('kind=endpoints') ? new Response(JSON.stringify({ message: 'raw-detail' }), { status: 502 }) : undefined));
    view();
    expect(await screen.findByText('일부 리소스를 조회하지 못했습니다: endpoints')).toBeTruthy();
    expect(screen.getByTestId('canvas')).toBeTruthy();
    expect(screen.queryByText(/raw-detail/)).toBeNull();
  });

  it('never reads the trace snapshot for a member cluster and shows the member-cluster notice', async () => {
    const calls = stubFetch(HOST_AND_MEMBER);
    view();
    await screen.findAllByRole('option');
    fireEvent.change(screen.getByRole('combobox', { name: '클러스터' }), { target: { value: MEMBER_ARN } });
    expect(await screen.findByText('트레이스로 관측된 호출은 호스트 계정 클러스터에만 표시합니다. 이 클러스터는 ARN으로 식별되어 호스트 계정이 아닌 클러스터로 처리됩니다.')).toBeTruthy();
    expect(calls.filter((u) => u.startsWith('/api/topology'))).toEqual([]);
    expect(canvas.props!.input.trace).toMatchObject({ available: false, reason: 'member_cluster' });
  });

  it('reads the trace snapshot for a uniquely named host cluster and shows the disabled notice on 404', async () => {
    const calls = stubFetch(HOST_ONLY);
    view();
    expect(await screen.findByText('트레이스 토폴로지가 비활성화되어 있어 트레이스로 관측된 호출을 표시하지 않습니다.')).toBeTruthy();
    expect(calls).toContain('/api/topology?lens=service');
  });

  it('refuses the trace join when the host cluster name is shared with another listed cluster', async () => {
    const calls = stubFetch(HOST_AND_MEMBER);
    view();
    expect(await screen.findByText('같은 이름의 클러스터가 여러 개라 트레이스 호출을 이 클러스터에 연결할 수 없습니다.')).toBeTruthy();
    expect(calls.filter((u) => u.startsWith('/api/topology'))).toEqual([]);
  });

  it.each([
    ['a truncated listing', { truncated: true }],
    ['a listing with a per-target read failure', { errors: [{ accountId: '222222222222', region: 'us-east-1', message: 'AccessDenied', reason: 'denied' }] }],
  ])('refuses the trace join without reading the snapshot for %s', async (_label, extra) => {
    const calls = stubFetch({ ...HOST_ONLY, ...extra });
    view();
    expect(await screen.findByText(TRACE_NOTICE.incomplete_listing)).toBeTruthy();
    expect(calls.filter((u) => u.startsWith('/api/topology'))).toEqual([]);
    expect(canvas.props!.input.trace).toMatchObject({ available: false, reason: 'incomplete_listing' });
  });

  it('still reads the trace snapshot when the only listing note is informational (no reason)', async () => {
    const calls = stubFetch({ ...HOST_ONLY, errors: [{ accountId: 'self', region: '__all__', message: 'All-region discovery covers configured and registered regions only.' }] });
    view();
    await waitFor(() => expect(calls).toContain('/api/topology?lens=service'));
    expect(screen.queryByText(TRACE_NOTICE.incomplete_listing)).toBeNull();
  });

  it('reads Route53 records for the cluster account: host as self, member by its account id', async () => {
    const calls = stubFetch(HOST_AND_MEMBER);
    view();
    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/inventory/route53?accounts=self&'))).toBe(true));
    fireEvent.change(screen.getByRole('combobox', { name: '클러스터' }), { target: { value: MEMBER_ARN } });
    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/inventory/route53?accounts=222222222222&'))).toBe(true));
  });

  it('hides system namespaces by default and shows them with the toggle; a namespace can be deselected', async () => {
    stubFetch(HOST_ONLY);
    view();
    await waitFor(() => expect(graphNamespaces()).toEqual(['dev', 'prod']));
    expect(screen.queryByRole('checkbox', { name: 'kube-system' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '시스템 네임스페이스 표시' }));
    await waitFor(() => expect(graphNamespaces()).toEqual(['dev', 'kube-system', 'prod']));
    expect(canvas.props!.graph.namespaces.find((n) => n.name === 'kube-system')?.system).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'dev' }));
    await waitFor(() => expect(graphNamespaces()).toEqual(['kube-system', 'prod']));
    expect(canvas.props!.input.services.some((s) => s.namespace === 'dev')).toBe(false);
  });

  it('loads nodes only after a Service is selected, once', async () => {
    const calls = stubFetch(HOST_ONLY);
    view();
    await waitFor(() => expect(canvas.props).not.toBeNull());
    expect(calls.some((u) => u.includes('kind=nodes'))).toBe(false);
    expect(canvas.props!.input.nodes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'select-service' }));
    await waitFor(() => expect(canvas.props!.input.nodes).toHaveLength(1));
    expect(calls.filter((u) => u === '/api/eks/shared/incluster?kind=nodes')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'select-service' }));
    expect(calls.filter((u) => u.includes('kind=nodes'))).toHaveLength(1);
  });

  it('ignores stale in-cluster responses after a cluster switch and aborts the old requests', async () => {
    const late = deferred<Response>();
    const signals: AbortSignal[] = [];
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.startsWith('/api/eks?')) return new Response(JSON.stringify(HOST_AND_MEMBER));
      if (url === '/api/eks/shared/incluster?kind=services') { if (init?.signal) signals.push(init.signal); return late.promise; }
      const kind = /kind=(\w+)/.exec(url)?.[1];
      if (url.includes('/incluster?')) {
        const rows = kind === 'services' ? [svc('member-ns', 'only-member')] : [];
        return new Response(JSON.stringify({ rows }));
      }
      if (url.includes('/db-refs')) return new Response(JSON.stringify(OK_REFS));
      return new Response('{}', { status: 404 });
    }));
    view();
    await waitFor(() => expect(calls).toContain('/api/eks/shared/incluster?kind=services'));
    fireEvent.change(screen.getByRole('combobox', { name: '클러스터' }), { target: { value: MEMBER_ARN } });
    await waitFor(() => expect(graphNamespaces()).toEqual(['member-ns']));
    expect(signals[0].aborted).toBe(true);
    await act(async () => { late.resolve(new Response(JSON.stringify({ rows: [svc('host-ns', 'stale')] }))); });
    expect(graphNamespaces()).toEqual(['member-ns']);
  });

  it('does not let an aborted trace read of the previous cluster overwrite the new cluster state', async () => {
    const first = deferred<TraceOverlay>();
    const seen: { id: string; signal?: AbortSignal }[] = [];
    trace.override = (c, s) => {
      seen.push({ id: c.id, signal: s });
      if (c.id === 'shared') return first.promise;
      return Promise.resolve({ available: false, reason: 'member_cluster', workloadCalls: [], omitted: 0 });
    };
    stubFetch(HOST_AND_MEMBER);
    view();
    await waitFor(() => expect(seen.map((s) => s.id)).toContain('shared'));
    fireEvent.change(screen.getByRole('combobox', { name: '클러스터' }), { target: { value: MEMBER_ARN } });
    expect(await screen.findByText('트레이스로 관측된 호출은 호스트 계정 클러스터에만 표시합니다. 이 클러스터는 ARN으로 식별되어 호스트 계정이 아닌 클러스터로 처리됩니다.')).toBeTruthy();
    expect(seen[0].signal?.aborted).toBe(true);
    // An aborted read resolves like a failure; it must not replace the member cluster's overlay.
    await act(async () => { first.resolve({ available: false, reason: 'unavailable', workloadCalls: [], omitted: 0 }); });
    expect(screen.queryByText('트레이스 스냅샷을 읽지 못해 트레이스로 관측된 호출을 표시하지 않습니다.')).toBeNull();
    expect(canvas.props!.input.trace).toMatchObject({ reason: 'member_cluster' });
  });

  it('shows a visible, counted notice when the trace snapshot was only partially read', async () => {
    trace.override = () => Promise.resolve({ available: true, workloadCalls: [], omitted: 1234, skipped: 0 });
    stubFetch(HOST_ONLY);
    view();
    const notice = await screen.findByText(traceOmittedNotice(1234));
    expect(notice.closest('[role="status"]')).toBeTruthy();
    expect(notice.textContent).toContain('1234');
  });

  it('shows no partial-snapshot notice when the trace snapshot was read completely', async () => {
    trace.override = () => Promise.resolve({ available: true, workloadCalls: [], omitted: 0, skipped: 2 });
    stubFetch(HOST_ONLY);
    view();
    await waitFor(() => expect(canvas.props?.input.trace).toMatchObject({ available: true }));
    expect(screen.queryByText(/트레이스 스냅샷이 커서/)).toBeNull();
  });

  it('drops a late node read after a cluster switch', async () => {
    const late = deferred<Response>();
    const calls = stubFetch(HOST_AND_MEMBER, 200, (u) => (u === '/api/eks/shared/incluster?kind=nodes' ? late.promise as unknown as Response : undefined));
    view();
    await waitFor(() => expect(canvas.props).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'select-service' }));
    await waitFor(() => expect(calls).toContain('/api/eks/shared/incluster?kind=nodes'));
    fireEvent.change(screen.getByRole('combobox', { name: '클러스터' }), { target: { value: MEMBER_ARN } });
    await waitFor(() => expect(calls).toContain(`/api/eks/${ENC_MEMBER}/incluster?kind=services`));
    await act(async () => { late.resolve(new Response(JSON.stringify({ rows: ROWS.nodes }))); });
    await waitFor(() => expect(canvas.props?.input.services.length).toBeGreaterThan(0));
    expect(canvas.props!.input.nodes).toEqual([]);
  });

  it('shows a visible notice when the Route53 read was capped, and still draws what was read', async () => {
    dns.override = () => Promise.resolve({ records: [{ name: 'app.example.com', target: 'x.elb.amazonaws.com' }], truncated: true, failed: false });
    stubFetch(HOST_ONLY);
    view();
    const notice = await screen.findByText('Route 53 레코드 조회가 상한에 도달해 DNS 연결이 일부만 표시될 수 있습니다.');
    expect(notice.closest('[role="status"]')).toBeTruthy();
    expect(canvas.props!.input.dns).toHaveLength(1);
  });

  it('discloses a failed Route53 read and still renders the graph', async () => {
    stubFetch(HOST_ONLY, 200, (u) => (u.startsWith('/api/inventory/route53') ? new Response('{}', { status: 500 }) : undefined));
    view();
    expect(await screen.findByText('Route 53 레코드를 불러오지 못해 DNS 연결을 표시하지 않습니다.')).toBeTruthy();
    expect(screen.getByTestId('canvas')).toBeTruthy();
    expect(canvas.props!.input.dns).toEqual([]);
  });

  it('shows no Route53 notice for a complete read', async () => {
    const calls = stubFetch(HOST_ONLY);
    view();
    await waitFor(() => expect(canvas.props).not.toBeNull());
    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/inventory/route53'))).toBe(true));
    expect(screen.queryByText(/Route 53 레코드/)).toBeNull();
  });
});

describe('K8sMapView host account scope', () => {
  it('treats an ARN-identified host-account cluster as the host for Route53 and traces', async () => {
    const calls = stubFetch(HOST_ARN_ONLY, 200, accountsHandler(ACCOUNTS));
    view();
    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/inventory/route53?accounts=self&'))).toBe(true));
    expect(calls.some((u) => u.includes('accounts=111111111111'))).toBe(false);
    await waitFor(() => expect(calls).toContain('/api/topology?lens=service'));
    expect(await screen.findByText(TRACE_NOTICE.disabled)).toBeTruthy();
    expect(screen.queryByText(TRACE_NOTICE.member_cluster)).toBeNull();
  });

  it('passes the resolved host account id to the trace overlay only for an ARN id', async () => {
    const seen: { id: string; hostAccountId?: string }[] = [];
    trace.override = (c) => {
      seen.push({ id: c.id, hostAccountId: c.hostAccountId });
      return Promise.resolve({ available: true, workloadCalls: [], omitted: 0, skipped: 0 });
    };
    stubFetch(HOST_ARN_ONLY, 200, accountsHandler(ACCOUNTS));
    view();
    await waitFor(() => expect(seen.some((s) => s.id === HOST_ARN)).toBe(true));
    expect(seen.find((s) => s.id === HOST_ARN)?.hostAccountId).toBe('111111111111');
    cleanup();
    vi.unstubAllGlobals();
    seen.length = 0;
    stubFetch(HOST_ONLY, 200, accountsHandler(ACCOUNTS));
    view();
    await waitFor(() => expect(seen.some((s) => s.id === 'shared')).toBe(true));
    expect(seen.find((s) => s.id === 'shared')?.hostAccountId).toBeUndefined();
  });

  it.each<[string, Handler]>([
    ['a non-OK response', accountsHandler({}, 500)],
    ['two host rows', accountsHandler({ accounts: [{ accountId: '111111111111', isHost: true }, { accountId: '333333333333', isHost: true }] })],
    ['a malformed host id', accountsHandler({ accounts: [{ accountId: 'self', isHost: true }] })],
    ['no accounts array', accountsHandler({ rows: [] })],
    ['a rejected request', (u) => (u === '/api/accounts' ? Promise.reject(new Error('net')) : undefined)],
  ])('keeps the member handling for an ARN cluster when the host account cannot be determined (%s)', async (_label, handler) => {
    const calls = stubFetch(HOST_ARN_ONLY, 200, handler);
    view();
    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/inventory/route53?accounts=111111111111&'))).toBe(true));
    expect(await screen.findByText(TRACE_NOTICE.member_cluster)).toBeTruthy();
    expect(calls.some((u) => u.startsWith('/api/topology'))).toBe(false);
    expect(canvas.props!.input.trace).toMatchObject({ available: false, reason: 'member_cluster' });
  });

  it('keeps a member ARN cluster a member when the host account is known', async () => {
    const calls = stubFetch(HOST_AND_MEMBER, 200, accountsHandler(ACCOUNTS));
    view();
    await screen.findAllByRole('option');
    fireEvent.change(screen.getByRole('combobox', { name: '클러스터' }), { target: { value: MEMBER_ARN } });
    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/inventory/route53?accounts=222222222222&'))).toBe(true));
    expect(await screen.findByText(TRACE_NOTICE.member_cluster)).toBeTruthy();
    expect(calls.some((u) => u.startsWith('/api/topology'))).toBe(false);
  });

  it('waits for the host account lookup before the trace and Route53 reads of an ARN cluster, without repeating the in-cluster reads', async () => {
    const pending = deferred<Response>();
    const calls = stubFetch(HOST_ARN_ONLY, 200, (u) => (u === '/api/accounts' ? pending.promise : undefined));
    view();
    await waitFor(() => expect(calls).toContain(`/api/eks/${ENC_HOST_ARN}/incluster?kind=pods`));
    expect(calls.some((u) => u.startsWith('/api/inventory/route53') || u.startsWith('/api/topology'))).toBe(false);
    await act(async () => { pending.resolve(new Response(JSON.stringify(ACCOUNTS))); });
    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/inventory/route53?accounts=self&'))).toBe(true));
    expect(calls.filter((u) => u === `/api/eks/${ENC_HOST_ARN}/incluster?kind=pods`)).toHaveLength(1);
  });

  it('does not repeat the trace or Route53 read of a bare-name cluster when the host account lookup settles', async () => {
    const pending = deferred<Response>();
    const calls = stubFetch(HOST_ONLY, 200, (u) => (u === '/api/accounts' ? pending.promise : undefined));
    view();
    await waitFor(() => expect(calls.filter((u) => u.startsWith('/api/inventory/route53'))).toHaveLength(1));
    await waitFor(() => expect(calls).toContain('/api/topology?lens=service'));
    await act(async () => { pending.resolve(new Response(JSON.stringify(ACCOUNTS))); });
    expect(calls.filter((u) => u.startsWith('/api/inventory/route53'))).toHaveLength(1);
    expect(calls.filter((u) => u === '/api/topology?lens=service')).toHaveLength(1);
  });

  it('discloses a rejected trace read as unavailable instead of leaving the overlay unset', async () => {
    trace.override = () => Promise.reject(new Error('boom'));
    stubFetch(HOST_ONLY);
    view();
    expect(await screen.findByText(TRACE_NOTICE.unavailable)).toBeTruthy();
    expect(canvas.props!.input.trace).toMatchObject({ available: false, reason: 'unavailable' });
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it('discloses a rejected Route53 read and still renders the graph', async () => {
    dns.override = () => Promise.reject(new Error('boom'));
    stubFetch(HOST_ONLY);
    view();
    expect(await screen.findByText('Route 53 레코드를 불러오지 못해 DNS 연결을 표시하지 않습니다.')).toBeTruthy();
    expect(screen.getByTestId('canvas')).toBeTruthy();
    expect(canvas.props!.input.dns).toEqual([]);
  });
});

describe('K8sMapView trace notices', () => {
  it('has one translated notice per non-available trace-overlay reason', () => {
    expect(Object.keys(TRACE_NOTICE).sort()).toEqual(['ambiguous_cluster', 'disabled', 'incomplete_listing', 'member_cluster', 'unavailable', 'unsupported_scope']);
    for (const ko of Object.values(TRACE_NOTICE)) {
      for (const lang of ['en', 'zh', 'ja'] as const) expect(applyTerms(lang, ko)).not.toBe(ko);
    }
  });

  it('translates the partial-snapshot notice in every locale, keeping the real omitted count', () => {
    for (const n of [1, 37, 12345]) {
      const ko = traceOmittedNotice(n);
      expect(ko).toContain(String(n));
      for (const lang of ['en', 'zh', 'ja'] as const) {
        const out = applyTerms(lang, ko);
        expect(out).not.toBe(ko);
        expect(out).toContain(String(n));
      }
    }
  });
});

describe('K8sMapView partial empty listing', () => {
  it('does not claim no clusters when a partially failed listing returned none connected', async () => {
    stubFetch({ clusters: [], errors: [{ accountId: '222222222222', region: 'us-east-1', message: 'AccessDenied', reason: 'denied' }] });
    view();
    expect(await screen.findByText(/222222222222 \/ us-east-1: AccessDenied/)).toBeTruthy();
    expect(screen.queryByText(/연결된 EKS 클러스터가 없습니다/)).toBeNull();
  });
});

describe('K8sMapView unparseable listing', () => {
  it('reports an OK but non-JSON listing as a failure, not as no clusters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>login</html>', { status: 200 })));
    view();
    expect(await screen.findByText(/조회 실패/)).toBeTruthy();
    expect(screen.queryByText(/연결된 EKS 클러스터가 없습니다/)).toBeNull();
  });
});
