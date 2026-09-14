import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEksIpMap, fetchEksIpEvidence, inventoryEvidence } from './topology-config';
import { buildFlowGraph, scopedTargetIp } from './flow-topology';

const region = 'us-east-1', vpcId = 'vpc-shared', ip = '10.0.2.10';
const pod = { name: 'orders-a', namespace: 'shop', podIP: ip, workload: 'orders' };
const endpoint = {
  name: 'external-service', namespace: 'shop', ips: [ip], targets: [{ ip, pod: 'orders-a' }],
};
const cluster = { name: 'host-cluster', access: 'connected', region, vpcId };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

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
  return { ipResolved, target: configured.nodes.find(n => n.kind === 'target')! };
}

afterEach(() => vi.unstubAllGlobals());

describe('EKS inventory producer → configured flow graph', () => {
  it.each(['Succeeded', 'Failed'])('ignores %s pods whose released IP is reused by a running pod', async status => {
    serve([{ ...pod, status: 'Running' }, { ...pod, name: 'completed-job', status }]);
    const result = await graphs();
    expect(result.ipResolved[scopedTargetIp(region, vpcId, ip)]?.meta?.pod).toBe('orders-a');
    expect(result.target.meta?.resolved).toBe('eks');
  });

  it.each(['Succeeded', 'Failed'])('does not attribute an IP to an exclusively %s pod', async status => {
    serve([{ ...pod, status }]);
    expect(await fetchEksIpMap()).toEqual({});
  });

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
    const { target } = await graphs();
    expect(target.label).toBe(ip);
    expect(target.meta?.resolved).toBeUndefined();
    expect(target.meta?.cluster).toBeUndefined();
  });

  it.each([
    { name: 'hostNetwork pods', pods: [{ ...pod, name: 'aws-node' }, { ...pod, name: 'kube-proxy' }] },
    { name: 'uncorroborated endpoint IP', pods: [] },
    { name: 'duplicate cluster candidates', pods: [pod], clusters: [cluster, { ...cluster, name: 'other' }] },
  ])('keeps successful reads healthy while rejecting $name', async ({ pods, clusters }) => {
    serve(pods, [endpoint], { clusters });
    expect(await fetchEksIpEvidence()).toEqual({ ipResolved: {}, status: 'ok' });
  });
  it.each(['http', 'transport', 'envelope'] as const)('still discloses a real %s read failure', async failure => {
    serve([pod], [endpoint], { failure });
    expect(await fetchEksIpEvidence()).toEqual({ ipResolved: {}, status: 'partial' });
  });

  it('preserves Service labeling only after the IP, pod name and namespace agree', async () => {
    serve([pod]);
    const { target } = await graphs();
    expect(target.label).toBe('shop/external-service');
    expect(target.meta).toMatchObject({
      resolved: 'eks', cluster: 'host-cluster', pod: 'orders-a', namespace: 'shop', region, vpcId,
    });

  });

  it('can prove an independently listed unique pod with no Service', async () => {
    serve([pod], []);
    const { target } = await graphs();
    expect(target.label).toBe('shop/orders');
  });

  it('rejects duplicate cluster candidates even with identical workload names', async () => {
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'other-cluster' }] });
    const { ipResolved } = await graphs();
    expect(ipResolved[scopedTargetIp(region, vpcId, ip)]).toBeUndefined();
  });

  it('keeps equal IPs in different VPCs separate', async () => {
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'other-cluster', vpcId: 'vpc-other' }] });
    const { ipResolved } = await graphs();
    expect(Object.keys(ipResolved)).toHaveLength(2);
    expect(ipResolved[scopedTargetIp(region, vpcId, ip)].meta?.cluster).toBe('host-cluster');
  });
});


describe('inventory capture evidence', () => {
  const old = '2026-09-01T01:00:00Z', newer = '2026-09-02T01:00:00Z';
  const run = { status: 'failed', last_success_at: newer, finished_at: '2026-09-14T12:00:00Z' };
  it('retains oldest/newest row captures despite a newer failed attempt', () => {
    expect(inventoryEvidence([{ captured_at: newer }, { captured_at: old }], run, true))
      .toEqual({ capturedAt: old, capturedThrough: newer, unknownCapture: false, aggregateStatus: 'failed' });
  });
  it('uses last-success only as fallback while disclosing unknown row captures', () => {
    expect(inventoryEvidence([{}], run, true))
      .toEqual({ capturedAt: newer, capturedThrough: newer, unknownCapture: true, aggregateStatus: 'failed' });
  });
  it('keeps member row clocks and separately reports aggregate run health', () => {
    expect(inventoryEvidence([{ captured_at: old }], run, false))
      .toEqual({ capturedAt: old, capturedThrough: old, unknownCapture: false, aggregateStatus: 'failed' });
  });
  it.each(['succeeded', 'partial', 'failed', 'running'])('retains aggregate %s without borrowing a member clock', status => {
    expect(inventoryEvidence([], { ...run, status }, false)).toEqual({
      capturedAt: null, capturedThrough: null, unknownCapture: true, aggregateStatus: status,
    });
  });
  it('rejects invalid times and never falls back to failed-attempt finish', () => {
    expect(inventoryEvidence([{ captured_at: 'bad' }], { ...run, last_success_at: 'bad' }, true))
      .toEqual({ capturedAt: null, capturedThrough: null, unknownCapture: true, aggregateStatus: 'failed' });
  });
  it('preserves successful empty host collection evidence', () => {
    expect(inventoryEvidence([], { status: 'succeeded', last_success_at: old }, true))
      .toEqual({ capturedAt: old, capturedThrough: old, unknownCapture: false, aggregateStatus: 'succeeded' });
  });
});
