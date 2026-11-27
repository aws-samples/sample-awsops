import { describe, it, expect } from 'vitest';
import { buildServiceGraph, filterGraphInputByNamespace, serviceDetail, SYSTEM_NAMESPACES, type GraphInput } from './k8s-service-graph';
import { nodeReadyText, type PodRow, type NodeRow } from './eks-resources';
import type { TraceOverlay, TraceWorkloadCall } from './k8s-trace-overlay';

const pod = (over: Partial<PodRow> & Pick<PodRow, 'name' | 'namespace'>): PodRow => ({
  status: 'Running', node: 'node-a', restarts: 0, age: '1h', cpuRequest: 0, memRequest: 0, diskRequest: 0, ...over,
});
const node = (over: Partial<NodeRow> & Pick<NodeRow, 'name'>): NodeRow => ({
  status: 'Ready', roles: '', version: 'v1.31', instanceType: 'm7g.large', zone: 'apne2-a', age: '9d',
  cpuCapacity: 4, cpuAllocatable: 4, memCapacity: 16384, memAllocatable: 15000, diskCapacity: 0, diskAllocatable: 0, ...over,
});

const RDS_HOST = 'orders.cluster-abc.ap-northeast-2.rds.amazonaws.com';
const CACHE_HOST = 'sessions.xyz.apne2.cache.amazonaws.com';
const ORDERS_DS = 'ds:rds_cluster:111111111111:ap-northeast-2:orders';

const base = (): GraphInput => ({
  ingresses: [{ name: 'web', namespace: 'prod', className: 'alb', lbHostname: 'k8s-x.elb.amazonaws.com', backends: [{ service: 'api', port: '8080' }, { service: 'api', port: '9090' }], age: '1h' }],
  services: [
    { name: 'api', namespace: 'prod', type: 'ClusterIP', clusterIP: '172.20.0.10', ports: '8080/TCP', age: '1h' },
    { name: 'api', namespace: 'dev', type: 'ClusterIP', clusterIP: '172.20.9.9', ports: '8080/TCP', age: '1h' },
    { name: 'idle', namespace: 'prod', type: 'ClusterIP', clusterIP: '172.20.0.11', ports: '80/TCP', age: '1h' },
    { name: 'kube-dns', namespace: 'kube-system', type: 'ClusterIP', clusterIP: '172.20.0.2', ports: '53/UDP', age: '9d' },
  ],
  endpoints: [
    { name: 'api', namespace: 'prod', ips: ['10.0.2.10'], targets: [{ ip: '10.0.2.10', pod: 'api-7d9-abc' }] },
  ],
  pods: [
    pod({ name: 'api-7d9-abc', namespace: 'prod', podIP: '10.0.2.10', workload: 'api', node: 'node-a' }),
    pod({ name: 'api-7d9-def', namespace: 'dev', podIP: '10.0.2.10', workload: 'api', node: 'node-a' }),
    pod({ name: 'api-7d9-unready', namespace: 'prod', podIP: '10.0.2.12', workload: 'api', node: 'node-b', status: 'Pending' }),
  ],
  nodes: [node({ name: 'node-a' }), node({ name: 'node-b' })],
  dbRefs: [
    { workload: { namespace: 'prod', name: 'api' }, via: 'env', host: RDS_HOST, kind: 'rds',
      resource: { type: 'rds_cluster', id: 'orders', region: 'ap-northeast-2', accountId: '111111111111' } },
    { workload: { namespace: 'prod', name: 'api' }, via: 'configmap', host: CACHE_HOST, kind: 'elasticache', resource: null },
    // dev/api has no Endpoints: its ref must not attach to any service
    { workload: { namespace: 'dev', name: 'api' }, via: 'env', host: RDS_HOST, kind: 'rds', resource: null },
  ],
  secretRefs: [
    { workload: { namespace: 'prod', name: 'api' }, secret: 'db-password' },
    { workload: { namespace: 'prod', name: 'api' }, secret: 'api-key' },
    { workload: { namespace: 'dev', name: 'api' }, secret: 'dev-only' },
  ],
  trace: null,
  dns: [],
});

const edge = (g: ReturnType<typeof buildServiceGraph>, s: string, t: string) =>
  g.edges.find((e) => e.source === s && e.target === t);

describe('buildServiceGraph', () => {
  it('draws one ingress→service routing edge per backend service', () => {
    const g = buildServiceGraph(base());
    expect(g.nodes.find((n) => n.id === 'gw:prod/web')).toMatchObject({ kind: 'gateway', namespace: 'prod', label: 'web' });
    expect(edge(g, 'gw:prod/web', 'svc:prod/api')?.evidence).toEqual(['routing']);
    expect(g.edges.filter((e) => e.source === 'gw:prod/web')).toHaveLength(1);
    expect(edge(g, 'gw:prod/web', 'svc:dev/api')).toBeUndefined();
  });

  it('links service→datastore via Endpoints targetRef pod → workload → DB ref (config evidence)', () => {
    const g = buildServiceGraph(base());
    const rds = edge(g, 'svc:prod/api', ORDERS_DS);
    expect(rds?.evidence).toEqual(['config']);
    expect(g.nodes.find((n) => n.id === ORDERS_DS)).toMatchObject({ kind: 'datastore', label: 'orders', namespace: null });
    expect(g.nodes.find((n) => n.id === 'svc:prod/api')?.meta).toMatchObject({ podCount: 1, workloads: ['api'] });
  });

  it('labels an unresolved host datastore by host with meta.unresolved', () => {
    const g = buildServiceGraph(base());
    const ds = g.nodes.find((n) => n.id === `ds:elasticache:${CACHE_HOST}`);
    expect(ds).toMatchObject({ kind: 'datastore', label: CACHE_HOST });
    expect(ds?.meta.unresolved).toBe(true);
    expect(g.nodes.find((n) => n.id === ORDERS_DS)?.meta.unresolved).toBe(false);
    expect(edge(g, 'svc:prod/api', `ds:elasticache:${CACHE_HOST}`)?.evidence).toEqual(['config']);
  });

  it('keeps a Service without Endpoints as an unlinked node', () => {
    const g = buildServiceGraph(base());
    expect(g.nodes.find((n) => n.id === 'svc:prod/idle')).toMatchObject({ kind: 'service', namespace: 'prod' });
    expect(g.edges.some((e) => e.source === 'svc:prod/idle' || e.target === 'svc:prod/idle')).toBe(false);
  });

  it('gives same-named Services in two namespaces distinct ids and no cross-namespace joins', () => {
    const g = buildServiceGraph(base());
    const ids = g.nodes.filter((n) => n.kind === 'service').map((n) => n.id);
    expect(ids).toContain('svc:prod/api');
    expect(ids).toContain('svc:dev/api');
    // dev/api has no Endpoints: the prod pod sharing the same IP and the dev DB ref never attach
    expect(g.edges.some((e) => e.source === 'svc:dev/api')).toBe(false);
    expect(g.nodes.find((n) => n.id === 'svc:dev/api')?.meta).toMatchObject({ podCount: 0, workloads: [] });
  });

  it('does not link hostNetwork pods sharing an IP by guessing', () => {
    const input = base();
    input.endpoints = [{ name: 'api', namespace: 'prod', ips: ['10.0.9.1'], targets: [{ ip: '10.0.9.1' }] }];
    input.pods.push(
      pod({ name: 'agent-a', namespace: 'prod', podIP: '10.0.9.1', hostNetwork: true, workload: 'api' }),
      pod({ name: 'agent-b', namespace: 'prod', podIP: '10.0.9.1', hostNetwork: true, workload: 'other' }),
    );
    const g = buildServiceGraph(input);
    expect(g.nodes.find((n) => n.id === 'svc:prod/api')?.meta).toMatchObject({ podCount: 0, workloads: [] });
    expect(g.edges.some((e) => e.source === 'svc:prod/api')).toBe(false);
    expect(serviceDetail(g, input, 'svc:prod/api').pods).toEqual([]);
  });

  it('never IP-joins to a hostNetwork pod even when it is the only pod with that IP', () => {
    const input = base();
    input.endpoints = [{ name: 'api', namespace: 'prod', ips: ['10.0.9.1'], targets: [{ ip: '10.0.9.1' }] }];
    input.pods.push(pod({ name: 'agent-a', namespace: 'prod', podIP: '10.0.9.1', hostNetwork: true, workload: 'api' }));
    expect(buildServiceGraph(input).nodes.find((n) => n.id === 'svc:prod/api')?.meta.podCount).toBe(0);
  });

  it('falls back to the IP join when the IP maps to exactly one non-hostNetwork pod', () => {
    const input = base();
    input.endpoints = [{ name: 'api', namespace: 'prod', ips: ['10.0.2.10'], targets: [{ ip: '10.0.2.10' }] }];
    const g = buildServiceGraph(input);
    expect(g.nodes.find((n) => n.id === 'svc:prod/api')?.meta.podCount).toBe(1);
    expect(edge(g, 'svc:prod/api', ORDERS_DS)).toBeDefined();
  });

  it('does not link an unready pod absent from Endpoints', () => {
    const detail = serviceDetail(buildServiceGraph(base()), base(), 'svc:prod/api');
    expect(detail.pods.map((p) => p.name)).toEqual(['api-7d9-abc']);
  });

  it('never creates an edge from a Secret ref', () => {
    const input = base();
    input.dbRefs = [];
    const g = buildServiceGraph(input);
    expect(g.edges.filter((e) => e.source === 'svc:prod/api')).toEqual([]);
    expect(g.nodes.some((n) => n.kind === 'datastore')).toBe(false);
  });

  it('flags SYSTEM_NAMESPACES as system and lists serviceIds per namespace', () => {
    expect([...SYSTEM_NAMESPACES].sort()).toEqual(['kube-node-lease', 'kube-public', 'kube-system']);
    const g = buildServiceGraph(base());
    expect(g.namespaces).toEqual([
      { name: 'dev', serviceIds: ['svc:dev/api'], system: false },
      { name: 'kube-system', serviceIds: ['svc:kube-system/kube-dns'], system: true },
      { name: 'prod', serviceIds: ['svc:prod/api', 'svc:prod/idle'], system: false },
    ]);
  });

  it('is deterministic: nodes and edges sorted by id regardless of input order', () => {
    const a = buildServiceGraph(base());
    const shuffled = base();
    shuffled.services.reverse(); shuffled.pods.reverse(); shuffled.dbRefs.reverse(); shuffled.ingresses.reverse();
    const b = buildServiceGraph(shuffled);
    expect(b).toEqual(a);
    const ids = a.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
    const eids = a.edges.map((e) => e.id);
    expect(eids).toEqual([...eids].sort());
    expect(new Set(eids).size).toBe(eids.length);
  });

  it('notes datastore refs from workloads not behind any Service instead of drawing them', () => {
    const g = buildServiceGraph(base());
    // dev/api's ref has no fronting Service → not drawn, disclosed once
    expect(g.nodes.some((n) => n.id === `ds:rds:${RDS_HOST}`)).toBe(false);
    expect(g.notes).toHaveLength(1);
    expect(g.notes[0]).toContain('1');
  });

  it('draws no trace edges for an empty overlay (dns handled separately)', () => {
    const input = base();
    input.trace = { available: true, workloadCalls: [], omitted: 0 };
    const g = buildServiceGraph(input);
    expect(g.edges.some((e) => e.evidence.includes('trace'))).toBe(false);
  });

  it('keeps same-id resources in different regions or accounts as separate nodes, independent of input order', () => {
    const input = base();
    input.dbRefs.push(
      { workload: { namespace: 'prod', name: 'api' }, via: 'env', host: 'orders.cluster-xyz.us-west-2.rds.amazonaws.com', kind: 'rds',
        resource: { type: 'rds_cluster', id: 'orders', region: 'us-west-2', accountId: '111111111111' } },
      { workload: { namespace: 'prod', name: 'api' }, via: 'env', host: 'orders.cluster-other.ap-northeast-2.rds.amazonaws.com', kind: 'rds',
        resource: { type: 'rds_cluster', id: 'orders', region: 'ap-northeast-2', accountId: '222222222222' } },
    );
    const g = buildServiceGraph(input);
    expect(g.nodes.filter((n) => n.kind === 'datastore' && n.meta.unresolved === false).map((n) => n.id)).toEqual([
      ORDERS_DS, 'ds:rds_cluster:111111111111:us-west-2:orders', 'ds:rds_cluster:222222222222:ap-northeast-2:orders',
    ]);
    const west = g.nodes.find((n) => n.id === 'ds:rds_cluster:111111111111:us-west-2:orders');
    expect(west?.meta).toMatchObject({ region: 'us-west-2', accountId: '111111111111', hosts: ['orders.cluster-xyz.us-west-2.rds.amazonaws.com'] });
    expect(west?.sub).toBe('rds_cluster · us-west-2');
    expect(buildServiceGraph({ ...input, dbRefs: [...input.dbRefs].reverse() })).toEqual(g);
  });

  it('merges two hosts of one resolved resource into one node regardless of order', () => {
    const input = base();
    const reader = 'orders.cluster-ro-abc.ap-northeast-2.rds.amazonaws.com';
    input.dbRefs.push({ workload: { namespace: 'prod', name: 'api' }, via: 'env', host: reader, kind: 'rds',
      resource: { type: 'rds_cluster', id: 'orders', region: 'ap-northeast-2', accountId: '111111111111' } });
    const g = buildServiceGraph(input);
    const orders = g.nodes.filter((n) => n.id === ORDERS_DS);
    expect(orders).toHaveLength(1);
    expect(orders[0].meta.hosts).toEqual([RDS_HOST, reader]);
    expect(buildServiceGraph({ ...input, dbRefs: [...input.dbRefs].reverse() })).toEqual(g);
  });

  it('never lets a resolved id collide with an unresolved host id', () => {
    const input = base();
    input.dbRefs = [
      { workload: { namespace: 'prod', name: 'api' }, via: 'env', host: 'x.rds.amazonaws.com', kind: 'rds', resource: null },
      { workload: { namespace: 'prod', name: 'api' }, via: 'env', host: 'other.rds.amazonaws.com', kind: 'rds',
        resource: { type: 'rds', id: 'x.rds.amazonaws.com', region: 'ap-northeast-2', accountId: 'self' } },
    ];
    const g = buildServiceGraph(input);
    expect(g.nodes.find((n) => n.id === 'ds:rds:x.rds.amazonaws.com')?.meta.unresolved).toBe(true);
    expect(g.nodes.find((n) => n.id === 'ds:rds:self:ap-northeast-2:x.rds.amazonaws.com')?.meta.unresolved).toBe(false);
  });

  it('uses "-" for a missing region', () => {
    const input = base();
    input.dbRefs = [{ workload: { namespace: 'prod', name: 'api' }, via: 'env', host: 'db.a.rds.amazonaws.com', kind: 'rds',
      resource: { type: 'rds', id: 'db', region: null, accountId: 'self' } }];
    const g = buildServiceGraph(input);
    expect(g.nodes.find((n) => n.id === 'ds:rds:self:-:db')).toMatchObject({ sub: 'rds' });
  });
});

describe('buildServiceGraph trace overlay', () => {
  // prod/web (pod web-1) fronts workload `web`; prod/api fronts workload `api` (base fixture).
  const withWeb = (): GraphInput => {
    const input = base();
    input.services.push({ name: 'web', namespace: 'prod', type: 'ClusterIP', clusterIP: '172.20.0.12', ports: '80/TCP', age: '1h' });
    input.endpoints.push({ name: 'web', namespace: 'prod', ips: ['10.0.2.20'], targets: [{ ip: '10.0.2.20', pod: 'web-1' }] });
    input.pods.push(pod({ name: 'web-1', namespace: 'prod', podIP: '10.0.2.20', workload: 'web' }));
    return input;
  };
  const call = (from: string, to: { workload: string } | { datastoreHost: string }, spanCount?: number): TraceWorkloadCall => ({
    fromWorkload: { namespace: 'prod', name: from },
    to: 'workload' in to ? { workload: { namespace: 'prod', name: to.workload } } : to,
    ...(spanCount !== undefined ? { spanCount } : {}),
  });
  const overlay = (workloadCalls: TraceWorkloadCall[], over: Partial<TraceOverlay> = {}): TraceOverlay =>
    ({ available: true, workloadCalls, omitted: 0, skipped: 0, ...over });

  it('maps an overlay workload call to a service → service edge with trace evidence', () => {
    const input = withWeb();
    input.trace = overlay([call('web', { workload: 'api' }, 7)]);
    const g = buildServiceGraph(input);
    expect(edge(g, 'svc:prod/web', 'svc:prod/api')?.evidence).toEqual(['trace']);
    expect(g.notes).toHaveLength(1); // only the pre-existing unlinked-ref note
  });

  it('merges a trace call with the existing config edge for the same pair as [trace, config]', () => {
    const input = withWeb();
    input.trace = overlay([call('api', { datastoreHost: RDS_HOST })]);
    const g = buildServiceGraph(input);
    expect(edge(g, 'svc:prod/api', ORDERS_DS)?.evidence).toEqual(['trace', 'config']);
    expect(g.nodes.filter((n) => n.kind === 'datastore')).toHaveLength(2);
  });

  it('adds an unresolved datastore node for a trace-only managed host', () => {
    const input = withWeb();
    const host = 'audit.abc.ap-northeast-2.rds.amazonaws.com';
    input.trace = overlay([call('web', { datastoreHost: host })]);
    const g = buildServiceGraph(input);
    expect(g.nodes.find((n) => n.id === `ds:rds:${host}`)).toMatchObject({ kind: 'datastore', label: host, meta: { unresolved: true, hosts: [host] } });
    expect(edge(g, 'svc:prod/web', `ds:rds:${host}`)?.evidence).toEqual(['trace']);
  });

  it('creates no datastore node for an unmapped trace call to a new managed host, and counts it', () => {
    const input = withWeb();
    const host = 'audit.abc.ap-northeast-2.rds.amazonaws.com';
    input.trace = overlay([call('ghost', { datastoreHost: host })]);
    const g = buildServiceGraph(input);
    expect(g.nodes.some((n) => n.id === `ds:rds:${host}`)).toBe(false);
    expect(g.nodes.filter((n) => n.kind === 'datastore')).toHaveLength(2);
    expect(g.notes.find((n) => n.includes('trace'))).toContain('1');
  });

  it('creates the node once when a mapped call reaches the same host after an unmapped one', () => {
    const input = withWeb();
    const host = 'audit.abc.ap-northeast-2.rds.amazonaws.com';
    input.trace = overlay([call('ghost', { datastoreHost: host }), call('web', { datastoreHost: host })]);
    const g = buildServiceGraph(input);
    expect(g.nodes.find((n) => n.id === `ds:rds:${host}`)?.meta).toMatchObject({ unresolved: true, hosts: [host] });
    expect(edge(g, 'svc:prod/web', `ds:rds:${host}`)?.evidence).toEqual(['trace']);
    expect(g.notes.find((n) => n.includes('trace'))).toContain('1');
  });

  it('skips a trace call whose workload is fronted by two Services and counts it in notes (never guessed)', () => {
    const input = withWeb();
    input.services.push({ name: 'api-alt', namespace: 'prod', type: 'ClusterIP', clusterIP: '172.20.0.13', ports: '8080/TCP', age: '1h' });
    input.endpoints.push({ name: 'api-alt', namespace: 'prod', ips: ['10.0.2.10'], targets: [{ ip: '10.0.2.10', pod: 'api-7d9-abc' }] });
    input.trace = overlay([call('web', { workload: 'api' }), call('api', { workload: 'web' }), call('ghost', { workload: 'api' })]);
    const g = buildServiceGraph(input);
    expect(g.edges.some((e) => e.evidence.includes('trace'))).toBe(false);
    // Config evidence is workload-level and still attaches to both Services.
    expect(edge(g, 'svc:prod/api-alt', ORDERS_DS)?.evidence).toEqual(['config']);
    const note = g.notes.find((n) => n.includes('trace'));
    expect(note).toContain('3');
  });

  it('adds the overlay-skipped count to the same note and discloses an incomplete read', () => {
    const input = withWeb();
    input.trace = overlay([], { skipped: 2 });
    expect(buildServiceGraph(input).notes.find((n) => n.includes('trace'))).toContain('2');
    input.trace = overlay([], { omitted: 9 });
    expect(buildServiceGraph(input).notes.find((n) => n.includes('trace'))).toContain('9');
  });

  it('draws nothing and adds no note for an unavailable overlay', () => {
    const input = withWeb();
    input.trace = { available: false, reason: 'ambiguous_cluster', workloadCalls: [call('web', { workload: 'api' })], omitted: 0 };
    const g = buildServiceGraph(input);
    expect(g.edges.some((e) => e.evidence.includes('trace'))).toBe(false);
    expect(g.notes).toHaveLength(1);
  });
});

describe('serviceDetail', () => {
  it('returns the service pods, their nodes, callers, datastores and secret names', () => {
    const input = base();
    const g = buildServiceGraph(input);
    const d = serviceDetail(g, input, 'svc:prod/api');
    expect(d.pods.map((p) => p.name)).toEqual(['api-7d9-abc']);
    expect(d.nodes.map((n) => n.name)).toEqual(['node-a']);
    expect(d.nodes[0].readyText).toBe('Ready');
    expect(d.callers.map((n) => n.id)).toEqual(['gw:prod/web']);
    expect(d.callees).toEqual([]);
    expect(d.datastores.map((n) => n.id)).toEqual([`ds:elasticache:${CACHE_HOST}`, ORDERS_DS]);
    expect(d.secretRefs).toEqual(['api-key', 'db-password']);
  });

  it('uses nodeReadyText for aws-api (EC2/node-group) rows', () => {
    const input = base();
    input.nodes = [node({ name: 'node-a', status: 'EC2 running', source: 'aws-api' })];
    const d = serviceDetail(buildServiceGraph(input), input, 'svc:prod/api');
    expect(d.nodes[0].readyText).toBe(nodeReadyText(input.nodes[0]));
    expect(d.nodes[0].readyText).toBe('EC2 running · Ready unknown');
  });

  it('matches aws-api node rows to pods that reference the node by instance id', () => {
    const input = base();
    input.pods[0] = { ...input.pods[0], node: 'i-0abc' };
    input.nodes = [
      node({ name: 'ip-10-0-1-1.ec2.internal', status: 'EC2 running', source: 'aws-api', instanceId: 'i-0abc' }),
      node({ name: 'ip-10-0-1-2.ec2.internal', status: 'EC2 running', source: 'aws-api', instanceId: 'i-0def' }),
    ];
    const d = serviceDetail(buildServiceGraph(input), input, 'svc:prod/api');
    expect(d.nodes.map((n) => n.name)).toEqual(['ip-10-0-1-1.ec2.internal']);
    expect(d.nodes[0].readyText).toBe('EC2 running · Ready unknown');
  });

  it('returns an empty detail for an unknown or non-service id', () => {
    const input = base();
    const g = buildServiceGraph(input);
    for (const id of ['svc:nope/x', 'gw:prod/web']) {
      expect(serviceDetail(g, input, id)).toEqual({ pods: [], nodes: [], callers: [], callees: [], datastores: [], secretRefs: [] });
    }
  });
});

describe('DNS and LoadBalancer gateways (Task 8)', () => {
  const ELB = 'k8s-x.elb.amazonaws.com';
  const lbSvc = { name: 'edge', namespace: 'prod', type: 'LoadBalancer', clusterIP: '172.20.5.5', ports: '443/TCP', age: '1h', lbHostname: 'lb-svc.elb.amazonaws.com' };
  it('no dns records → no dns nodes', () => {
    expect(buildServiceGraph(base()).nodes.filter((n) => n.kind === 'dns')).toEqual([]);
  });
  it('matching record creates dns node + routing edge to the ingress gateway; non-match creates nothing', () => {
    const g = buildServiceGraph({ ...base(), dns: [
      { name: 'App.Example.com.', target: `${ELB}.` }, { name: 'other.example.com', target: 'nope.elb.amazonaws.com' },
    ] });
    const dns = g.nodes.filter((n) => n.kind === 'dns');
    expect(dns.map((n) => n.id)).toEqual(['dns:app.example.com']);
    expect(g.edges.find((e) => e.id.includes('dns:app.example.com'))).toMatchObject({ source: 'dns:app.example.com', target: 'gw:prod/web', evidence: ['routing'] });
  });
  it('several names → one gateway gives one node each', () => {
    const g = buildServiceGraph({ ...base(), dns: [{ name: 'a.example.com', target: ELB }, { name: 'b.example.com', target: ELB }] });
    expect(g.nodes.filter((n) => n.kind === 'dns')).toHaveLength(2);
  });
  it('LoadBalancer Service with hostname gets gw:lb gateway + edge; without hostname gets none', () => {
    const b = base();
    const g = buildServiceGraph({ ...b, services: [...b.services, lbSvc, { ...lbSvc, name: 'pending', lbHostname: undefined }] });
    expect(g.nodes.find((n) => n.id === 'gw:lb:prod/edge')).toMatchObject({ kind: 'gateway', label: 'edge', sub: 'lb-svc.elb.amazonaws.com' });
    expect(g.nodes.find((n) => n.id === 'gw:lb:prod/pending')).toBeUndefined();
    expect(g.edges.find((e) => e.source === 'gw:lb:prod/edge')).toMatchObject({ target: 'svc:prod/edge', evidence: ['routing'] });
  });
  it('LB Service gateway id never collides with an Ingress of the same name; dns links to it', () => {
    const b = base();
    const g = buildServiceGraph({ ...b, services: [...b.services, { ...lbSvc, name: 'web' }],
      dns: [{ name: 'lb.example.com', target: 'LB-SVC.elb.amazonaws.com.' }] });
    expect(g.nodes.find((n) => n.id === 'gw:prod/web')?.sub).toBe(ELB);
    expect(g.nodes.find((n) => n.id === 'gw:lb:prod/web')).toBeDefined();
    expect(g.edges.find((e) => e.source === 'dns:lb.example.com')?.target).toBe('gw:lb:prod/web');
  });
  it('two gateways sharing a host: dns links to both', () => {
    const b = base();
    const g = buildServiceGraph({ ...b, services: [...b.services, { ...lbSvc, lbHostname: ELB }], dns: [{ name: 'a.example.com', target: ELB }] });
    expect(g.edges.filter((e) => e.source === 'dns:a.example.com').map((e) => e.target).sort()).toEqual(['gw:lb:prod/edge', 'gw:prod/web']);
  });
  it('links a wildcard record to the gateway it targets', () => {
    const g = buildServiceGraph({ ...base(), dns: [{ name: '*.apps.example.com', target: ELB }] });
    expect(g.nodes.find((n) => n.id === 'dns:*.apps.example.com')).toBeDefined();
    expect(edge(g, 'dns:*.apps.example.com', 'gw:prod/web')?.evidence).toEqual(['routing']);
  });
});

describe('filterGraphInputByNamespace', () => {
  const traceTo = (calls: TraceWorkloadCall[]): TraceOverlay => ({ available: true, workloadCalls: calls, omitted: 0, skipped: 0 });
  const withTrace = (): GraphInput => ({ ...base(), trace: traceTo([
    { fromWorkload: { namespace: 'prod', name: 'api' }, to: { workload: { namespace: 'kube-system', name: 'coredns' } } },
    { fromWorkload: { namespace: 'kube-system', name: 'coredns' }, to: { workload: { namespace: 'prod', name: 'api' } } },
    { fromWorkload: { namespace: 'prod', name: 'api' }, to: { datastoreHost: RDS_HOST } },
  ]) });

  it('drops every namespaced row of a hidden namespace and keeps the rest untouched', () => {
    const f = filterGraphInputByNamespace(base(), (ns) => ns !== 'dev' && !SYSTEM_NAMESPACES.has(ns));
    expect(f.services.map((s) => `${s.namespace}/${s.name}`)).toEqual(['prod/api', 'prod/idle']);
    expect(f.pods.every((p) => p.namespace === 'prod')).toBe(true);
    expect(f.dbRefs.every((r) => r.workload.namespace === 'prod')).toBe(true);
    expect(f.secretRefs.map((r) => r.secret)).toEqual(['db-password', 'api-key']);
    expect(f.ingresses).toHaveLength(1);
    expect(f.nodes).toHaveLength(2); // nodes are cluster-scoped
    const g = buildServiceGraph(f);
    expect(g.namespaces.map((n) => n.name)).toEqual(['prod']);
    // the dev ref is dropped, not disclosed as an unlinked ref
    expect(g.notes.some((n) => /datastore reference/.test(n))).toBe(false);
  });

  it('drops trace calls that touch a hidden namespace instead of counting them as unmapped', () => {
    const f = filterGraphInputByNamespace(withTrace(), (ns) => !SYSTEM_NAMESPACES.has(ns));
    expect(f.trace?.workloadCalls).toEqual([{ fromWorkload: { namespace: 'prod', name: 'api' }, to: { datastoreHost: RDS_HOST } }]);
    expect(buildServiceGraph(f).notes.some((n) => /trace-observed/.test(n))).toBe(false);
  });

  it('keeps an unavailable or absent trace overlay as-is', () => {
    const off: TraceOverlay = { available: false, reason: 'ambiguous_cluster', workloadCalls: [], omitted: 0 };
    expect(filterGraphInputByNamespace({ ...base(), trace: off }, () => false).trace).toBe(off);
    expect(filterGraphInputByNamespace(base(), () => false).trace).toBeNull();
  });
});
