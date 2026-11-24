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
      return json({ kind: 'pods', rows: pods, generatedAt: '2026-11-18T00:00:00Z' });
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

  it.each<{ name: string; pods: unknown[]; endpoints?: unknown[] } & NonNullable<Parameters<typeof serve>[2]>>([
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

it('only forwards immutable internal Pod records when the guarded lens requests them', async () => {
  const arn = 'arn:aws:eks:us-east-1:111111111111:cluster/host-cluster';
  const scoped = { ...cluster, arn, accountId:'111111111111' };
  serve([{...pod,uid:'unique-pod',hostNetwork:false}],[],{clusters:[scoped]});
  expect((await fetchEksIpMap()).bindings).toBeUndefined();
  expect((await fetchEksIpMap(undefined,true)).bindings).toMatchObject([
    {nativeId:'unique-pod',authority:arn,confidence:'observed',ip}]);
});

it('uses the Pod reader clock and distinguishes empty, withheld authority and incomplete bindings', async () => {
  const scoped={...cluster,arn:'arn:aws:eks:us-east-1:111111111111:cluster/host-cluster',accountId:'111111111111'};
  serve([{...pod,uid:'u'}],[],{clusters:[scoped]});
  expect((await fetchEksIpMap(undefined,true)).bindings?.[0].evidence.capturedAt).toBe(Date.parse('2026-11-18T00:00:00Z'));
  serve([],[],{clusters:[scoped]});
  expect(await fetchEksIpMap(undefined,true)).toMatchObject({bindings:[],bindingRead:{status:'empty'}});
  const wrongAccount = {...scoped,arn:scoped.arn.replace('111111111111','222222222222')};
  for (const uid of [undefined,'','  ']) {
    serve([{...pod,uid}],[],{clusters:[scoped]});
    const invalid=await fetchEksIpMap(undefined,true);
    expect(invalid.bindingRead).toEqual({status:'withheld',reasons:['binding_rows_invalid']});
    expect(invalid.bindings).toBeUndefined();
  }
  serve([{...pod,uid:'valid'}],[],{clusters:[wrongAccount]});
  expect((await fetchEksIpMap(undefined,true)).bindingRead).toEqual({status:'withheld',reasons:['binding_authority_unverified']});
  serve(Array.from({length:10001},()=>({...pod,uid:'u'})),[],{clusters:[scoped]});
  const bounded=await fetchEksIpMap(undefined,true);
  expect(bounded.bindingRead).toEqual({status:'withheld',reasons:['binding_limit']});
  expect(bounded.bindings).toBeUndefined();
});

describe('scope-aware EKS listing', () => {
  const member = '123456789012', other = '111111111111', mRegion = 'ap-northeast-2', mVpc = 'vpc-member';
  const memberArn = `arn:aws:eks:${mRegion}:${member}:cluster/shop-cluster`;
  const memberCluster = { id: memberArn, arn: memberArn, name: 'shop-cluster', accountId: member,
    access: 'connected', region: mRegion, vpcId: mVpc };
  const memberPod = { ...pod, uid: 'member-pod', hostNetwork: false };
  function serveScoped(list: Record<string, unknown>, pods: unknown[] = [memberPod]) {
    const f = vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/eks') return json(list);
      if (url.searchParams.get('kind') === 'pods') return json({ kind: 'pods', rows: pods, generatedAt: '2026-11-18T00:00:00Z' });
      if (url.searchParams.get('kind') === 'endpoints') return json({ kind: 'endpoints', rows: [endpoint] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', f);
    return f;
  }
  const requested = (f: ReturnType<typeof serveScoped>) => f.mock.calls.map(call => String((call as unknown[])[0]));

  it('requests the selected accounts and regions and drops other keys', async () => {
    let f = serveScoped({ region: mRegion, clusters: [memberCluster] });
    await fetchEksIpMap(undefined, false, `accounts=${member}&regions=${mRegion}`);
    expect(requested(f)[0]).toBe(`/api/eks?accounts=${member}&regions=${mRegion}`);
    f = serveScoped({ region: mRegion, clusters: [memberCluster] });
    await fetchEksIpMap(undefined, false, `limit=5&accounts=${member},${other}&cluster=x&regions=${mRegion}&includeGlobal=1`);
    const url = new URL(requested(f)[0], 'http://localhost');
    expect(url.pathname).toBe('/api/eks');
    expect([...url.searchParams.keys()]).toEqual(['accounts', 'regions', 'includeGlobal']);
    expect(url.searchParams.get('accounts')).toBe(`${member},${other}`);
    expect(url.searchParams.get('includeGlobal')).toBe('1');
  });

  it('keeps the unscoped default and a scope with no allowed keys on the bare listing', async () => {
    let f = serveScoped({ region, clusters: [cluster] });
    await fetchEksIpMap();
    expect(requested(f)[0]).toBe('/api/eks');
    expect(requested(f).slice(1).every(u => u.startsWith('/api/eks/host-cluster/incluster?'))).toBe(true);
    f = serveScoped({ region, clusters: [cluster] });
    await fetchEksIpMap(undefined, false, 'foo=bar');
    expect(requested(f)[0]).toBe('/api/eks');
  });

  it('binds a member cluster ARN row by region|vpc|ip and reads it through the encoded ARN', async () => {
    const f = serveScoped({ clusters: [memberCluster, { ...memberCluster, id: memberArn.replace(member, other),
      arn: memberArn.replace(member, other), accountId: other, vpcId: 'vpc-other' }] });
    const result = await fetchEksIpMap(undefined, true, `accounts=${member},${other}&regions=${mRegion}`);
    expect(result).toMatchObject({ status: 'ok', globalUnknown: false, coveredRegions: [mRegion] });
    expect(result.map[scopedTargetIp(mRegion, mVpc, ip)]).toMatchObject({ resolved: 'eks', label: 'shop/external-service',
      meta: { cluster: 'shop-cluster', pod: 'orders-a', region: mRegion, vpcId: mVpc } });
    expect(result.map[scopedTargetIp(mRegion, 'vpc-other', ip)]).toMatchObject({ resolved: 'eks' });
    const incluster = requested(f).slice(1);
    expect(incluster).toContain(`/api/eks/${encodeURIComponent(memberArn)}/incluster?kind=pods`);
    expect(incluster.every(u => u.startsWith('/api/eks/arn%3Aaws%3Aeks%3A'))).toBe(true);
    expect(result.bindingRead).toEqual({ status: 'ok', reasons: [] });
    expect(result.bindings?.find(b => b.authority === memberArn)).toMatchObject({ nativeId: 'member-pod', ip, confidence: 'observed' });
  });

  it('refuses a scoped row without its listed id instead of reading it as a host cluster name', async () => {
    const { id: _omit, ...unnamed } = memberCluster;
    void _omit;
    const f = serveScoped({ region: mRegion, clusters: [unnamed] });
    expect(await fetchEksIpMap(undefined, false, `accounts=${member}&regions=${mRegion}`))
      .toMatchObject({ map: {}, globalUnknown: true, status: 'unavailable' });
    expect(requested(f)).toHaveLength(1);
  });

  it('fails a truncated scoped listing', async () => {
    serveScoped({ clusters: [memberCluster], truncated: true });
    expect(await fetchEksIpMap(undefined, true, `accounts=__all__&regions=${mRegion}`)).toMatchObject({
      map: {}, globalUnknown: true, reasons: ['cluster_limit_possible'], bindingRead: { status: 'withheld' } });
  });

  it.each([
    ['a reason-bearing target failure', { accountId: other, region: mRegion, message: 'EKS inventory query failed', reason: 'denied' }],
    ['a malformed error entry', 'boom'],
    ['an error entry with a non-string reason', { accountId: other, region: '__all__', message: 'x', reason: 1 }],
  ])('fails the whole map on %s instead of covering fewer clusters', async (_label, error) => {
    serveScoped({ clusters: [memberCluster], errors: [error] });
    expect(await fetchEksIpMap(undefined, true, `accounts=${member},${other}&regions=${mRegion}`)).toMatchObject({
      map: {}, globalUnknown: true, status: 'unavailable', bindingRead: { status: 'withheld' } });
  });

  it('keeps the map but withholds bindings under the reason-less all-region discovery note', async () => {
    serveScoped({ clusters: [memberCluster], errors: [{ accountId: member, region: '__all__',
      message: 'All-region discovery covers configured and registered regions only.' }] });
    const result = await fetchEksIpMap(undefined, true, `accounts=${member}&regions=__all__`);
    expect(result).toMatchObject({ status: 'ok', globalUnknown: false, coveredRegions: [mRegion] });
    expect(result.map[scopedTargetIp(mRegion, mVpc, ip)]).toMatchObject({ resolved: 'eks' });
    expect(result.bindingRead).toEqual({ status: 'withheld', reasons: ['binding_scope_partial'] });
    expect(result.bindings).toBeUndefined();
  });

  it('keeps the unscoped default path byte-for-byte: name URLs and errors that only withhold bindings', async () => {
    const hostArn = `arn:aws:eks:${region}:${other}:cluster/host-cluster`;
    const f = serveScoped({ region, clusters: [{ ...cluster, id: hostArn, arn: hostArn, accountId: other }],
      errors: [{ accountId: 'self', region, message: 'EKS inventory query failed', reason: 'denied' }] });
    const result = await fetchEksIpMap(undefined, true);
    expect(requested(f).slice(1).every(u => u.startsWith('/api/eks/host-cluster/incluster?'))).toBe(true);
    expect(result).toMatchObject({ status: 'ok', globalUnknown: false, coveredRegions: [region] });
    expect(result.map[scopedTargetIp(region, vpcId, ip)]).toMatchObject({ resolved: 'eks' });
    expect(result.bindingRead).toEqual({ status: 'withheld', reasons: ['binding_read_incomplete'] });
    expect(result.coveredAccountRegions).toBeUndefined();
    for (const errors of ['boom', [{ region: '__all__', message: 'note' }]]) {
      serveScoped({ region, clusters: [{ ...cluster, id: '' }], errors });
      const legacy = await fetchEksIpMap(undefined, true);
      expect(legacy).toMatchObject({ status: 'ok', bindingRead: { status: 'withheld' } });
      expect(legacy.bindingRead?.reasons).toContain('binding_read_incomplete');
      expect(legacy.bindingRead?.reasons).not.toContain('binding_scope_partial');
    }
  });

  it('reports coverage per account, never letting one account cover another in the same region', async () => {
    serveScoped({ clusters: [memberCluster] });
    expect((await fetchEksIpMap(undefined, false, `accounts=${member},${other}&regions=${mRegion}`)).coveredAccountRegions)
      .toEqual([`${member}|${mRegion}`]);
    serveScoped({ region: mRegion, clusters: [] });
    expect((await fetchEksIpMap(undefined, false, `accounts=${other}&regions=${mRegion}`)).coveredAccountRegions)
      .toEqual([`${other}|${mRegion}`]);
  });

  it('keys host clusters as self only when the listing identifies them as host', async () => {
    const hostArn = `arn:aws:eks:us-west-2:${other}:cluster/far`;
    const far = { ...memberCluster, id: hostArn, arn: hostArn, name: 'far', accountId: other, region: 'us-west-2', vpcId: 'vpc-far' };
    serveScoped({ clusters: [far] });
    expect((await fetchEksIpMap(undefined, false, 'accounts=self&regions=__all__')).coveredAccountRegions)
      .toEqual([`${other}|us-west-2`, 'self|us-west-2']);
    const bare = { ...memberCluster, id: 'home', arn: `arn:aws:eks:${mRegion}:${other}:cluster/home`, name: 'home', accountId: other };
    serveScoped({ clusters: [far, bare, memberCluster] });
    expect((await fetchEksIpMap(undefined, false, `accounts=__all__&regions=__all__`)).coveredAccountRegions)
      .toEqual([`${member}|${mRegion}`, `${other}|${mRegion}`, `${other}|us-west-2`, `self|${mRegion}`, 'self|us-west-2'].sort());
    serveScoped({ clusters: [far, memberCluster] });
    expect((await fetchEksIpMap(undefined, false, `accounts=__all__&regions=__all__`)).coveredAccountRegions)
      .toEqual([`${member}|${mRegion}`, `${other}|us-west-2`].sort());
  });

  it('refuses a scoped row without a valid account id', async () => {
    for (const accountId of [undefined, '', 'acct']) {
      serveScoped({ region: mRegion, clusters: [{ ...memberCluster, accountId }] });
      expect(await fetchEksIpMap(undefined, false, `accounts=${member}&regions=${mRegion}`))
        .toMatchObject({ globalUnknown: true, status: 'unavailable' });
    }
  });

  it('drops only the bindings of a blocked region|vpc scope and names the blocked clusters (partial)', async () => {
    const legacyArn = `arn:aws:eks:${mRegion}:${member}:cluster/legacy`;
    const legacy = { ...memberCluster, id: legacyArn, arn: legacyArn, name: 'legacy', vpcId: 'vpc-legacy', access: 'no-entry' };
    serveScoped({ clusters: [memberCluster, legacy] });
    const result = await fetchEksIpMap(undefined, true, `accounts=${member}&regions=${mRegion}`);
    expect(result.bindingRead).toEqual({ status: 'partial', reasons: ['binding_scope_blocked'], blockedClusters: [legacyArn] });
    expect(result.bindings?.map(b => b.authority)).toEqual([memberArn]);
    expect(result.blockedScopes).toEqual([scopedTargetIp(mRegion, 'vpc-legacy', '')]);
    expect(result.map[scopedTargetIp(mRegion, mVpc, ip)]).toMatchObject({ resolved: 'eks' });
    // Sharing the VPC with the blocked cluster: that scope's bindings are dropped too (it could hold the IP).
    serveScoped({ clusters: [memberCluster, { ...legacy, vpcId: mVpc }] });
    const shared = await fetchEksIpMap(undefined, true, `accounts=${member}&regions=${mRegion}`);
    expect(shared.bindingRead).toMatchObject({ status: 'partial', blockedClusters: [legacyArn] });
    expect(shared.bindings).toEqual([]);
    expect(shared.map[scopedTargetIp(mRegion, mVpc, ip)]).toBeNull();
    // A blocked target still reads as an unresolved EKS scope in the flow graph, never as "not a pod".
    const graph = buildFlowGraph({ ipResolved: shared.map, ownershipRead: { eksScopes: shared.blockedScopes,
      eksAccountRegions: shared.coveredAccountRegions }, tg: [{ resource_id: 'tg', account_id: member, region: mRegion, vpc_id: mVpc,
      target_type: 'ip', target_health_descriptions: [{ Target: { Id: ip, Port: 80 } }] }] });
    expect(graph.nodes.find(n => n.kind === 'target')?.meta?.ambiguity).toBe('eks_inventory_incomplete');
  });

  it('keeps the unscoped default path withholding every binding when any cluster is blocked', async () => {
    const hostArn = `arn:aws:eks:${region}:${other}:cluster/host-cluster`;
    serveScoped({ region, clusters: [{ ...cluster, id: hostArn, arn: hostArn, accountId: other },
      { ...cluster, name: 'offline', id: 'offline', vpcId: 'vpc-offline', access: 'no-entry' }] });
    const result = await fetchEksIpMap(undefined, true);
    expect(result.bindingRead).toEqual({ status: 'withheld', reasons: ['binding_read_incomplete'] });
    expect(result.bindings).toBeUndefined();
    expect(result.map[scopedTargetIp(region, vpcId, ip)]).toMatchObject({ resolved: 'eks' });
  });

  it('keeps global withholding for listing errors and partial pod reads alongside a blocked scope', async () => {
    const legacyArn = `arn:aws:eks:${mRegion}:${member}:cluster/legacy`;
    const legacy = { ...memberCluster, id: legacyArn, arn: legacyArn, name: 'legacy', vpcId: 'vpc-legacy', access: 'no-entry' };
    serveScoped({ clusters: [memberCluster, legacy], status: 'partial' });
    expect((await fetchEksIpMap(undefined, true, `accounts=${member}&regions=${mRegion}`)).bindingRead)
      .toEqual({ status: 'withheld', reasons: ['binding_read_incomplete'] });
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/eks') return json({ clusters: [memberCluster, legacy] });
      if (url.searchParams.get('kind') === 'pods') return json({ kind: 'pods', rows: [memberPod], status: 'partial', generatedAt: '2026-11-18T00:00:00Z' });
      return json({ kind: 'endpoints', rows: [] });
    }));
    expect((await fetchEksIpMap(undefined, true, `accounts=${member}&regions=${mRegion}`)).bindingRead)
      .toEqual({ status: 'withheld', reasons: ['binding_read_incomplete'] });
  });

  describe('per-account scope queries', () => {
    const westArn = `arn:aws:eks:us-west-2:${other}:cluster/west`;
    const west = { ...memberCluster, id: westArn, arn: westArn, name: 'west', accountId: other, region: 'us-west-2', vpcId: 'vpc-west' };
    function serveByQuery(byQuery: (q: URLSearchParams) => Response) {
      const f = vi.fn(async (input: string) => {
        const url = new URL(input, 'http://localhost');
        if (url.pathname === '/api/eks') return byQuery(url.searchParams);
        if (url.searchParams.get('kind') === 'pods') {
          const cl = decodeURIComponent(url.pathname.split('/')[3]);
          return json({ kind: 'pods', rows: [{ ...memberPod, uid: `uid-${cl}` }], generatedAt: '2026-11-18T00:00:00Z' });
        }
        if (url.searchParams.get('kind') === 'endpoints') return json({ kind: 'endpoints', rows: [] });
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', f);
      return f;
    }
    const listing = (q: URLSearchParams) => {
      const account = q.get('accounts'), r = q.get('regions');
      const rows = [memberCluster, west].filter(c => c.accountId === account && c.region === r);
      return json({ region: r, clusters: rows, errors: [] });
    };

    it('lists each account in its own regions and merges the clusters (no cross product)', async () => {
      const f = serveByQuery(listing);
      const result = await fetchEksIpMap(undefined, true,
        [`accounts=${member}&regions=${mRegion}&includeGlobal=1`, `accounts=${other}&regions=us-west-2&includeGlobal=1`]);
      const lists = requested(f).filter(u => u.startsWith('/api/eks?'));
      expect(lists).toEqual([`/api/eks?accounts=${member}&regions=${mRegion}&includeGlobal=1`,
        `/api/eks?accounts=${other}&regions=us-west-2&includeGlobal=1`]);
      expect(result.status).toBe('ok');
      expect(result.coveredRegions).toEqual([mRegion, 'us-west-2']);
      expect(result.coveredAccountRegions).toEqual([`${member}|${mRegion}`, `${other}|us-west-2`].sort());
      expect(result.map[scopedTargetIp(mRegion, mVpc, ip)]).toMatchObject({ resolved: 'eks' });
      expect(result.map[scopedTargetIp('us-west-2', 'vpc-west', ip)]).toMatchObject({ resolved: 'eks', meta: { cluster: 'west' } });
      expect(result.bindingRead).toEqual({ status: 'ok', reasons: [] });
      expect(result.bindings?.map(b => b.authority).sort()).toEqual([memberArn, westArn].sort());
    });

    it('fails the whole read when any sub-listing fails, errors or truncates', async () => {
      for (const bad of [json({ status: 'error' }, 403), json({ clusters: [west], truncated: true }),
        json({ clusters: [west], errors: [{ accountId: other, region: 'us-west-2', message: 'x', reason: 'denied' }] })]) {
        serveByQuery((q) => (q.get('accounts') === other ? bad.clone() : listing(q)));
        expect(await fetchEksIpMap(undefined, true, [`accounts=${member}&regions=${mRegion}`, `accounts=${other}&regions=us-west-2`]))
          .toMatchObject({ map: {}, globalUnknown: true, bindingRead: { status: 'withheld' } });
      }
    });

    it('applies duplicate-IP vetoes across accounts (shared VPC) and dedupes a cluster listed twice', async () => {
      const sharedArn = `arn:aws:eks:${mRegion}:${other}:cluster/shared`;
      const shared = { ...memberCluster, id: sharedArn, arn: sharedArn, name: 'shared', accountId: other };
      const f = serveByQuery((q) => json({ region: mRegion,
        clusters: q.get('accounts') === member ? [memberCluster] : [shared, memberCluster], errors: [] }));
      const result = await fetchEksIpMap(undefined, true, [`accounts=${member}&regions=${mRegion}`, `accounts=${other}&regions=${mRegion}`]);
      expect(result.map[scopedTargetIp(mRegion, mVpc, ip)]).toBeNull();
      expect(requested(f).filter(u => u === `/api/eks/${encodeURIComponent(memberArn)}/incluster?kind=pods`)).toHaveLength(1);
    });
  });

  it('cannot certify coverage for a multi-target listing with no clusters', async () => {
    serveScoped({ clusters: [] });
    expect(await fetchEksIpMap(undefined, false, `accounts=${member},${other}&regions=${mRegion}`))
      .toMatchObject({ map: {}, globalUnknown: true, status: 'unavailable' });
  });
});
