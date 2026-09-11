import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEksIpMap } from './topology-config';
import { buildFlowGraph, scopedTargetIp } from './flow-topology';
import { buildE2eGraph } from './e2e-topology';
import type { NetworkObservation } from './e2e-topology-types';

const region = 'us-east-1', vpcId = 'vpc-shared', ip = '10.0.2.10';
const pod = { name: 'orders-a', namespace: 'shop', podIP: ip, workload: 'orders' };
const endpoint = {
  name: 'external-service', namespace: 'shop', ips: [ip], targets: [{ ip, pod: 'orders-a' }],
};
const cluster = { name: 'host-cluster', access: 'connected', region, vpcId };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const network: NetworkObservation[] = [{
  monitor: 'nfm-eks-client-cluster', cluster: 'client-cluster', metric: 'DATA_TRANSFERRED',
  category: 'INTER_AZ', rangeSec: 900, unit: 'Bytes', capped: false,
  rows: [{
    local: { ip: '10.0.1.1', region, vpcId },
    remote: { ip, region, vpcId, podName: 'orders-a', podNamespace: 'shop' },
    value: 10, unit: 'Bytes', category: 'INTER_AZ', traversed: [], traversedIds: [],
  }],
}];

function serve(pods: unknown[], endpoints: unknown[] = [endpoint], options: {
  failure?: 'http' | 'transport' | 'envelope'; clusters?: typeof cluster[];
} = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/eks') return json({ clusters: options.clusters ?? [cluster] });
    if (url.searchParams.get('kind') === 'pods') {
      if (options.failure === 'http') return json({ error: 'Forbidden' }, 403);
      if (options.failure === 'transport') throw new Error('unavailable');
      if (options.failure === 'envelope') return json({ error: 'Unavailable', rows: pods });
      return json({ kind: 'pods', rows: pods });
    }
    if (url.searchParams.get('kind') === 'endpoints') return json({ kind: 'endpoints', rows: endpoints });
    throw new Error(`Unexpected request: ${url}`);
  }));
}

async function graphs() {
  const ipResolved = await fetchEksIpMap();
  const configured = buildFlowGraph({
    ipResolved, tg: [{
      resource_id: 'tg-shared', region, vpc_id: vpcId, target_type: 'ip',
      target_health_descriptions: [{ Target: { Id: ip, Port: 80 } }],
    }],
  });
  const integrated = buildE2eGraph({
    account: 'self', configured, network,
    services: {
      captured_at: null, edges: [],
      nodes: ['host-cluster', 'other-cluster'].map(name => ({
        id: `wl:${name}`, kind: 'workload', label: `${name}/orders`,
        meta: { cluster: name, namespace: 'shop', pods: ['orders-a'] },
      })),
    },
  });
  return { ipResolved, target: configured.nodes.find(n => n.kind === 'target')!, integrated };
}

afterEach(() => vi.unstubAllGlobals());

describe('EKS inventory producer → configuration → service/network graph', () => {
  it.each([
    { name: 'empty pod inventory', pods: [] },
    { name: 'failed pod HTTP request', pods: [pod], failure: 'http' as const },
    { name: 'failed pod transport', pods: [pod], failure: 'transport' as const },
    { name: 'pod error envelope carrying stale rows', pods: [pod], failure: 'envelope' as const },
    { name: 'conflicting targetRef', pods: [pod], endpoints: [{ ...endpoint, targets: [{ ip, pod: 'different-pod' }] }] },
    { name: 'conflicting namespace', pods: [{ ...pod, namespace: 'other' }] },
    { name: 'missing pod namespace', pods: [{ ...pod, namespace: '' }] },
    { name: 'missing pod name', pods: [{ ...pod, name: '' }] },
    { name: 'two pods on one IP', pods: [pod, { ...pod, name: 'orders-b' }] },
    { name: 'reversed duplicate IP candidates', pods: [{ ...pod, name: 'orders-b' }, pod] },
    { name: 'same pod name on one IP across namespaces', pods: [pod, { ...pod, namespace: 'other' }] },
    { name: 'conflicting second Service cannot be hidden by a valid Service', pods: [pod],
      endpoints: [endpoint, { ...endpoint, name: 'other-service', targets: [{ ip, pod: 'different-pod' }] }] },
  ])('does not prove remote cluster ownership from $name', async ({ pods, endpoints, ...options }) => {
    serve(pods, endpoints, options);
    const { target, integrated } = await graphs();
    expect(target.label).toBe(ip);
    expect(target.meta?.resolved).toBeUndefined();
    expect(target.meta?.cluster).toBeUndefined();
    expect(integrated.edges.filter(e => e.meta?.match === 'configured-cluster')).toEqual([]);
    // Raw target registration is still a valid IP-in-VPC observation, without workload ownership.
    expect(integrated.edges.filter(e => e.meta?.match === 'ip-region-vpc')).toHaveLength(1);
  });

  it('preserves Service labeling only after the IP, pod name and namespace agree', async () => {
    serve([pod]);
    const { target, integrated } = await graphs();
    expect(target.label).toBe('shop/external-service');
    expect(target.meta).toMatchObject({
      resolved: 'eks', cluster: 'host-cluster', pod: 'orders-a', namespace: 'shop', region, vpcId,
    });
    const matches = integrated.edges.filter(e => e.meta?.match === 'configured-cluster');
    expect(matches).toHaveLength(1);
    expect(matches[0].meta).toMatchObject({ cluster: 'host-cluster', pod: 'orders-a' });
    expect(integrated.nodes.find(n => n.id === matches[0].target)?.label).toBe('host-cluster/orders');
  });

  it('can prove an independently listed unique pod with no Service', async () => {
    serve([pod], []);
    const { target, integrated } = await graphs();
    expect(target.label).toBe('shop/orders');
    expect(integrated.edges.filter(e => e.meta?.match === 'configured-cluster')).toHaveLength(1);
  });

  it('rejects duplicate cluster candidates even with identical workload names', async () => {
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'other-cluster' }] });
    const { ipResolved, integrated } = await graphs();
    expect(ipResolved[scopedTargetIp(region, vpcId, ip)]).toBeUndefined();
    expect(integrated.edges.filter(e => e.meta?.match === 'configured-cluster')).toEqual([]);
  });

  it('keeps equal IPs in different VPCs separate', async () => {
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'other-cluster', vpcId: 'vpc-other' }] });
    const { ipResolved, integrated } = await graphs();
    expect(Object.keys(ipResolved)).toHaveLength(2);
    expect(integrated.edges.filter(e => e.meta?.match === 'configured-cluster'))
      .toMatchObject([{ meta: { cluster: 'host-cluster' } }]);
  });
});
