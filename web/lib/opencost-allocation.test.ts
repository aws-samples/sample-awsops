import { beforeEach, describe, expect, it, vi } from 'vitest';
const { proxy, list } = vi.hoisted(() => ({ proxy: vi.fn(), list: vi.fn() }));
vi.mock('./eks-incluster', () => ({ k8sGetPath: proxy, listInCluster: list }));
const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';

beforeEach(() => {
  vi.clearAllMocks();
  proxy.mockReset().mockResolvedValue(JSON.stringify({ data: [{}] }));
  list.mockReset().mockResolvedValue([]);
});

describe('OpenCost Kubernetes proxy scope', () => {
  it('keeps the qualified ID on both pod and node allocation calls', async () => {
    const { getAllocation } = await import('./opencost-allocation');
    expect((await getAllocation(ARN)).available).toBe(true);
    expect(proxy).toHaveBeenCalledTimes(2);
    for (const [cluster, path] of proxy.mock.calls) {
      expect(cluster).toBe(ARN);
      expect(path).toMatch(/^\/api\/v1\/namespaces\/opencost\/services\/opencost:9003\/proxy\//);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps a failed member proxy estimate scoped to member pods', async () => {
    proxy.mockRejectedValue(new Error('member OpenCost unavailable'));
    const { getAllocation } = await import('./opencost-allocation');
    expect((await getAllocation(ARN)).available).toBe(false);
    expect(list).toHaveBeenCalledWith(ARN, 'pods');
    expect(proxy.mock.calls.every(([cluster]) => cluster === ARN)).toBe(true);
  });
});
