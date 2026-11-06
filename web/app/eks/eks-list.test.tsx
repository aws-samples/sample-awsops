// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import EksPage from './page';

afterEach(cleanup);

const guide = { commands: ['aws eks create-access-entry --cluster-name cold', 'aws eks associate-access-policy --cluster-name cold'], note: 'make configure 안내' };
const clusters = [
  { name: 'conn', status: 'ACTIVE', version: '1.30', region: 'ap-northeast-2', vpcId: 'vpc-1', platformVersion: 'eks.5', access: 'connected', runtime: false },
  { name: 'ready', status: 'ACTIVE', version: '1.30', region: 'ap-northeast-2', vpcId: 'vpc-2', platformVersion: 'eks.5', access: 'entry-only', runtime: false, guide },
  { name: 'cold', status: 'ACTIVE', version: '1.29', region: 'ap-northeast-2', vpcId: 'vpc-3', platformVersion: 'eks.4', access: 'no-entry', runtime: false, guide },
];

// /api/eks/fleet — live aggregates for the allowed clusters (here, only 'conn' is reachable).
const fleetCluster = {
  name: 'conn',
  reachable: true,
  counts: { nodes: 2, nodesReady: 2, pods: 10, podsRunning: 9, deployments: 3, services: 4 },
  nodeAgg: [{ name: 'n1', cpuAllocatable: 3.9, cpuRequest: 1.2, cpuPct: 31, memAllocatable: 15000, memRequest: 4000, memPct: 27, podCount: 5 }],
  podStatus: { Running: 9, Pending: 1 },
  podsByNamespace: [{ namespace: 'default', count: 6 }, { namespace: 'kube-system', count: 4 }],
  events: [{ kind: 'Pod', object: 'default/p1', reason: 'BackOff', message: 'restarting', count: 3, lastSeen: '5m', lastSeenTs: 1000 }],
};
const FLEET = { 'GET /api/eks/fleet?regions=__all__&includeGlobal=1': () => ({ status: 200, body: { clusters: [fleetCluster] } }) };

function mockFetch(handlers: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const h = handlers[key];
    if (!h) throw new Error(`unmocked: ${key}`);
    const { status, body } = h(init);
    return { ok: status < 400, status, json: async () => body } as Response;
  }));
}

beforeEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

describe('EKS list page (ADR buildout)', () => {
  it('renders a connected cluster as a link, others as plain text', async () => {
    mockFetch({ ...FLEET, 'GET /api/eks?regions=__all__&includeGlobal=1': () => ({ status: 200, body: { clusters, admin: false } }) });
    render(<EksPage />);
    // 'conn' now appears in several places (card name, node-resource subheading,
    // events Cluster column) — assert the card NAME specifically is a link.
    await waitFor(() => expect(screen.getByRole('link', { name: 'conn' })).toBeTruthy());
    expect(screen.getByRole('link', { name: 'conn' }).getAttribute('href')).toBe('/eks/conn');
    expect(screen.queryByRole('link', { name: 'ready' })).toBeNull();
    expect(screen.getByText('ready').closest('a')).toBeNull();
    // non-admin: no register buttons
    expect(screen.queryByText('조회 등록')).toBeNull();
  });

  it('admin sees the register button and a successful POST refreshes the list and the fleet', async () => {
    let registered = false;
    let fleetCalls = 0;
    mockFetch({
      'GET /api/eks/fleet?regions=__all__&includeGlobal=1': () => { fleetCalls += 1; return { status: 200, body: { clusters: [fleetCluster] } }; },
      'GET /api/eks?regions=__all__&includeGlobal=1': () => ({
        status: 200,
        body: { clusters: registered ? clusters.map((c) => (c.name === 'ready' ? { ...c, access: 'connected', runtime: true } : c)) : clusters, admin: true },
      }),
      'POST /api/eks/ready/register': () => { registered = true; return { status: 200, body: { registered: true } }; },
    });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    await waitFor(() => expect(fleetCalls).toBeGreaterThanOrEqual(1));
    const before = fleetCalls;
    fireEvent.click(screen.getByText('조회 등록'));
    await waitFor(() => expect(screen.getByText(/등록 완료/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('ready').closest('a')).toBeTruthy());
    // newly connected clusters must show live counts immediately → fleet re-fetched
    await waitFor(() => expect(fleetCalls).toBeGreaterThan(before));
    expect(fleetCalls).toBeGreaterThanOrEqual(2);
  });

  it('the onboarding script is always reachable (v1 parity) — no POST needed', async () => {
    mockFetch({ ...FLEET, 'GET /api/eks?regions=__all__&includeGlobal=1': () => ({ status: 200, body: { clusters, admin: false } }) });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('cold')).toBeTruthy());
    fireEvent.click(screen.getAllByText('스크립트')[1]); // cold's script button (ready has one too)
    await waitFor(() => expect(screen.getByText(/cold 온보딩 가이드/)).toBeTruthy());
    expect(screen.getByText(/create-access-entry/)).toBeTruthy();
    expect(screen.getByText(/make configure/)).toBeTruthy();
  });

  it('renders the fleet summary stats row', async () => {
    mockFetch({ ...FLEET, 'GET /api/eks?regions=__all__&includeGlobal=1': () => ({ status: 200, body: { clusters, admin: false } }) });
    render(<EksPage />);
    // The label is present before the asynchronous fleet response arrives.
    await waitFor(() => {
      const podsCard = screen.getByText('Pods').closest('div')!.parentElement!;
      expect(podsCard.textContent).toContain('10');
      expect(podsCard.textContent).toContain('9 running');
    });
  });

  it('renders cluster cards with meta and live mini-counts', async () => {
    mockFetch({ ...FLEET, 'GET /api/eks?regions=__all__&includeGlobal=1': () => ({ status: 200, body: { clusters, admin: false } }) });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'conn' })).toBeTruthy());
    // meta grid surfaces the VPC id
    expect(screen.getByText('vpc-1')).toBeTruthy();
    // reachable fleet entry → mini-counts line
    await waitFor(() => expect(screen.getByText(/2 nodes/)).toBeTruthy());
  });

  it('renders the node resource section and warning events for the reachable fleet', async () => {
    mockFetch({ ...FLEET, 'GET /api/eks?regions=__all__&includeGlobal=1': () => ({ status: 200, body: { clusters, admin: false } }) });
    render(<EksPage />);
    // node resource bars
    await waitFor(() => expect(screen.getByText('n1')).toBeTruthy());
    // warning events table — DataTable renders both desktop table + mobile card
    // list, so the cell value appears twice in jsdom → assert via getAllByText.
    await waitFor(() => expect(screen.getAllByText('BackOff').length).toBeGreaterThan(0));
  });

  it('renders EC2/node-group fleet nodes as EC2 running with Ready unknown, never 0 ready', async () => {
    const ec2Fleet = { ...fleetCluster, nodesSource: 'aws-api', counts: { ...fleetCluster.counts, nodesReady: null, ec2Running: 2 } };
    mockFetch({
      'GET /api/eks/fleet?regions=__all__&includeGlobal=1': () => ({ status: 200, body: { clusters: [ec2Fleet] } }),
      'GET /api/eks?regions=__all__&includeGlobal=1': () => ({ status: 200, body: { clusters, admin: false } }),
    });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('EC2 running 2 · Ready unknown')).toBeTruthy());
    expect(screen.queryByText(/0 ready/)).toBeNull();
  });
});

describe('EKS member auto-registration (admin page, ordinary POST path)', () => {
  const MEMBER = 'arn:aws:eks:us-east-1:222222222222:cluster/member';
  const memberRow = { id: MEMBER, name: 'member', accountId: '222222222222', region: 'us-east-1', status: 'ACTIVE', access: 'entry-only', runtime: false, guide, accessEntryVerified: true };
  const LIST = 'GET /api/eks?regions=__all__&includeGlobal=1';
  const POST_MEMBER = `POST /api/eks/${encodeURIComponent(MEMBER)}/register`;
  const DELETE_MEMBER = `DELETE /api/eks/${encodeURIComponent(MEMBER)}/register`;

  function setup(opts: { admin?: boolean } = {}) {
    const state = { registered: false, posts: [] as unknown[], listCalls: 0 };
    mockFetch({
      ...FLEET,
      [LIST]: () => {
        state.listCalls += 1;
        return { status: 200, body: { admin: opts.admin ?? true, clusters: [
          state.registered ? { ...memberRow, access: 'connected', runtime: true, accessEntryVerified: undefined, guide: undefined } : memberRow,
        ] } };
      },
      [POST_MEMBER]: (init) => { state.posts.push(init?.body ? JSON.parse(String(init.body)) : null); state.registered = true; return { status: 200, body: { registered: true } }; },
      [DELETE_MEMBER]: () => { state.registered = false; return { status: 200, body: { unregistered: true } }; },
    });
    return state;
  }

  it('POSTs {auto:true} once for a verified member entry and reloads the list', async () => {
    const state = setup();
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText(/자동 조회 등록됨/)).toBeTruthy());
    expect(state.posts).toEqual([{ auto: true }]);
    await waitFor(() => expect(state.listCalls).toBeGreaterThanOrEqual(2));
  });

  it('never auto-POSTs for a non-admin view', async () => {
    const state = setup({ admin: false });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('member')).toBeTruthy());
    expect(state.posts).toEqual([]);
  });

  it('DELETE suppresses auto-registration in this browser until a manual [조회 등록] clears it', async () => {
    const state = setup();
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('해제')).toBeTruthy());
    fireEvent.click(screen.getByText('해제'));
    await waitFor(() => expect(screen.getByText(/등록 해제됨/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('조회 등록')).toBeTruthy());
    expect(JSON.parse(window.localStorage.getItem('awsops.eks.autoRegisterSuppressed.v1') ?? '[]')).toEqual([MEMBER]);
    cleanup();
    // A fresh page load must not re-register the unregistered cluster.
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('조회 등록')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(state.posts).toEqual([{ auto: true }]);
    fireEvent.click(screen.getByText('조회 등록'));
    await waitFor(() => expect(screen.getByText(/등록 완료/)).toBeTruthy());
    expect(state.posts).toEqual([{ auto: true }, null]);
    expect(JSON.parse(window.localStorage.getItem('awsops.eks.autoRegisterSuppressed.v1') ?? '[]')).toEqual([]);
  });
});
