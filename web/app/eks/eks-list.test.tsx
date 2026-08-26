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
const FLEET = { 'GET /api/eks/fleet': () => ({ status: 200, body: { clusters: [fleetCluster] } }) };

function mockFetch(handlers: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const h = handlers[key];
    if (!h) throw new Error(`unmocked: ${key}`);
    const { status, body } = h(init);
    return { ok: status < 400, status, json: async () => body } as Response;
  }));
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe('EKS list page (ADR buildout)', () => {
  it('renders a connected cluster as a link, others as plain text', async () => {
    mockFetch({ ...FLEET, 'GET /api/eks?account=self': () => ({ status: 200, body: { clusters, admin: false } }) });
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
      'GET /api/eks/fleet': () => { fleetCalls += 1; return { status: 200, body: { clusters: [fleetCluster] } }; },
      'GET /api/eks?account=self': () => ({
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
    mockFetch({ ...FLEET, 'GET /api/eks?account=self': () => ({ status: 200, body: { clusters, admin: false } }) });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('cold')).toBeTruthy());
    fireEvent.click(screen.getAllByText('스크립트')[1]); // cold's script button (ready has one too)
    await waitFor(() => expect(screen.getByText(/cold 온보딩 가이드/)).toBeTruthy());
    expect(screen.getByText(/create-access-entry/)).toBeTruthy();
    expect(screen.getByText(/make configure/)).toBeTruthy();
  });

  it('renders the fleet summary stats row', async () => {
    mockFetch({ ...FLEET, 'GET /api/eks?account=self': () => ({ status: 200, body: { clusters, admin: false } }) });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByText('Pods')).toBeTruthy());
    // Pods value (10) lives in the StatCard adjacent to the 'Pods' eyebrow.
    const podsCard = screen.getByText('Pods').closest('div')!.parentElement!;
    expect(podsCard.textContent).toContain('10');
    expect(podsCard.textContent).toContain('9 running');
  });

  it('renders cluster cards with meta and live mini-counts', async () => {
    mockFetch({ ...FLEET, 'GET /api/eks?account=self': () => ({ status: 200, body: { clusters, admin: false } }) });
    render(<EksPage />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'conn' })).toBeTruthy());
    // meta grid surfaces the VPC id
    expect(screen.getByText('vpc-1')).toBeTruthy();
    // reachable fleet entry → mini-counts line
    await waitFor(() => expect(screen.getByText(/2 nodes/)).toBeTruthy());
  });

  it('renders the node resource section and warning events for the reachable fleet', async () => {
    mockFetch({ ...FLEET, 'GET /api/eks?account=self': () => ({ status: 200, body: { clusters, admin: false } }) });
    render(<EksPage />);
    // node resource bars
    await waitFor(() => expect(screen.getByText('n1')).toBeTruthy());
    // warning events table — DataTable renders both desktop table + mobile card
    // list, so the cell value appears twice in jsdom → assert via getAllByText.
    await waitFor(() => expect(screen.getAllByText('BackOff').length).toBeGreaterThan(0));
  });
});
