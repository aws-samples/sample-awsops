import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const getAllowedClusters = vi.fn();
const listInCluster = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/eks-registry', () => ({ getAllowedClusters: (...a: unknown[]) => getAllowedClusters(...a) }));
vi.mock('@/lib/eks-incluster', () => ({ listInCluster: (...a: unknown[]) => listInCluster(...a) }));
import { GET } from './route';

const req = () => new Request('http://x/api/eks/fleet', { headers: { cookie: 'awsops_token=t' } });
const NODE = { name: 'n1', status: 'Ready', roles: 'worker', version: 'v1.30', instanceType: 'm5.large', zone: 'a', age: '1d', cpuCapacity: 4, cpuAllocatable: 3.9, memCapacity: 16000, memAllocatable: 15000 };
const POD = { name: 'p1', namespace: 'default', status: 'Running', node: 'n1', restarts: 0, age: '1h', cpuRequest: 0.5, memRequest: 512 };
const EVENT = { kind: 'Pod', object: 'default/p1', reason: 'BackOff', message: 'm', count: 3, lastSeen: '5m', lastSeenTs: 1000 };

beforeEach(() => {
  verifyUser.mockReset(); getAllowedClusters.mockReset(); listInCluster.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
  getAllowedClusters.mockResolvedValue(new Set(['c1']));
});

describe('GET /api/eks/fleet', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });
  it('aggregates per cluster server-side (no raw pods in payload)', async () => {
    listInCluster.mockImplementation(async (_c: string, kind: string) => (
      { nodes: [NODE], pods: [POD], deployments: [{ name: 'd', namespace: 'x', ready: '1/1', available: 1 }], services: [{ type: 'ClusterIP' }], events: [EVENT] } as Record<string, unknown[]>
    )[kind] ?? []);
    const body = await (await GET(req())).json();
    const c = body.clusters[0];
    expect(c.name).toBe('c1');
    expect(c.reachable).toBe(true);
    expect(c.counts).toEqual({ nodes: 1, nodesReady: 1, pods: 1, podsRunning: 1, deployments: 1, services: 1 });
    expect(c.nodeAgg[0].name).toBe('n1');
    expect(c.nodeAgg[0].instanceType).toBe('m5.large');
    expect(c.instanceTypes).toEqual([{ type: 'm5.large', count: 1 }]);
    expect(c.podStatus).toEqual({ Running: 1 });
    expect(c.podsByNamespace).toEqual([{ namespace: 'default', count: 1 }]);
    expect(c.events[0].reason).toBe('BackOff');
    expect(JSON.stringify(body)).not.toContain('"restarts"'); // raw pod rows must not ship
    expect(c).not.toHaveProperty('pods');      // schema check — aggregates only (P4: codex)
    expect(c).not.toHaveProperty('nodes');
    expect(c).not.toHaveProperty('serviceTypes'); // deliberately excluded from the payload
  });
  it('degrades a failing cluster to reachable:false (never 500)', async () => {
    getAllowedClusters.mockResolvedValue(new Set(['ok', 'down']));
    listInCluster.mockImplementation(async (c: string, kind: string) => {
      if (c === 'down') throw new Error('403');
      return ({ nodes: [NODE], pods: [POD], deployments: [], services: [], events: [] } as Record<string, unknown[]>)[kind] ?? [];
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    const down = body.clusters.find((c: { name: string }) => c.name === 'down');
    expect(down.reachable).toBe(false);
    expect(down.counts.nodes).toBe(0);
  });
  it('an events-only failure keeps the cluster reachable with empty events', async () => {
    listInCluster.mockImplementation(async (_c: string, kind: string) => {
      if (kind === 'events') throw new Error('403');
      return ({ nodes: [NODE], pods: [POD], deployments: [], services: [] } as Record<string, unknown[]>)[kind] ?? [];
    });
    const body = await (await GET(req())).json();
    expect(body.clusters[0].reachable).toBe(true);
    expect(body.clusters[0].events).toEqual([]);
  });
  it('caps events at 25 sorted by lastSeenTs desc', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...EVENT, object: `o${i}`, lastSeenTs: i }));
    listInCluster.mockImplementation(async (_c: string, kind: string) => (
      { nodes: [], pods: [], deployments: [], services: [], events: many } as Record<string, unknown[]>
    )[kind] ?? []);
    const body = await (await GET(req())).json();
    expect(body.clusters[0].events).toHaveLength(25);
    expect(body.clusters[0].events[0].lastSeenTs).toBe(29);
  });
  it('registry failure degrades to an empty fleet, not 500', async () => {
    getAllowedClusters.mockRejectedValue(new Error('aurora down'));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).clusters).toEqual([]);
  });
});
