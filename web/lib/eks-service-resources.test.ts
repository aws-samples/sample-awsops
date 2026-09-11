import { describe, it, expect } from 'vitest';
import { selectorMatches, serviceResources, topServiceResources } from './eks-service-resources';
import type { ServiceRow } from './eks-incluster';
import type { PodRow } from './eks-resources';

const svc = (o: Partial<ServiceRow & { cluster: string }>): ServiceRow & { cluster: string } => ({
  name: 's', namespace: 'ns', type: 'ClusterIP', clusterIP: '10.0.0.1', ports: '80', age: '1d',
  cluster: 'c1', ...o,
});
const pod = (o: Partial<PodRow & { cluster: string }>): PodRow & { cluster: string } => ({
  name: 'p', namespace: 'ns', status: 'Running', node: 'n', restarts: 0, age: '1d',
  cpuRequest: 0.25, memRequest: 128, diskRequest: 0, cluster: 'c1', ...o,
});

describe('selectorMatches (K8s equality-selector semantics)', () => {
  it('every selector kv must match; extra pod labels are fine; missing labels fail', () => {
    expect(selectorMatches({ app: 'web' }, { app: 'web', tier: 'fe' })).toBe(true);
    expect(selectorMatches({ app: 'web', tier: 'fe' }, { app: 'web' })).toBe(false);
    expect(selectorMatches({ app: 'web' }, { app: 'api' })).toBe(false);
    expect(selectorMatches({ app: 'web' }, undefined)).toBe(false);
    // prototype-named label keys are own-property checked
    expect(selectorMatches({ constructor: 'x' }, { app: 'web' })).toBe(false);
  });
});

describe('serviceResources (gap L229 — v1 Service Resources join)', () => {
  it('joins per (cluster, namespace), Running pods only, sums requests as millicores/MiB', () => {
    const services = [svc({ name: 'web', selector: { app: 'web' } })];
    const pods = [
      pod({ name: 'p1', labels: { app: 'web' }, cpuRequest: 0.25, memRequest: 128 }),
      pod({ name: 'p2', labels: { app: 'web' }, cpuRequest: 0.5, memRequest: 256 }),
      pod({ name: 'p3', labels: { app: 'web' }, status: 'Pending', cpuRequest: 9, memRequest: 9999 }), // not Running
      pod({ name: 'p4', labels: { app: 'web' }, namespace: 'other' }),  // other namespace
      pod({ name: 'p5', labels: { app: 'web' }, cluster: 'c2' }),       // other cluster
      pod({ name: 'p6', labels: { app: 'api' } }),                      // selector mismatch
    ];
    const rows = serviceResources(services, pods);
    expect(rows).toEqual([{
      key: 'c1/ns/web', name: 'web', namespace: 'ns', cluster: 'c1',
      pods: 2, cpuMillicores: 750, memMiB: 384,
    }]);
  });

  it('selectorless services and zero-match services are EXCLUDED, never charted as 0', () => {
    const services = [
      svc({ name: 'external', selector: undefined }),           // ExternalName/manual Endpoints
      svc({ name: 'orphan', selector: { app: 'nothing' } }),    // zero matched running pods
      svc({ name: 'live', selector: { app: 'web' } }),
    ];
    const rows = serviceResources(services, [pod({ labels: { app: 'web' } })]);
    expect(rows.map((r) => r.name)).toEqual(['live']);
  });

  it('same-name services in different namespaces/clusters never merge', () => {
    const services = [
      svc({ name: 'web', namespace: 'a', selector: { app: 'web' } }),
      svc({ name: 'web', namespace: 'b', selector: { app: 'web' } }),
    ];
    const pods = [
      pod({ namespace: 'a', labels: { app: 'web' }, cpuRequest: 1 }),
      pod({ namespace: 'b', labels: { app: 'web' }, cpuRequest: 2 }),
    ];
    const rows = serviceResources(services, pods);
    expect(rows.map((r) => [r.key, r.cpuMillicores])).toEqual([
      ['c1/a/web', 1000], ['c1/b/web', 2000],
    ]);
  });
});

describe('topServiceResources', () => {
  it('top-N descending with a deterministic key tie-break', () => {
    const rows = serviceResources(
      [svc({ name: 'b', selector: { app: 'b' } }), svc({ name: 'a', selector: { app: 'a' } }), svc({ name: 'big', selector: { app: 'big' } })],
      [
        pod({ name: 'pa', labels: { app: 'a' }, cpuRequest: 0.1 }),
        pod({ name: 'pb', labels: { app: 'b' }, cpuRequest: 0.1 }),
        pod({ name: 'pc', labels: { app: 'big' }, cpuRequest: 1 }),
      ],
    );
    const top = topServiceResources(rows, 'cpuMillicores', 2);
    expect(top.map((r) => r.name)).toEqual(['big', 'a']); // tie a-vs-b → key asc
  });
});
