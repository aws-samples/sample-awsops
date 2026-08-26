import { describe, it, expect, vi, beforeEach } from 'vitest';

const listInCluster = vi.fn();
vi.mock('@/lib/eks-incluster', () => ({ listInCluster: (...a: unknown[]) => listInCluster(...a) }));

const dep = (over: Record<string, unknown> = {}) => ({ name: 'opencost', namespace: 'opencost', ready: '1/1', upToDate: 1, available: 1, age: '2d', ...over });

beforeEach(() => listInCluster.mockReset());

describe('pickOpencostDeployment', () => {
  it('finds opencost/opencost, ignores others', async () => {
    const { pickOpencostDeployment } = await import('./opencost-status');
    expect(pickOpencostDeployment([dep(), { name: 'web', namespace: 'opencost', ready: '1/1', upToDate: 1, available: 1, age: '1d' }])?.name).toBe('opencost');
    expect(pickOpencostDeployment([{ name: 'opencost', namespace: 'default', ready: '1/1', upToDate: 1, available: 1, age: '1d' }])).toBeNull();
    expect(pickOpencostDeployment([])).toBeNull();
  });
});

describe('detectOpencostInstall', () => {
  it('installed + ready when the opencost deployment is healthy', async () => {
    listInCluster.mockResolvedValue([dep({ ready: '1/1', available: 1 })]);
    const { detectOpencostInstall } = await import('./opencost-status');
    expect(await detectOpencostInstall('c')).toMatchObject({ installed: true, ready: true });
  });
  it('installed but not ready when replicas are short', async () => {
    listInCluster.mockResolvedValue([dep({ ready: '0/1', available: 0 })]);
    const { detectOpencostInstall } = await import('./opencost-status');
    expect(await detectOpencostInstall('c')).toMatchObject({ installed: true, ready: false });
  });
  it('not installed when absent', async () => {
    listInCluster.mockResolvedValue([{ name: 'other', namespace: 'kube-system', ready: '1/1', upToDate: 1, available: 1, age: '1d' }]);
    const { detectOpencostInstall } = await import('./opencost-status');
    expect(await detectOpencostInstall('c')).toMatchObject({ installed: false, deployment: null });
  });
  it('degrades (not throws) on in-cluster 403 / error', async () => {
    listInCluster.mockImplementationOnce(async () => { throw new Error('HTTP 403'); });
    const { detectOpencostInstall } = await import('./opencost-status');
    const r = await detectOpencostInstall('c');
    expect(r.installed).toBe(false);
    expect(r.reason).toContain('403');
  });
});
