// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import FleetKindPage from './FleetKindPage';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const NODE = {
  name: 'ip-10-0-1-1', status: 'Ready', roles: 'worker', version: 'v1.31', instanceType: 'm6g.large',
  zone: 'apne2-az1', age: '3d', cpuCapacity: 4, cpuAllocatable: 3.5, memCapacity: 8192, memAllocatable: 7168,
};
const POD = (over: Record<string, unknown> = {}) => ({
  name: 'p', namespace: 'default', status: 'Running', node: 'ip-10-0-1-1', restarts: 0, age: '1d',
  cpuRequest: 1, memRequest: 1024, ...over,
});

// Fetch stub: /api/eks list → two connected clusters; per-cluster incluster fetches are
// scripted per cluster+kind so one cluster's pods can fail while the other succeeds.
function setFetch(pods: Record<string, unknown[] | null>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u === '/api/eks?account=self') {
      return { ok: true, status: 200, json: async () => ({ clusters: Object.keys(pods).map((name) => ({ name, access: 'connected' })) }) };
    }
    const m = u.match(/\/api\/eks\/([^/]+)\/incluster\?kind=(\w+)/);
    if (m) {
      const [, cluster, kind] = m;
      if (kind === 'nodes') return { ok: true, status: 200, json: async () => ({ rows: [{ ...NODE, name: `${cluster}-n1` }] }) };
      if (kind === 'pods') {
        const rows = pods[cluster];
        if (rows === null) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ rows }) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}

describe('FleetKindPage nodes capacity list (gap L132)', () => {
  it('mounts the capacity list and excludes terminal pods from Requested (scheduler parity)', async () => {
    setFetch({ 'prod-a': [
      POD({ node: 'prod-a-n1', cpuRequest: 1, memRequest: 1024 }),
      POD({ node: 'prod-a-n1', status: 'Succeeded', cpuRequest: 99, memRequest: 99999 }), // must NOT count
      POD({ node: 'prod-a-n1', status: 'Failed', cpuRequest: 99, memRequest: 99999 }),    // must NOT count
    ] });
    render(<FleetKindPage kind="nodes" />);
    await waitFor(() => expect(screen.getByText('노드 용량 (Requested / Available / Reserved)')).toBeTruthy());
    // Requested = 1 vCPU only → avail = 3.5 - 1 = 2.5; rsv = 4 - 3.5 = 0.5
    await waitFor(() => expect(screen.getByText('avail 2.5 vCPU | rsv 0.5 vCPU')).toBeTruthy());
  });

  it("a cluster whose pods fetch fails degrades only ITS rows to '요청량 미상'", async () => {
    setFetch({ 'prod-a': [POD({ node: 'prod-a-n1' })], 'dev-b': null });
    render(<FleetKindPage kind="nodes" />);
    await waitFor(() => expect(screen.getByText('avail 2.5 vCPU | rsv 0.5 vCPU')).toBeTruthy());
    expect(screen.getAllByText(/요청량 미상/).length).toBe(2); // dev-b-n1's CPU + Mem captions only
  });
});
