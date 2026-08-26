import { describe, it, expect } from 'vitest';
import { podStatusCounts, podsByNamespace, deploymentHealth, serviceTypeCounts } from './eks-tab-stats';

const pods = [
  { namespace: 'a', status: 'Running' }, { namespace: 'a', status: 'Running' },
  { namespace: 'b', status: 'Pending' }, { namespace: 'b', status: 'Failed' },
];
describe('eks-tab-stats', () => {
  it('podStatusCounts counts by status', () => {
    expect(podStatusCounts(pods)).toEqual({ Running: 2, Pending: 1, Failed: 1 });
  });
  it('podsByNamespace sorts desc then by name', () => {
    expect(podsByNamespace(pods)).toEqual([{ namespace: 'a', count: 2 }, { namespace: 'b', count: 2 }]);
  });
  it('deploymentHealth parses ready a/b, degraded first', () => {
    const out = deploymentHealth([
      { name: 'ok', namespace: 'x', ready: '3/3', available: 3 },
      { name: 'bad', namespace: 'x', ready: '1/3', available: 1 },
    ]);
    expect(out[0]).toEqual({ name: 'bad', namespace: 'x', desired: 3, available: 1, pct: 33 });
    expect(out[1].pct).toBe(100);
  });
  it('deploymentHealth treats desired 0 as 100%', () => {
    expect(deploymentHealth([{ name: 'z', namespace: 'x', ready: '0/0', available: 0 }])[0].pct).toBe(100);
  });
  it('deploymentHealth falls back to the ready numerator when available is absent', () => {
    expect(deploymentHealth([{ name: 'y', namespace: 'x', ready: '2/3' }])[0]).toEqual(
      { name: 'y', namespace: 'x', desired: 3, available: 2, pct: 67 });
  });
  it('serviceTypeCounts counts by type', () => {
    expect(serviceTypeCounts([{ type: 'ClusterIP' }, { type: 'ClusterIP' }, { type: 'LoadBalancer' }]))
      .toEqual({ ClusterIP: 2, LoadBalancer: 1 });
  });
});
