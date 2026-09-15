import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEksIpMap, fetchEksIpEvidence, inventoryEvidence } from './topology-config';
import { buildFlowGraph, scopedTargetIp } from './flow-topology';

const region = 'us-east-1', vpcId = 'vpc-shared', ip = '10.0.2.10';
// normalizePod exposes Kubernetes status.phase as the flat status field.
const pod = { name: 'orders-a', namespace: 'shop', podIP: ip, workload: 'orders', status: 'Running' };
const endpoint = {
  name: 'external-service', namespace: 'shop', ips: [ip], targets: [{ ip, pod: 'orders-a' }],
};
const cluster = { name: 'host-cluster', access: 'connected', region, vpcId };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function serve(pods: unknown[], endpoints: unknown[] = [endpoint], options: {
  failure?: 'http' | 'transport' | 'envelope'; endpointFailure?: 'http' | 'transport' | 'envelope' | 'malformed'; clusters?: typeof cluster[];
} = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/eks') return json({ region, clusters: options.clusters ?? [cluster] });
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
  return { resolution, ipResolved, target: configured.nodes.find(n => n.kind === 'target')! };
}

afterEach(() => vi.unstubAllGlobals());

describe('EKS inventory producer → configuration', () => {
  it.each([
    ['Pending', 'eks', 'ambiguous'], ['Running', 'eks', 'ambiguous'],
    ['Succeeded', undefined, 'ecs'], ['Failed', undefined, 'ecs'],
    ['Unknown', 'ambiguous', 'ambiguous'], ['', 'ambiguous', 'ambiguous'],
    [undefined, 'ambiguous', 'ambiguous'], ['CrashLoopBackOff', 'ambiguous', 'ambiguous'],
  ])('arbitrates normalized pod phase %s before IP ownership', async (status, alone, withEcs) => {
    serve([{ ...pod, status }], []);
    const resolution = await fetchEksIpMap();
    const input = { ipResolved: resolution.map, tg: [{
      resource_id: 'tg-phase', region, vpc_id: vpcId, target_type: 'ip', captured_at: '2026-09-11T09:00:00Z',
      target_health_descriptions: [{ Target: { Id: ip } }],
    }] };
    const target = buildFlowGraph(input).nodes.find(n => n.kind === 'target')!;
    expect(target.meta?.resolved).toBe(alone);
    expect(target.meta?.targetCapturedAt).toBe('2026-09-11T09:00:00Z');
    const reused = buildFlowGraph({ ...input,
      ecsTask: [{ resource_id: 'task', region, last_status: 'RUNNING', attachments: [{ Details: [
        { Name: 'subnetId', Value: 'subnet' }, { Name: 'privateIPv4Address', Value: ip },
      ] }] }], subnet: [{ resource_id: 'subnet', region, vpc_id: vpcId }],
    }).nodes.find(n => n.kind === 'target')!;
    expect(reused.meta?.resolved).toBe(withEcs);
  });

  it.each(['Succeeded', 'Failed'])('does not let a retained %s pod contest a healthy replacement', async status => {
    for (const pods of [[{ ...pod, name: 'old-pod', status }, pod], [pod, { ...pod, name: 'old-pod', status }]]) {
      serve(pods);
      expect((await graphs()).target.meta).toMatchObject({ resolved: 'eks', pod: 'orders-a' });
    }
  });

  it('keeps an endpoint reference to a terminal pod unverified instead of claiming ownership', async () => {
    serve([{ ...pod, status: 'Succeeded' }]);
    expect((await graphs()).target.meta?.resolved).toBe('ambiguous');
  });

  it('does not start EKS reads for an already-aborted load', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const controller = new AbortController(); controller.abort();
    expect(await fetchEksIpMap(controller.signal)).toMatchObject({ map: {}, globalUnknown: true });
    expect(request).not.toHaveBeenCalled();
  });
  it('distinguishes valid empty enumeration from unreadable clusters', async () => {
    serve([], [], { clusters: [] });
    expect(await fetchEksIpMap()).toEqual({ map: {}, blockedScopes: [], coveredRegions: [region], globalUnknown: false, status: 'empty', reasons: [] });
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'unreadable', access: 'unknown' }] });
    expect(await fetchEksIpMap()).toEqual({ map: { [scopedTargetIp(region, vpcId, ip)]: null },
      blockedScopes: [`${region}|${vpcId}|`], coveredRegions: [region], globalUnknown: false, status: 'unavailable', reasons: ['cluster_unreadable'] });
  });
  it.each([region, undefined])('requires a declared region for empty enumeration: %s', async declared => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ clusters: [], region: declared })));
    expect(await fetchEksIpMap()).toMatchObject({ coveredRegions: declared ? [declared] : [],
      globalUnknown: !declared, status: declared ? 'empty' : 'unavailable' });
  });
  it('does not certify an empty first page when the API reports more clusters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ clusters: [], region, truncated: true })));
    expect(await fetchEksIpMap()).toMatchObject({ globalUnknown: true, reasons: ['cluster_limit_possible'] });
  });
  it.each([null, 'false', 0])('retains the public invalid truncation guard: %s', async truncated => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ clusters: [], region, truncated })));
    expect(await fetchEksIpMap()).toMatchObject({ globalUnknown: true, reasons: ['cluster_limit_possible'] });
  });
  it('keeps unreadable scope evidence when no IP could be enumerated', async () => {
    serve([], [], { clusters: [{ ...cluster, access: 'no-entry' }] });
    expect(await fetchEksIpMap()).toEqual({ map: {}, status: 'unavailable', reasons: ['cluster_not_connected'], notConnected: 1,
      blockedScopes: [`${region}|${vpcId}|`], coveredRegions: [region], globalUnknown: false });
  });
  it.each(['unknown', 'no-entry'])('keeps a healthy different VPC when access is %s', access => {
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'unreadable', vpcId: 'vpc-other', access }] });
    return expect(fetchEksIpMap()).resolves.toMatchObject({ status: 'partial', reasons: [access === 'no-entry' ? 'cluster_not_connected' : 'cluster_unreadable'],
      map: { [scopedTargetIp(region, vpcId, ip)]: { resolved: 'eks' } } });
  });
  it.each(['entry-only', 'no-entry'])('still blocks a connected candidate sharing an unqueried %s scope', async access => {
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'not-onboarded', access }] });
    const result = await fetchEksIpMap();
    expect(result).toMatchObject({ reasons: ['cluster_not_connected'], notConnected: 1,
      blockedScopes: [`${region}|${vpcId}|`], map: { [scopedTargetIp(region, vpcId, ip)]: null } });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/not-onboarded/'))).toBe(false);
  });
  it.each(['US-EAST-1', ' us-east-1', '<region>', 'a'.repeat(65), null])(
    'rejects an invalid declared or cluster region before querying pods: %s', async invalid => {
      vi.stubGlobal('fetch', vi.fn(async () => json({
        region: invalid, truncated: false, clusters: [{ ...cluster, region: invalid }],
      })));
      expect(await fetchEksIpMap()).toMatchObject({ globalUnknown: true, status: 'unavailable', coveredRegions: [] });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
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
    ['invalid pod phase shape', 'pods', [{ ...pod, status: { phase: 'Running' } }], []],
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
    const { ipResolved, target } = await graphs();
    expect(ipResolved).toEqual({ [scopedTargetIp(region, vpcId, ip)]: null });
    expect([undefined, 'ambiguous']).toContain(target.meta?.resolved);
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
    serve([pod, { name: 'pending-pod', namespace: 'shop', status: 'Pending' }]);
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
    const { target } = await graphs();
    expect(target.label).toBe(ip);
    expect([undefined, 'ambiguous']).toContain(target.meta?.resolved);
    expect(target.meta?.cluster).toBeUndefined();
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

  it.each(['shop', 'other'])('ignores a manual non-pod Service in namespace %s for ownership and labeling', async namespace => {
    const manual = { ...endpoint, name: 'external-backend', namespace, targets: [{ ip }] };
    serve([pod], [manual]);
    expect((await graphs()).target).toMatchObject({ label: 'shop/orders', meta: { resolved: 'eks', pod: 'orders-a' } });
    serve([pod], [manual, endpoint]);
    expect((await graphs()).target).toMatchObject({ label: 'shop/external-service', meta: { resolved: 'eks', pod: 'orders-a' } });
  });

  it.each([undefined, 'orders-a'])('distinguishes a manual backend from an unresolved pod reference: %s', async reference => {
    serve([], [{ ...endpoint, targets: [{ ip, pod: reference }] }]);
    const { map } = await fetchEksIpMap();
    const graph = buildFlowGraph({ ipResolved: map,
      tg: [{ resource_id: 'tg', region, vpc_id: vpcId, target_type: 'ip', target_health_descriptions: [{ Target: { Id: ip } }] }],
      ecsTask: [{ resource_id: 'task', region, last_status: 'RUNNING', attachments: [{ Details: [
        { Name: 'subnetId', Value: 'subnet' }, { Name: 'privateIPv4Address', Value: ip },
      ] }] }], subnet: [{ resource_id: 'subnet', region, vpc_id: vpcId }],
    });
    expect(map[scopedTargetIp(region, vpcId, ip)]).toBe(reference ? null : undefined);
    expect(graph.nodes.find(node => node.kind === 'target')?.meta?.resolved).toBe(reference ? 'ambiguous' : 'ecs');
  });

  it('rejects duplicate cluster candidates even with identical workload names', async () => {
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'other-cluster' }] });
    const { ipResolved } = await graphs();
    expect(ipResolved[scopedTargetIp(region, vpcId, ip)]).toBeNull();
  });

  it('keeps equal IPs in different VPCs separate', async () => {
    serve([pod], [endpoint], { clusters: [cluster, { ...cluster, name: 'other-cluster', vpcId: 'vpc-other' }] });
    const { ipResolved } = await graphs();
    expect(Object.keys(ipResolved)).toHaveLength(2);
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

// Public evidence UI keeps source-read health distinct from unverified address candidates.
describe('EKS evidence compatibility', () => {
  it.each(['host-network', 'duplicate-cluster'])('does not call successful %s reads a collection failure', async scenario => {
    serve(scenario === 'host-network' ? [pod, { ...pod, name: 'other' }] : [pod], [endpoint],
      { clusters: scenario === 'duplicate-cluster' ? [cluster, { ...cluster, name: 'other' }] : [cluster] });
    const result = await fetchEksIpEvidence();
    expect(result).toMatchObject({ status: 'ok', region, notConnected: 0 });
    expect(Object.values(result.ipResolved).every(value => value === null)).toBe(true);
  });
  it.each(['entry-only', 'no-entry'])('counts unqueried %s clusters while retaining a blocked ownership scope', async access => {
    serve([], [], { clusters: [{ ...cluster, access }] });
    expect(await fetchEksIpEvidence()).toMatchObject({ status: 'partial', region, notConnected: 1 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
  it.each(['http', 'transport', 'envelope'] as const)('discloses %s failures', async failure => {
    serve([pod], [endpoint], { failure });
    expect(await fetchEksIpEvidence()).toMatchObject({ status: 'partial', region, notConnected: 0 });
  });
});
