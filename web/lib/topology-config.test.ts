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
  failure?: 'http' | 'transport' | 'envelope'; endpointFailure?: 'http' | 'transport' | 'envelope' | 'malformed'; clusters?: typeof cluster[];
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
    if (url.searchParams.get('kind') === 'endpoints') {
      if (options.endpointFailure === 'http') return json({ error: 'Forbidden' }, 403);
      if (options.endpointFailure === 'transport') throw new Error('unavailable');
      if (options.endpointFailure === 'envelope') return json({ error: 'Unavailable', rows: [] });
      if (options.endpointFailure === 'malformed') return json({ rows: null });
      return json({ kind: 'endpoints', rows: endpoints });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
}

async function graphs() {
  const resolution = await fetchEksIpMap();
  const ipResolved = resolution.map;
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
  return { resolution, ipResolved, target: configured.nodes.find(n => n.kind === 'target')!, integrated };
}

afterEach(() => vi.unstubAllGlobals());

describe('EKS inventory producer → configuration → service/network graph', () => {
  it('distinguishes valid empty enumeration from unreadable clusters', async () => {
    serve([], [], { clusters: [] });
    expect(await fetchEksIpMap()).toEqual({ map: {}, blockedScopes: [], globalUnknown: false, status: 'empty', reasons: [] });
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'unreadable', access: 'unknown' }] });
    expect(await fetchEksIpMap()).toEqual({ map: { [scopedTargetIp(region, vpcId, ip)]: null },
      blockedScopes: [`${region}|${vpcId}|`], globalUnknown: false, status: 'unavailable', reasons: ['cluster_unreadable'] });
  });
  it('keeps unreadable scope evidence when no IP could be enumerated', async () => {
    serve([], [], { clusters: [{ ...cluster, access: 'no-entry' }] });
    expect(await fetchEksIpMap()).toEqual({ map: {}, status: 'unavailable', reasons: ['cluster_unreadable'],
      blockedScopes: [`${region}|${vpcId}|`], globalUnknown: false });
  });
  it.each(['unknown', 'no-entry'])('keeps a healthy different VPC when access is %s', access => {
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'unreadable', vpcId: 'vpc-other', access }] });
    return expect(fetchEksIpMap()).resolves.toMatchObject({ status: 'partial', reasons: ['cluster_unreadable'],
      map: { [scopedTargetIp(region, vpcId, ip)]: { resolved: 'eks' } } });
  });

  it.each([24, 25])('reports only a possible listing cap at %i clusters', async count => {
    serve([pod], [endpoint], { clusters: Array.from({ length: count }, (_, i) => ({ ...cluster, name: `cluster-${i}`, vpcId: `vpc-${i}` })) });
    const result = await fetchEksIpMap();
    expect(result.status).toBe(count === 25 ? 'unavailable' : 'ok');
    expect(result.reasons).toEqual(count === 25 ? ['cluster_limit_possible'] : []);
    expect(Object.keys(result.map)).toHaveLength(count === 25 ? 0 : count);
  });

  it.each(['malformed-cluster', {}])('does not silently skip an unreadable cluster descriptor: %j', invalid => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      return url.pathname === '/api/eks' ? json({ clusters: [cluster, invalid] })
        : json({ rows: url.searchParams.get('kind') === 'pods' ? [pod] : [endpoint] });
    }));
    return expect(fetchEksIpMap()).resolves.toMatchObject({ map: {}, status: 'unavailable' });
  });

  it.each([
    ['failed pod read', 'pods', null, []],
    ['failed endpoint read', 'endpoints', null, []],
    ['null pod row', 'pods', [null], []],
    ['non-object pod row', 'pods', ['invalid'], []],
    ['missing pod identity fields', 'pods', [{}], []],
    ['invalid pod IP', 'pods', [{ ...pod, podIP: {} }], []],
    ['null endpoint row', 'endpoints', [null], []],
    ['invalid endpoint IP list', 'endpoints', [{ ...endpoint, ips: ip }], []],
    ['missing endpoint identity fields', 'endpoints', [{ ips: [], targets: [] }], []],
    ['missing endpoint references', 'endpoints', [{ ...endpoint, ips: [], targets: undefined }], []],
    ['invalid target reference', 'endpoints', [{ ...endpoint, targets: [null] }], [pod]],
  ])('returns no proven map when a later cluster has %s', async (_, kind, badRows, otherRows) => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/eks') return json({ clusters: [cluster, { ...cluster, name: 'other-cluster' }] });
      if (url.pathname.includes('/other-cluster/')) {
        // Let the healthy cluster finish before the competing cluster becomes unavailable.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (url.searchParams.get('kind') === kind) return badRows === null
          ? json({ status: 'error' }, 503) : json({ rows: badRows });
        return json({ rows: otherRows }); // failed reads cannot rely on knowing the competing IP set
      }
      return json({ rows: url.searchParams.get('kind') === 'pods' ? [pod] : [endpoint] });
    }));
    const { ipResolved, target, integrated } = await graphs();
    expect(ipResolved).toEqual({ [scopedTargetIp(region, vpcId, ip)]: null });
    expect([undefined, 'ambiguous']).toContain(target.meta?.resolved);
    expect(integrated.edges.filter(edge => edge.meta?.match === 'configured-cluster')).toEqual([]);
  });

  it.each([false, true])('keeps healthy ownership beside an empty or failed other scope: %s', async failed => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/eks') return json({ clusters: [cluster, { ...cluster, name: 'empty-cluster', vpcId: failed ? 'vpc-other' : vpcId }] });
      if (failed && url.pathname.includes('/empty-cluster/')) return json({}, 503);
      return json({ rows: url.pathname.includes('/empty-cluster/') ? []
        : url.searchParams.get('kind') === 'pods' ? [pod] : [endpoint] });
    }));
    const { target, resolution } = await graphs();
    expect(resolution.status).toBe(failed ? 'partial' : 'ok');
    expect(target).toMatchObject({ label: 'shop/external-service', meta: { resolved: 'eks', cluster: 'host-cluster' } });
  });

  it('keeps healthy ownership alongside an unassigned pod with no optional IP', async () => {
    serve([pod, { name: 'pending-pod', namespace: 'shop' }]);
    expect((await graphs()).target).toMatchObject({
      label: 'shop/external-service', meta: { resolved: 'eks', pod: 'orders-a' },
    });
  });

  it('cannot rule out a connected cluster with unknown network scope', async () => {
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'unknown-scope', vpcId: '' }] });
    expect(await fetchEksIpMap()).toMatchObject({ map: {}, status: 'unavailable' });
  });

  it.each([
    { name: 'empty pod inventory', pods: [] },
    { name: 'failed pod HTTP request', pods: [pod], failure: 'http' as const },
    { name: 'failed pod transport', pods: [pod], failure: 'transport' as const },
    { name: 'pod error envelope carrying stale rows', pods: [pod], failure: 'envelope' as const },
    ...(['http', 'transport', 'envelope', 'malformed'] as const).map(endpointFailure => ({
      name: `endpoint ${endpointFailure} failure with a valid pod`, pods: [pod], endpointFailure,
    })),
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
    expect([undefined, 'ambiguous']).toContain(target.meta?.resolved);
    expect(target.meta?.cluster).toBeUndefined();
    expect(integrated.edges.filter(e => e.meta?.match === 'configured-cluster')).toEqual([]);
    // Registration can link by IP only when no collected ownership claim contests it.
    expect(integrated.edges.filter(e => e.meta?.match === 'ip-region-vpc'))
      .toHaveLength(target.meta?.resolved === 'ambiguous' ? 0 : 1);
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
    expect(ipResolved[scopedTargetIp(region, vpcId, ip)]).toBeNull();
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
