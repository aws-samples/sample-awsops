import { describe, it, expect } from 'vitest';
import { buildServiceGraph, serviceDetail, SYSTEM_NAMESPACES, type GraphInput } from './k8s-service-graph';
import { nodeReadyText, type PodRow, type NodeRow } from './eks-resources';

const pod = (over: Partial<PodRow> & Pick<PodRow, 'name' | 'namespace'>): PodRow => ({
  status: 'Running', node: 'node-a', restarts: 0, age: '1h', cpuRequest: 0, memRequest: 0, diskRequest: 0, ...over,
});
const node = (over: Partial<NodeRow> & Pick<NodeRow, 'name'>): NodeRow => ({
  status: 'Ready', roles: '', version: 'v1.31', instanceType: 'm7g.large', zone: 'apne2-a', age: '9d',
  cpuCapacity: 4, cpuAllocatable: 4, memCapacity: 16384, memAllocatable: 15000, diskCapacity: 0, diskAllocatable: 0, ...over,
});

const RDS_HOST = 'orders.cluster-abc.ap-northeast-2.rds.amazonaws.com';
const CACHE_HOST = 'sessions.xyz.apne2.cache.amazonaws.com';

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
    const rds = edge(g, 'svc:prod/api', 'ds:rds_cluster:orders');
    expect(rds?.evidence).toEqual(['config']);
    expect(g.nodes.find((n) => n.id === 'ds:rds_cluster:orders')).toMatchObject({ kind: 'datastore', label: 'orders', namespace: null });
    expect(g.nodes.find((n) => n.id === 'svc:prod/api')?.meta).toMatchObject({ podCount: 1, workloads: ['api'] });
  });

  it('labels an unresolved host datastore by host with meta.unresolved', () => {
    const g = buildServiceGraph(base());
    const ds = g.nodes.find((n) => n.id === `ds:elasticache:${CACHE_HOST}`);
    expect(ds).toMatchObject({ kind: 'datastore', label: CACHE_HOST });
    expect(ds?.meta.unresolved).toBe(true);
    expect(g.nodes.find((n) => n.id === 'ds:rds_cluster:orders')?.meta.unresolved).toBe(false);
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
    expect(edge(g, 'svc:prod/api', 'ds:rds_cluster:orders')).toBeDefined();
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

  it('ignores trace and dns content for now (no dns nodes, no trace edges)', () => {
    const input = base();
    input.dns = [{ name: 'shop.example.com', target: 'k8s-x.elb.amazonaws.com' }];
    input.trace = { available: true, omitted: 0 };
    const g = buildServiceGraph(input);
    expect(g.nodes.some((n) => n.kind === 'dns')).toBe(false);
    expect(g.edges.some((e) => e.evidence.includes('trace'))).toBe(false);
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
    expect(d.datastores.map((n) => n.id)).toEqual([`ds:elasticache:${CACHE_HOST}`, 'ds:rds_cluster:orders']);
    expect(d.secretRefs).toEqual(['api-key', 'db-password']);
  });

  it('uses nodeReadyText for aws-api (EC2/node-group) rows', () => {
    const input = base();
    input.nodes = [node({ name: 'node-a', status: 'EC2 running', source: 'aws-api' })];
    const d = serviceDetail(buildServiceGraph(input), input, 'svc:prod/api');
    expect(d.nodes[0].readyText).toBe(nodeReadyText(input.nodes[0]));
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
