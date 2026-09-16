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
  it.each(['error', 'string', 'object'])('sanitizes a swallowed upstream %s when the estimate is unavailable', async kind => {
    const sentinel = 'arn:aws:iam::222222222222:role/private-role ExternalId=private-external SessionToken=private-session';
    proxy.mockRejectedValue(kind === 'error' ? Object.assign(new Error(sentinel), { stack: sentinel, $metadata: { requestId: sentinel } })
      : kind === 'string' ? sentinel : { message: sentinel, toString: () => sentinel });
    list.mockRejectedValue(new Error(sentinel));
    const { getAllocation } = await import('./opencost-allocation');
    const result = await getAllocation(ARN);
    expect(result).toMatchObject({
      available: false, message: 'OpenCost allocation is unavailable.', pods: [], namespaces: [],
      hasNetwork: false, hasPv: false, hasGpu: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-role|private-external|private-session/);
  });

  it('preserves the safe typed scope message without changing fallback shape', async () => {
    const { EksScopeError } = await import('./eks-context');
    proxy.mockRejectedValue(new EksScopeError('EKS account is disabled', 403));
    const { getAllocation } = await import('./opencost-allocation');
    expect(await getAllocation(ARN)).toMatchObject({ available: false, message: 'EKS account is disabled', pods: [] });
  });

  it('preserves a successful request estimate after an upstream failure', async () => {
    proxy.mockRejectedValue(new Error('private ExternalId and SessionToken'));
    list.mockResolvedValue([{ namespace: 'default', name: 'app', node: 'node', status: 'Running', cpuRequest: 1, memRequest: 1024 }]);
    const { getAllocation } = await import('./opencost-allocation');
    const result = await getAllocation(ARN);
    expect(result).toMatchObject({ available: true, source: 'request-estimate', kpi: { podCount: 1 } });
    expect(result.message).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private');
  });

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
