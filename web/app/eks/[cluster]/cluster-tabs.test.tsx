// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import EksClusterPage from './page';

vi.mock('next/navigation', () => ({ useParams: () => ({ cluster: 'c1' }) }));
afterEach(cleanup);
beforeEach(() => { vi.unstubAllGlobals(); });

function mockKind(handlers: Record<string, unknown[]>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    // The OpenCost panel (mounted on this page) fetches /api/me + /api/opencost/* — answer
    // them deterministically so the panel mounts without disturbing the per-tab assertions.
    if (u.endsWith('/api/me')) return { ok: true, status: 200, json: async () => ({ sub: 'u', groups: [], isAdmin: false }) } as Response;
    if (u.includes('/api/opencost/')) {
      if (u.includes('/status')) return { ok: true, status: 200, json: async () => ({ installed: false, ready: false }) } as Response;
      if (u.includes('/bundle')) return { ok: true, status: 200, json: async () => ({ valuesYaml: '', installSh: '' }) } as Response;
      return { ok: true, status: 200, json: async () => ({ cluster: 'c1', config: null }) } as Response;
    }
    const kind = new URL(u, 'http://x').searchParams.get('kind') ?? '';
    const rows = handlers[kind] ?? [];
    return { ok: true, status: 200, json: async () => ({ kind, rows }) } as Response;
  }));
}

describe('EKS [cluster] per-tab KPI/viz', () => {
  it('mounts the per-cluster OpenCost panel', async () => {
    mockKind({ nodes: [] });
    render(<EksClusterPage />);
    await waitFor(() => expect(screen.getByText('OpenCost')).toBeTruthy());
  });

  it('pods tab: KPI counts stay pre-filter while the table filters', async () => {
    mockKind({
      pods: [
        { name: 'p1', namespace: 'a', status: 'Running' },
        { name: 'p2', namespace: 'b', status: 'Pending' },
      ],
    });
    render(<EksClusterPage />);

    fireEvent.click(screen.getByText('Pods'));
    // DataTable renders both the desktop table and the mobile card list, so each
    // cell value appears twice in jsdom → assert via getAllByText.
    await waitFor(() => expect(screen.getAllByText('p1').length).toBeGreaterThan(0));
    // both pods present initially
    expect(screen.getAllByText('p2').length).toBeGreaterThan(0);

    // The Pending KPI tile (StatCard eyebrow) shows 1 (pre-filter). 'Pending'
    // also appears as p2's status cell, so scope to the uppercase eyebrow tile.
    const pendingTileOf = (): Element => {
      const eyebrow = screen
        .getAllByText('Pending')
        .find((el) => el.className.includes('uppercase'))!;
      return eyebrow.closest('.shadow-card')!;
    };
    expect(pendingTileOf().textContent).toContain('1');

    // Filter the table down to p1 only.
    fireEvent.change(screen.getByPlaceholderText('검색…'), { target: { value: 'p1' } });
    await waitFor(() => expect(screen.queryByText('p2')).toBeNull());
    // table now shows only p1
    expect(screen.getAllByText('p1').length).toBeGreaterThan(0);

    // KPI is computed from allRows (pre-filter) → Pending tile still 1, even
    // though p2 (the only Pending pod) is filtered out of the table.
    expect(pendingTileOf().textContent).toContain('1');
  });

  it('events tab renders warning rows sorted by lastSeenTs desc', async () => {
    mockKind({
      events: [
        { kind: 'Pod', object: 'a/x', reason: 'Old', message: 'old msg', count: 1, lastSeen: '1h', lastSeenTs: 1 },
        { kind: 'Pod', object: 'a/y', reason: 'New', message: 'new msg', count: 1, lastSeen: '1m', lastSeenTs: 9 },
      ],
    });
    const { container } = render(<EksClusterPage />);

    fireEvent.click(screen.getByText('Events'));
    await waitFor(() => expect(screen.getAllByText('New').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Old').length).toBeGreaterThan(0);

    // newest (lastSeenTs 9) must appear before oldest (1), despite server order.
    const text = container.textContent ?? '';
    expect(text.indexOf('New')).toBeLessThan(text.indexOf('Old'));
  });

  it('nodes tab opens a node drilldown with only pods scheduled on that node', async () => {
    mockKind({
      nodes: [
        {
          name: 'ip-10-0-1-5',
          status: 'Ready',
          roles: 'worker',
          version: 'v1.30.0',
          instanceType: 'm6g.large',
          zone: 'ap-northeast-2a',
          age: '3d',
          cpuAllocatable: 4,
          memAllocatable: 8192,
          diskAllocatable: 20000,
        },
        {
          name: 'ip-10-0-2-9',
          status: 'Ready',
          roles: 'worker',
          version: 'v1.30.0',
          instanceType: 'm6g.large',
          zone: 'ap-northeast-2c',
          age: '3d',
          cpuAllocatable: 4,
          memAllocatable: 8192,
          diskAllocatable: 20000,
        },
      ],
      pods: [
        {
          name: 'api-abc',
          namespace: 'default',
          status: 'Running',
          node: 'ip-10-0-1-5',
          restarts: 2,
          workload: 'api',
          cpuRequest: 0.5,
          memRequest: 256,
          age: '1h',
        },
        {
          name: 'worker-xyz',
          namespace: 'jobs',
          status: 'Running',
          node: 'ip-10-0-2-9',
          restarts: 0,
          workload: 'worker',
          cpuRequest: 1,
          memRequest: 512,
          age: '2h',
        },
      ],
    });
    render(<EksClusterPage />);

    await waitFor(() => expect(screen.getAllByText('ip-10-0-1-5').length).toBeGreaterThan(0));
    const tableCell = screen.getAllByText('ip-10-0-1-5').find((el) => el.closest('tr'));
    expect(tableCell).toBeTruthy();
    fireEvent.click(tableCell!.closest('tr')!);

    const dialog = await screen.findByRole('dialog', { name: 'ip-10-0-1-5' });
    expect(within(dialog).getByText('Pods on this node')).toBeTruthy();
    expect(dialog.textContent).toContain('api-abc');
    expect(dialog.textContent).toContain('default');
    expect(dialog.textContent).toContain('api');
    expect(dialog.textContent).toContain('0.5');
    expect(dialog.textContent).toContain('256');
    expect(dialog.textContent).not.toContain('worker-xyz');
  });

  it('deployments tab shows degraded-first replica bars', async () => {
    mockKind({
      deployments: [
        { name: 'ok', namespace: 'a', ready: '3/3', available: 3 },
        { name: 'bad', namespace: 'a', ready: '1/3', available: 1 },
      ],
    });
    render(<EksClusterPage />);

    fireEvent.click(screen.getByText('Deployments'));
    await waitFor(() => expect(screen.getAllByText('ok').length).toBeGreaterThan(0));

    // Degraded KPI present (bad is 1/3 → 1 degraded).
    expect(screen.getByText('Degraded')).toBeTruthy();
    // Replica availability list surfaces the degraded ratio. '1/3' also appears
    // in the table's Ready column, so scope to the availability Card root.
    const replicaCard = screen.getByText('레플리카 가용성').closest('.shadow-card')!;
    expect(replicaCard.textContent).toContain('1/3');
  });
});
