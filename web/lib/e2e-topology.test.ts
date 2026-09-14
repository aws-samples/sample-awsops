import { describe, expect, it } from 'vitest';
import { buildFlowGraph } from './flow-topology';
import type { FlowGraph, FlowNode } from './flow-topology';
import type { E2eGraph, E2eInput, NetworkObservation, ServiceSnapshot } from './e2e-topology-types';
import type { NfmEndpoint, NfmFlowRow } from './nfm';
import { buildE2eGraph, selectE2eGraph } from './e2e-topology';
import { loadNetworkObservations } from './topology-observations';
import { buildTraceGraph } from './trace-graph';

const REGION = 'ap-northeast-2';
const VPC = 'vpc-app';
const CAPTURED_AT = '2026-09-11T09:00:00Z';

function endpoint(overrides: Partial<NfmEndpoint> = {}): NfmEndpoint {
  return { ip: '10.0.1.10', region: REGION, vpcId: VPC, ...overrides };
}

function flow(overrides: Partial<NfmFlowRow> = {}): NfmFlowRow {
  return {
    local: endpoint(), remote: endpoint({ ip: '10.0.2.20' }),
    value: 123, unit: 'Bytes', category: 'INTER_AZ',
    traversed: [], traversedIds: [], ...overrides,
  };
}

function observation(rows: NfmFlowRow[] = [flow()], overrides: Partial<NetworkObservation> = {}): NetworkObservation {
  return {
    monitor: 'nfm-eks-app', cluster: 'app', metric: 'DATA_TRANSFERRED',
    category: 'INTER_AZ', rangeSec: 900, rows, unit: 'Bytes', capped: false,
    startTime: '2026-09-11T09:00:00Z', endTime: '2026-09-11T09:15:00Z',
    queriedAt: '2026-09-11T09:15:03Z', ...overrides,
  };
}

function target(meta: Record<string, unknown> = {}, id = 'target:web'): FlowNode {
  return { id, kind: 'target', label: 'web', meta: { targetType: 'ip', id: '10.0.1.10', ...meta } };
}

function configured(
  targets: FlowNode[] = [target()],
  scope: Record<string, unknown> = { region: REGION, vpc_id: VPC },
): FlowGraph {
  return {
    nodes: [{ id: 'tg:web', kind: 'tg', label: 'web-tg', meta: { row: scope } }, ...targets],
    edges: targets.map(t => ({ id: `tg-to-${t.id}`, source: 'tg:web', target: t.id, confidence: 'observed' })),
  };
}

function services(overrides: Record<string, unknown> = {}): ServiceSnapshot {
  return {
    nodes: [
      { id: 'svc:web', kind: 'svc', label: 'web', meta: { source: 'trace' } },
      { id: 'wl:web', kind: 'workload', label: 'web deployment',
        meta: { cluster: 'app', namespace: 'shop', pods: ['web-1', 'web-2'], ...overrides } },
    ],
    edges: [{ source: 'svc:web', target: 'wl:web', rel: 'runs_on', confidence: 'observed' }],
    captured_at: CAPTURED_AT,
  };
}

function input(overrides: Partial<E2eInput> = {}): E2eInput {
  return { account: 'self', configured: { nodes: [], edges: [] }, services: null, network: [], ...overrides };
}

const identityEdges = (graph: E2eGraph) => graph.edges.filter(e => e.evidence === 'identity');
const ids = (graph: { nodes: { id: string }[] }) => new Set(graph.nodes.map(n => n.id));
const labels = (graph: { nodes: { label: string }[] }) => graph.nodes.map(n => n.label);

function expectNoDanglingEdges(graph: { nodes: { id: string }[]; edges: { source: string; target: string }[] }) {
  const present = ids(graph);
  for (const edge of graph.edges) {
    expect(present.has(edge.source)).toBe(true);
    expect(present.has(edge.target)).toBe(true);
  }
}

describe('buildE2eGraph — evidence and provenance', () => {
  it.each([['instance', 'i-cache'], ['ip', '10.0.1.10']])(
    'keeps cached %s targets out of identity evidence while preserving live scoped joins', (type, id) => {
      const network = [observation([flow({ local: endpoint(type === 'instance' ? { instanceId: id } : {}) })])];
      const live = buildE2eGraph(input({ configured: configured([target({ targetType: type, id })]), network }));
      expect(identityEdges(live)).toHaveLength(1);
      const cached = buildFlowGraph({ ownershipRead: { configurationOnly: true }, tg: [{
        resource_id: 'tg-cache', region: REGION, vpc_id: VPC, target_type: type,
        target_health_descriptions: [{ Target: { Id: id } }],
      }] });
      const graph = buildE2eGraph(input({ configured: cached, network }));
      expect(identityEdges(graph)).toHaveLength(0);
      expect(graph.summary.ambiguousEndpoints).toBeGreaterThan(0);
    });

  it('does not promote materialized configuration into exclusive identity evidence', () => {
    const graph = buildE2eGraph(input({ configured: configured([target({ ownership_evidence: 'cached_configuration' })]),
      network: [observation()] }));
    expect(identityEdges(graph)).toHaveLength(0);
    expect(graph.summary.ambiguousEndpoints).toBeGreaterThan(0);
  });
  it.each([false, true])('distinguishes actual failed and successful empty batches at the graph boundary: failure=%s', async failed => {
    const batch = await loadNetworkObservations({
      monitor: 'nfm-eks-app', metric: 'DATA_TRANSFERRED', category: 'INTRA_AZ', rangeSec: 900,
    }, { name: 'nfm-eks-app', cluster: 'app', status: 'ACTIVE' }, {
      fetch: (async () => Response.json(failed ? { message: 'Unavailable' } : {
        monitor: 'nfm-eks-app', metric: 'DATA_TRANSFERRED', category: 'INTRA_AZ', range: 900,
        rows: [], unit: 'Bytes', capped: false, startTime: '2026-09-11T11:45:00Z', endTime: '2026-09-11T12:00:00Z',
      }, { status: failed ? 503 : 200 })) as typeof fetch,
    });
    const graph = buildE2eGraph(input({ network: batch.observations, networkCoverage: batch }));
    expect(graph.summary.networkFlows).toBe(0);
    expect(graph.coverage.network).toMatchObject({
      status: failed ? 'partial' : 'complete', failedCategories: failed ? ['INTRA_AZ'] : [],
      errors: failed ? { INTRA_AZ: 'query_failed' } : {},
    });
    expect(buildE2eGraph(input()).coverage.network.status).toBe('unknown');
  });

  it('cannot label a supplied observation with an unknown window as a complete batch', () => {
    const graph = buildE2eGraph(input({ network: [observation([], { startTime: undefined })],
      networkCoverage: { status: 'complete', failedCategories: [], cappedCategories: [], errors: {} } }));
    expect(graph.coverage.network.status).toBe('partial');
  });

  it('retains service quality and capped observations without claiming unknown failed categories were successful', () => {
    const collection = { status: 'partial', stale: true, retainedPrevious: true,
      sources: [{ sourceId: 'clickhouse:7', status: 'partial', reasons: ['cap_reached'], itemCount: 1000 }] };
    const graph = buildE2eGraph(input({
      services: { ...services(), collection }, network: [observation([], { capped: true })],
    }));
    expect(graph.coverage.service).toEqual(collection);
    expect(graph.coverage.network).toMatchObject({ status: 'partial', cappedCategories: ['INTER_AZ'], failedCategories: null });
    expect(buildE2eGraph(input()).coverage.service).toEqual({ status: 'unknown', stale: true });
    const foreign = buildE2eGraph(input({ account: '__all__', services: { ...services(), collection } }));
    expect(foreign.coverage.network.status).toBe('unsupported');
    expect(foreign.coverage.service).toEqual({ status: 'unknown', stale: true });
  });

  it('bridges a real CF/LB/TG/target graph, trace workloads and one NFM connection without collapsing records', () => {
    const lbArn = 'arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:loadbalancer/app/web/1';
    const config = buildFlowGraph({
      cloudfront: [{ resource_id: 'D1', origins: [{ DomainName: 'web.elb.amazonaws.com' }] }],
      alb: [{ resource_id: 'web', arn: lbArn, dns_name: 'web.elb.amazonaws.com' }],
      tg: [{
        resource_id: 'tg-web', region: REGION, vpc_id: VPC, target_type: 'ip',
        load_balancer_arns: [lbArn],
        target_health_descriptions: [{ Target: { Id: '10.0.1.10', Port: 443 } }],
      }],
      ipResolved: { '10.0.1.10': { label: 'shop/web', resolved: 'eks', meta: { cluster: 'app', region: REGION, vpcId: VPC } } },
    });
    const trace = services();
    trace.nodes.push(
      { id: 'svc:db', kind: 'svc', label: 'database' },
      { id: 'wl:db', kind: 'workload', label: 'db deployment',
        meta: { cluster: 'app', namespace: 'shop', pods: ['db-1'] } },
    );
    trace.edges.push(
      { source: 'svc:web', target: 'svc:db', rel: 'calls', confidence: 'inferred' },
      { source: 'svc:db', target: 'wl:db', rel: 'runs_on' },
    );
    // The remote cluster is established by an independent, scoped configuration target.
    const db = configured([target({ id: '10.0.2.20', resolved: 'eks', cluster: 'app' }, 'target:db')]);
    db.nodes[0].id = 'tg:db';
    db.edges[0].source = 'tg:db';
    config.nodes.push(...db.nodes);
    config.edges.push(...db.edges);
    const row = flow({
      local: endpoint({ podName: 'web-2', podNamespace: 'shop' }),
      remote: endpoint({ ip: '10.0.2.20', podName: 'db-1', podNamespace: 'shop' }),
      traversed: ['NAT', 'TGW'], traversedIds: ['TGW:tgw-1', 'NAT:nat-1'],
    });
    const graph = buildE2eGraph(input({ configured: config, services: trace, network: [observation([row])] }));
    expect(graph.summary).toEqual({
      configuredNodes: 6, serviceNodes: 4, networkFlows: 1,
      correlatedEndpoints: 2, unmatchedEndpoints: 0, ambiguousEndpoints: 0, observationsUnsupported: false,
    });
    expect(identityEdges(graph)).toHaveLength(2);
    expect(graph.edges.some(e => e.evidence === 'context' && e.meta?.match === 'monitor-cluster')).toBe(true);
    const cf = graph.nodes.find(n => n.kind === 'cloudfront')!;
    const focused = selectE2eGraph(graph, { focusId: cf.id });
    expect(labels(focused)).toContain('db deployment');
    expect(labels(focused)).toContain('database');
    const configTarget = graph.nodes.find(n => n.kind === 'target' && n.label === 'shop/web')!;
    expect(configTarget.meta).toEqual(config.nodes.find(n => n.label === 'shop/web')!.meta);
    const workload = graph.nodes.find(n => n.label === 'web deployment')!;
    expect(workload.meta).toMatchObject({ cluster: 'app', pods: ['web-1', 'web-2'], capturedAt: CAPTURED_AT });
    expect(graph.edges.filter(e => e.evidence === 'configuration').every(e => e.directed)).toBe(true);
    const calls = graph.edges.find(e => e.relation === 'calls')!;
    expect(calls).toMatchObject({ directed: true, evidence: 'service', meta: { confidence: 'inferred' } });
    expect(graph.nodes.find(n => n.id === calls.source)?.label).toBe('web');
    expect(graph.nodes.find(n => n.id === calls.target)?.label).toBe('database');
    expectNoDanglingEdges(graph);
  });

  it('keeps configuration and service IDs distinct even when original IDs coincide', () => {
    const graph = buildE2eGraph(input({
      configured: { nodes: [{ id: 'same', kind: 'origin', label: 'config' }], edges: [] },
      services: { nodes: [{ id: 'same', kind: 'svc', label: 'trace' }], edges: [], captured_at: null },
    }));
    expect(ids(graph).size).toBe(2);
    expect(graph.nodes[0].id).toContain('configuration');
    expect(graph.nodes[1].id).toContain('service');
    const another = buildE2eGraph(input({
      account: 'another', configured: { nodes: [{ id: 'same', kind: 'origin', label: 'config' }], edges: [] },
    }));
    expect(another.nodes[0].id).not.toBe(graph.nodes[0].id);
    expect(graph.nodes[1].meta.capturedAt).toBeNull();
  });

  it('keeps each category and metric on its original connection, never on endpoints or constructs', () => {
    const original = flow({ value: 7, unit: 'Milliseconds', traversedIds: ['NAT:nat-1'], traversed: ['NAT'] });
    const observations = [
      observation([original], { metric: 'ROUND_TRIP_TIME', unit: 'Milliseconds', capped: true }),
      observation([flow({ value: 11, category: 'INTER_VPC' })], { category: 'INTER_VPC' }),
      observation([original], { metric: 'RETRANSMISSIONS', unit: 'Count' }),
    ];
    const graph = buildE2eGraph(input({ network: observations }));
    const connections = graph.nodes.filter(n => n.kind === 'connection');
    expect(connections).toHaveLength(3);
    expect(connections[0].meta).toMatchObject({
      flow: original, metric: 'ROUND_TRIP_TIME', unit: 'Milliseconds', monitor: 'nfm-eks-app',
      category: 'INTER_AZ', rangeSec: 900, startTime: '2026-09-11T09:00:00Z',
      endTime: '2026-09-11T09:15:00Z', queriedAt: '2026-09-11T09:15:03Z', capped: true,
    });
    expect(connections.map(n => (n.meta.flow as NfmFlowRow).value)).toEqual([7, 11, 7]);
    expect(connections[1].meta.category).toBe('INTER_VPC');
    expect(graph.edges.filter(e => e.evidence === 'network')).toHaveLength(6);
    expect(graph.edges.filter(e => e.evidence === 'network').every(e => !e.directed)).toBe(true);
    for (const n of graph.nodes.filter(n => n.kind !== 'connection')) {
      expect(n.meta.metric).toBeUndefined();
      expect(n.meta.value).toBeUndefined();
    }
    expect(ids(graph).size).toBe(graph.nodes.length);
    expect(new Set(graph.edges.map(e => e.id)).size).toBe(graph.edges.length);
  });

  it('attaches every construct to its connection as unordered context, including connection-scoped missing IDs', () => {
    const graph = buildE2eGraph(input({ network: [observation([
      flow({ traversed: ['NAT', 'TGW'], traversedIds: ['TGW:tgw-1', 'NAT'] }),
      flow({ traversed: ['NAT', 'TGW'], traversedIds: ['NAT', 'TGW:tgw-1'] }),
    ])] }));
    const constructs = graph.nodes.filter(n => n.kind === 'construct');
    expect(constructs.filter(n => n.label === 'NAT')).toHaveLength(2);
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const contexts = graph.edges.filter(e => e.evidence === 'context');
    expect(contexts).toHaveLength(4);
    for (const edge of contexts) {
      expect(new Set([byId.get(edge.source)?.kind, byId.get(edge.target)?.kind]))
        .toEqual(new Set(['connection', 'construct']));
      expect(edge.directed).toBe(false);
      expect(edge.meta?.order).toBeUndefined();
    }
  });

  it.each(['all', '123456789012', ''])('suppresses host observations for account %j', account => {
    const graph = buildE2eGraph(input({ account, configured: configured(), services: services(), network: [observation()] }));
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.every(n => n.layer === 'configuration')).toBe(true);
    expect(graph.summary).toMatchObject({
      observationsUnsupported: true, configuredNodes: 2, serviceNodes: 0, networkFlows: 0,
      correlatedEndpoints: 0, unmatchedEndpoints: 0, ambiguousEndpoints: 0,
    });
  });

  it('handles empty sources and malformed rows without inventing identities or dangling edges', () => {
    expect(buildE2eGraph(input())).toMatchObject({
      nodes: [], edges: [], summary: { networkFlows: 0, unmatchedEndpoints: 0, observationsUnsupported: false },
    });
    const malformed = {
      local: null, remote: { ip: 123, region: {}, vpcId: [] },
      value: 0, traversed: [null, 123], traversedIds: [null, {}],
    } as unknown as NfmFlowRow;
    const graph = buildE2eGraph(input({
      configured: { nodes: [target()], edges: [{ id: 'bad', source: 'missing', target: 'target:web', confidence: 'observed' }] },
      services: { nodes: [], edges: [{ source: 'missing', target: 'other', rel: 'calls' }], captured_at: null },
      network: [observation([null as unknown as NfmFlowRow, malformed, flow({ local: {}, remote: {} })])],
    }));
    expect(graph.summary.networkFlows).toBe(2);
    expect(graph.summary.unmatchedEndpoints).toBe(4);
    expect(identityEdges(graph)).toEqual([]);
    expect(graph.nodes.filter(n => n.kind === 'endpoint')).toHaveLength(4);
    expect(graph.nodes.filter(n => n.kind === 'construct')).toHaveLength(0);
    expectNoDanglingEdges(graph);
  });

  it('does not mutate source graphs, rows, or observation metadata', () => {
    const source = input({ configured: configured(), services: services(), network: [observation()] });
    const before = structuredClone(source);
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.freeze(value);
        Object.values(value).forEach(freeze);
      }
    };
    freeze(source);
    const graph = buildE2eGraph(source);
    selectE2eGraph(graph, { query: 'web', maxNodes: 1 });
    expect(source).toEqual(before);
  });
});

describe('buildE2eGraph — scoped target identity', () => {
  it.each([
    { targetType: 'ip', id: '10.0.1.10', local: endpoint(), match: 'ip-region-vpc' },
    { targetType: 'instance', id: 'i-012345', local: endpoint({ ip: undefined, instanceId: 'i-012345' }), match: 'instance-region-vpc' },
  ])('matches exact $targetType identity with TG region and VPC', ({ local, match, ...meta }) => {
    const graph = buildE2eGraph(input({ configured: configured([target(meta)]), network: [observation([flow({ local })])] }));
    expect(identityEdges(graph)).toHaveLength(1);
    expect(identityEdges(graph)[0]).toMatchObject({ directed: false, meta: { match, region: REGION, vpcId: VPC } });
    expect(graph.summary).toMatchObject({ correlatedEndpoints: 1, unmatchedEndpoints: 1, ambiguousEndpoints: 0 });
  });

  it.each([
    ['endpoint', { region: 'us-east-1', vpcId: VPC }], ['endpoint', { region: REGION, vpcId: 'vpc-other' }],
    ['endpoint', { region: '', vpcId: VPC }], ['endpoint', { region: REGION, vpcId: undefined }],
    ['TG', {}], ['TG', { region: REGION }], ['TG', { vpc_id: VPC }], ['TG', { region: ' ', vpc_id: VPC }],
  ] as const)('requires independent %s scope instead of borrowing target metadata: %j', (side, scope) => {
    const graph = buildE2eGraph(input({
      configured: side === 'TG' ? configured([target({ region: REGION, vpc_id: VPC })], scope) : configured(),
      network: [observation([flow({ local: side === 'endpoint' ? endpoint(scope) : endpoint() })])],
    }));
    expect(identityEdges(graph)).toEqual([]);
    if (side === 'endpoint') expect(graph.summary.unmatchedEndpoints).toBe(2);
  });

  it('leaves duplicate scoped configuration candidates ambiguous with no arbitrary join', () => {
    const graph = buildE2eGraph(input({
      configured: configured([target({}, 'one'), target({}, 'two')]), network: [observation()],
    }));
    expect(identityEdges(graph)).toEqual([]);
    expect(graph.summary).toMatchObject({ correlatedEndpoints: 0, unmatchedEndpoints: 1, ambiguousEndpoints: 1 });
  });

  it('does not borrow one incoming TG scope when another TG gives the same target conflicting scope', () => {
    const config = configured();
    config.nodes.push({
      id: 'tg:other', kind: 'tg', label: 'other',
      meta: { row: { region: REGION, vpc_id: 'vpc-other' } },
    });
    config.edges.push({ id: 'other-to-target', source: 'tg:other', target: 'target:web', confidence: 'observed' });
    const graph = buildE2eGraph(input({ configured: config, network: [observation()] }));
    expect(identityEdges(graph)).toEqual([]);
    expect(graph.summary.unmatchedEndpoints).toBe(2);
  });

  it.each([
    { meta: { id: '2001:db8::1' }, ip: '2001:db8::1', count: 1 },
    { meta: { id: undefined, members: ['[2001:db8::1]:443'] }, ip: '2001:db8::1', count: 1 },
    { meta: { id: undefined, members: ['2001:db8::1:443'] }, ip: '2001:db8::1', count: 0 },
  ])('uses unambiguous IPv6 identity only: %j', ({ meta, ip, count }) => {
    const graph = buildE2eGraph(input({
      configured: configured([target(meta)]), network: [observation([flow({ local: endpoint({ ip }) })])],
    }));
    expect(identityEdges(graph)).toHaveLength(count);
    expect(graph.summary.correlatedEndpoints).toBe(count);
  });

  it('uses only shown members of capped target groups, stripping explicit IPv4 and instance ports', () => {
    const graph = buildE2eGraph(input({
      configured: configured([
        target({ id: undefined, count: 300, members: ['10.0.1.10:443', '10.0.9.9:443'], membersTruncated: 298 }),
        target({ targetType: 'instance', id: undefined, members: ['i-012345:8080'] }, 'instance'),
      ]),
      network: [observation([
        flow({ remote: endpoint({ ip: undefined, instanceId: 'i-012345' }) }),
        flow({ local: endpoint({ ip: '10.0.1.11' }), remote: {} }),
      ])],
    }));
    expect(identityEdges(graph)).toHaveLength(2);
    expect(graph.summary).toMatchObject({ correlatedEndpoints: 2, unmatchedEndpoints: 2, ambiguousEndpoints: 0 });
  });

  it('does not use SNAT or DNAT aliases as endpoint identities', () => {
    const graph = buildE2eGraph(input({
      configured: configured(),
      network: [observation([flow({
        local: endpoint({ ip: '10.9.1.1' }), remote: endpoint({ ip: '10.9.1.2' }),
        snatIp: '10.0.1.10', dnatIp: '10.0.1.10',
      })])],
    }));
    expect(identityEdges(graph)).toEqual([]);
    expect(graph.summary.unmatchedEndpoints).toBe(2);
    expect(graph.nodes.find(n => n.kind === 'connection')!.meta.flow).toMatchObject({
      snatIp: '10.0.1.10', dnatIp: '10.0.1.10',
    });
  });
});

describe('buildE2eGraph — workload identity', () => {
  it.each(['local', 'remote'] as const)('rejects explicit Kubernetes metadata against ECS without a snapshot: %s', side => {
    for (const podMetadata of [{ podName: 'web-1' }, { podNamespace: 'shop' }, { podName: 'web-1', podNamespace: 'shop' }]) {
      const graph = buildE2eGraph(input({
        configured: configured([target({ resolved: 'ecs', cluster: 'ecs-app' })]), services: null,
        network: [observation([flow({ local: {}, remote: {}, [side]: endpoint(podMetadata) })])],
      }));
      expect(identityEdges(graph)).toEqual([]);
      expect(graph.summary.ambiguousEndpoints).toBe(1);
    }
  });
  it.each(['local', 'remote'] as const)('marks contradictory target pod/namespace evidence ambiguous on the %s side', side => {
    for (const conflict of [{ pod: 'previous-pod' }, { namespace: 'other-namespace' }]) {
      const graph = buildE2eGraph(input({
        configured: configured([target({ resolved: 'eks', cluster: 'app', namespace: 'shop', pod: 'web-1', ...conflict })]),
        services: services(),
        network: [observation([flow({ local: {}, remote: {}, [side]: endpoint({ podName: 'web-1', podNamespace: 'shop' }) })])],
      }));
      expect(identityEdges(graph)).toEqual([]);
      expect(graph.summary).toMatchObject({ ambiguousEndpoints: 1, correlatedEndpoints: 0, unmatchedEndpoints: 1 });
    }
  });

  it.each([{}, { pod: 'web-1' }, { namespace: 'shop' }, { pod: 'web-1', namespace: 'shop' }])(
    'keeps agreeing or unknown target metadata distinct from contradictions: %j', metadata => {
      const graph = buildE2eGraph(input({
        configured: configured([target({ resolved: 'eks', cluster: 'app', ...metadata })]), services: services(),
        network: [observation([flow({ local: {}, remote: endpoint({ podName: 'web-1', podNamespace: 'shop' }) })])],
      }));
      expect(identityEdges(graph)).toHaveLength(1);
      expect(graph.edges.some(edge => edge.evidence === 'context' && edge.meta?.match === 'configured-cluster')).toBe(true);
      expect(graph.summary.ambiguousEndpoints).toBe(0);
    },
  );

  it('does not simultaneously identify a local endpoint as an ECS task and an EKS workload', () => {
    const graph = buildE2eGraph(input({
      configured: configured([target({ resolved: 'ecs', cluster: 'ecs-app', task: 'task-1' })]), services: services(),
      network: [observation([flow({ local: endpoint({ podName: 'web-1', podNamespace: 'shop' }), remote: {} })])],
    }));
    expect(identityEdges(graph)).toEqual([]);
    expect(graph.summary).toMatchObject({ ambiguousEndpoints: 1, correlatedEndpoints: 0 });
  });

  it('retains an ECS registration when no Kubernetes workload identity is asserted', () => {
    const graph = buildE2eGraph(input({
      configured: configured([target({ resolved: 'ecs', cluster: 'ecs-app', task: 'task-1' })]), services: services(),
      network: [observation([flow({ local: endpoint(), remote: {} })])],
    }));
    expect(identityEdges(graph)).toHaveLength(1);
    expect(graph.summary.ambiguousEndpoints).toBe(0);
  });

  it.each([{}, { podName: 'web-1' }, { podNamespace: 'shop' }])('does not invent a contradiction from missing NFM pod metadata: %j', metadata => {
    const graph = buildE2eGraph(input({
      configured: configured([target({ resolved: 'eks', cluster: 'app', pod: 'web-1', namespace: 'shop' })]),
      services: services(), network: [observation([flow({ local: {}, remote: endpoint(metadata) })])],
    }));
    expect(identityEdges(graph)).toHaveLength(1);
    expect(graph.summary.ambiguousEndpoints).toBe(0);
  });

  it('does not compare a grouped target representative pod with a different matched replica', () => {
    const ips = ['10.0.1.10', '10.0.1.11'];
    const config = buildFlowGraph({
      tg: [{ resource_id: 'replicas', target_type: 'ip', region: REGION, vpc_id: VPC,
        target_health_descriptions: ips.map(Id => ({ Target: { Id, Port: 80 } })) }],
      ipResolved: Object.fromEntries(ips.map((ip, i) => [`${REGION}|${VPC}|${ip}`, {
        label: 'shop/web', resolved: 'eks' as const,
        meta: { region: REGION, vpcId: VPC, cluster: 'app', namespace: 'shop', pod: `web-${i + 1}` },
      }])),
    });
    expect(config.nodes.find(node => node.kind === 'target')?.meta).toMatchObject({ count: 2, pod: 'web-1' });
    const graph = buildE2eGraph(input({ configured: config, services: services(),
      network: [observation([flow({ local: {}, remote: endpoint({ ip: ips[1], podName: 'web-2', podNamespace: 'shop' }) })])] }));
    expect(identityEdges(graph)).toHaveLength(1);
    expect(graph.summary.ambiguousEndpoints).toBe(0);
    expect(graph.edges.some(edge => edge.evidence === 'context' && edge.meta?.pod === 'web-2')).toBe(true);
    const conflictingNamespace = buildE2eGraph(input({ configured: config, services: services({ namespace: 'other' }),
      network: [observation([flow({ local: {}, remote: endpoint({ ip: ips[1], podName: 'web-2', podNamespace: 'other' }) })])] }));
    expect(identityEdges(conflictingNamespace)).toEqual([]);
    expect(conflictingNamespace.summary.ambiguousEndpoints).toBe(1);
  });

  it.each([
    ['local', REGION], ['local', 'us-west-2'], ['remote', REGION], ['remote', 'us-west-2'],
  ] as const)('keeps %s workload naming from trace region %s as context', (side, region) => {
    const cluster = side === 'local' ? 'app' : 'remote-cluster';
    const trace = buildTraceGraph([{ traceId: 'trace', spanId: 'span', service: 'web', kind: 'server',
      startMs: 1, durationMs: 1, sourceId: 'traces', region, k8sCluster: cluster, k8sNamespace: 'shop',
      k8sDeployment: 'web', k8sPod: 'web-2' }], [], []);
    const graph = buildE2eGraph(input({
      configured: side === 'remote' ? configured([target({ resolved: 'eks', cluster })]) : input().configured,
      services: { ...trace, captured_at: CAPTURED_AT },
      network: [observation([flow({ local: {}, remote: {}, [side]: endpoint({ podName: 'web-2', podNamespace: 'shop' }) })])],
    }));
    expect(identityEdges(graph)).toHaveLength(side === 'remote' ? 1 : 0);
    if (side === 'remote') expect(identityEdges(graph)[0]).toMatchObject({
      target: graph.nodes.find(n => n.kind === 'target')!.id, meta: { match: 'ip-region-vpc', region: REGION, vpcId: VPC },
    });
    expect(graph.edges.find(e => e.evidence === 'context')).toMatchObject({
      target: graph.nodes.find(n => n.kind === 'workload')!.id, relation: 'name-context', directed: false,
      meta: { match: side === 'local' ? 'monitor-cluster' : 'configured-cluster', cluster, namespace: 'shop', pod: 'web-2', side },
    });
    expect(graph.summary).toMatchObject({
      correlatedEndpoints: side === 'remote' ? 1 : 0, unmatchedEndpoints: side === 'remote' ? 1 : 2,
    });
    const focused = selectE2eGraph(graph, { focusId: graph.nodes.find(n => n.kind === 'workload')!.id });
    expect(focused.nodes.filter(n => n.kind === 'connection')).toHaveLength(1);
    expect(focused.edges.filter(e => e.evidence === 'network')).toHaveLength(2);
  });

  it.each([
    { cluster: 'other' }, { namespace: 'other' }, { pods: ['web-10'] },
    { pods: 'web-1' }, { namespace: '' }, { cluster: '' },
  ])('rejects incomplete or mismatched workload metadata %j', meta => {
    const graph = buildE2eGraph(input({
      services: services(meta),
      network: [observation([flow({ local: endpoint({ podName: 'web-1', podNamespace: 'shop' }) })])],
    }));
    expect(identityEdges(graph)).toEqual([]);
  });

  it('refuses service-name-only matching to both configured Kubernetes Services and trace services', () => {
    const graph = buildE2eGraph(input({
      configured: configured([target({ service: 'web', cluster: 'app', namespace: 'shop' })]),
      services: services(),
      network: [observation([flow({ local: { serviceName: 'web' }, remote: { serviceName: 'web' } })])],
    }));
    expect(identityEdges(graph)).toEqual([]);
    expect(graph.nodes.filter(n => n.label === 'web')).toHaveLength(2);
  });

  it.each([
    { reason: 'no target in INTRA_AZ', config: input().configured, category: 'INTRA_AZ' as const, vpcId: VPC },
    { reason: 'target in another VPC', config: configured([target({ resolved: 'eks', cluster: 'app' })]), category: 'INTER_AZ' as const, vpcId: 'vpc-other' },
  ])('does not borrow monitor cluster for a remote pod: $reason', ({ config, category, vpcId }) => {
    const graph = buildE2eGraph(input({ configured: config, services: services(),
      network: [observation([flow({ local: {}, remote: endpoint({ vpcId, podName: 'web-1', podNamespace: 'shop' }), category })], { category })] }));
    expect(identityEdges(graph)).toEqual([]);
    expect(graph.summary.unmatchedEndpoints).toBe(2);
  });

  it.each(['ecs', undefined])('does not take Kubernetes cluster proof from a %j target', resolved => {
    const graph = buildE2eGraph(input({
      configured: configured([target({ resolved, cluster: 'app' })]), services: services(),
      network: [observation([flow({ local: {}, remote: endpoint({ podName: 'web-1', podNamespace: 'shop' }) })])],
    }));
    expect(identityEdges(graph)).toHaveLength(resolved === 'ecs' ? 0 : 1);
    if (!resolved) expect(identityEdges(graph)[0].meta?.match).toBe('ip-region-vpc');
  });

  it.each([
    ['duplicate workload memberships', () => {
      const snapshot = services(); snapshot.nodes.push({ ...snapshot.nodes[1], id: 'wl:duplicate' });
      return { services: snapshot };
    }],
    ['conflicting monitor/target cluster', () => ({ configured: configured([target({ resolved: 'eks', cluster: 'different-cluster' })]) })],
    ['ambiguous configured target behind a unique workload', () => ({ configured: configured([target({}, 'one'), target({}, 'two')]) })],
  ] as const)('does not choose an identity for %s', (_reason, overrides) => {
    const graph = buildE2eGraph(input({ services: services(), ...overrides(),
      network: [observation([flow({ local: endpoint({ podName: 'web-1', podNamespace: 'shop' }) })])] }));
    expect(identityEdges(graph)).toEqual([]);
    expect(graph.summary).toMatchObject({ correlatedEndpoints: 0, unmatchedEndpoints: 1, ambiguousEndpoints: 1 });
  });

});

describe('selectE2eGraph — filtering before bounds', () => {
  it.each([0, 2, 3])('prunes constructs using the final visible edge budget %i', maxEdges => {
    const graph = buildE2eGraph(input({ network: [observation([flow({ traversedIds: ['NAT:nat-1'] })])] }));
    const view = selectE2eGraph(graph, { maxEdges });
    expect(view.nodes.filter(node => node.kind === 'construct')).toHaveLength(maxEdges === 3 ? 1 : 0);
    expect(view.nodes.filter(node => node.kind === 'endpoint')).toHaveLength(maxEdges >= 2 ? 2 : 0);
    expect(view.edges).toHaveLength(maxEdges);
    expectNoDanglingEdges(view);
  });
  it.each(['focus', 'query'])('includes each connection endpoint when a shared construct is the %s target', mode => {
    const graph = buildE2eGraph(input({ network: [observation([
      flow({ traversedIds: ['NAT:nat-shared'] }),
      flow({ local: { ip: '10.2.1.1' }, remote: { ip: '10.2.1.2' }, traversedIds: ['NAT:nat-shared'] }),
    ])] }));
    const construct = graph.nodes.find(n => n.kind === 'construct')!;
    const selection = mode === 'focus' ? { focusId: construct.id } : { query: construct.id };
    const view = selectE2eGraph(graph, selection);
    expect(view.nodes.filter(n => n.kind === 'connection')).toHaveLength(2);
    expect(view.nodes.filter(n => n.kind === 'endpoint')).toHaveLength(4);
    expect(view.edges.filter(e => e.evidence === 'network')).toHaveLength(4);
    expect(view.edges.filter(e => e.evidence === 'context')).toHaveLength(2);
    expectNoDanglingEdges(view);
    const capped = selectE2eGraph(graph, { ...selection, maxNodes: 4, maxEdges: 3 });
    expect(capped.nodes.filter(n => n.kind === 'connection')).toHaveLength(1);
    expect(capped.nodes.filter(n => n.kind === 'endpoint')).toHaveLength(2);
    expectNoDanglingEdges(capped);
  });

  it.each(['focus-connection', 'focus-endpoint', 'query', 'focus-query'])('keeps whole connection groups under tight node and edge budgets for %s', mode => {
    const graph = buildE2eGraph(input({ network: [observation([flow()])] }));
    const connection = graph.nodes.find(n => n.kind === 'connection')!;
    const local = graph.nodes.find(n => n.kind === 'endpoint' && n.meta.side === 'local')!;
    const selection = mode === 'focus-connection' ? { focusId: connection.id }
      : mode === 'focus-endpoint' ? { focusId: local.id }
        : { query: '10.0.1.10', ...(mode === 'focus-query' ? { focusId: connection.id } : {}) };
    for (const [maxNodes, maxEdges, count] of [[2, 700, 0], [3, 1, 0], [3, 2, 3]]) {
      const view = selectE2eGraph(graph, { ...selection, maxNodes, maxEdges });
      expect(view.nodes).toHaveLength(count);
      expect(view.edges).toHaveLength(count ? 2 : 0);
      expect(view.omittedNodes).toBe(3 - count);
      expectNoDanglingEdges(view);
    }
  });

  it('reserves nodes and edges for observed neighborhoods before dense unrelated configuration', () => {
    const config = configured();
    config.nodes.unshift(...Array.from({ length: 500 }, (_, i): FlowNode => ({
      id: `unrelated-${i}`, kind: 'origin', label: `unrelated ${i}`,
    })));
    config.edges.unshift(...Array.from({ length: 800 }, (_, i) => ({
      id: `unrelated-edge-${i}`, source: 'unrelated-0', target: `unrelated-${1 + i % 20}`,
      confidence: 'observed' as const,
    })));
    const graph = buildE2eGraph(input({
      configured: config, services: services(),
      network: [observation([flow({ local: endpoint({ podName: 'web-1', podNamespace: 'shop' }) })])],
    }));
    const view = selectE2eGraph(graph, {});
    expect(view.nodes).toHaveLength(350);
    expect(view.edges).toHaveLength(700);
    expect(view.nodes.filter(n => n.kind === 'connection')).toHaveLength(1);
    expect(view.edges.filter(e => e.evidence === 'network')).toHaveLength(2);
    expect(view.edges.filter(e => e.evidence === 'identity')).toHaveLength(1);
    expect(view.edges.filter(e => e.evidence === 'context')).toHaveLength(1);
    expect(view.edges.filter(e => e.evidence === 'service')).toHaveLength(1);
    expect(labels(view)).toContain('web-tg');
    expect(view.omittedNodes).toBe(graph.nodes.length - 350);
    expect(view.omittedEdges).toBe(graph.edges.length - 700);
    expectNoDanglingEdges(view);
  });

  it('keeps service relationships ahead of inventory even without network observations', () => {
    const graph = largeGraph();
    const trace = buildE2eGraph(input({ services: services() }));
    graph.nodes.push(...trace.nodes);
    graph.edges.push(...trace.edges);
    const view = selectE2eGraph(graph, {});
    expect(labels(view)).toContain('web deployment');
    expect(view.edges.filter(e => e.evidence === 'service')).toHaveLength(1);
    expect(view.omittedNodes).toBe(62);
  });

  it.each([4, 7, 349, 350])('keeps both endpoints of each displayed flow within a %i-node budget', maxNodes => {
    const graph = buildE2eGraph(input({
      services: services(),
      network: [observation(Array.from({ length: 300 }, () => flow({
        local: endpoint({ podName: 'web-1', podNamespace: 'shop' }),
      })))],
    }));
    const view = selectE2eGraph(graph, { maxNodes });
    const connections = view.nodes.filter(n => n.kind === 'connection');
    expect(connections.length).toBeGreaterThan(0);
    expect(view.nodes.length).toBeLessThanOrEqual(maxNodes);
    for (const connection of connections) {
      expect(view.edges.filter(e => e.evidence === 'network'
        && (e.source === connection.id || e.target === connection.id))).toHaveLength(2);
    }
    for (const node of view.nodes.filter(n => n.kind === 'endpoint')) {
      expect(connections.some(c => c.id === node.meta.connectionId)).toBe(true);
    }
    expect(view.edges.some(e => e.evidence === 'context')).toBe(true);
    if (maxNodes >= 7) expect(view.edges.some(e => e.evidence === 'service')).toBe(true);
    expect(view.omittedNodes).toBe(graph.nodes.length - view.nodes.length);
    expect(view.omittedEdges).toBe(graph.edges.length - view.edges.length);
    expectNoDanglingEdges(view);
  });

  it.each(['filtered', 'removed'])('ignores a %s focus without concealing eligible search results', stale => {
    const graph = buildE2eGraph(input({ configured: configured(), services: services() }));
    const focusId = stale === 'filtered' ? graph.nodes.find(n => n.layer === 'service')!.id : 'removed-id';
    for (const query of ['', 'web-tg']) {
      const view = selectE2eGraph(graph, { focusId, evidence: ['configuration'], query });
      expect(labels(view)).toEqual(['web-tg', 'web']);
      expect(view.edges).toHaveLength(1);
      expect(view.matchedNodes).toBe(query ? 1 : 2);
      expect(view.omittedNodes).toBe(0);
    }
  });

  function largeGraph(size = 410): E2eGraph {
    return buildE2eGraph(input({
      configured: {
        nodes: Array.from({ length: size }, (_, i) => ({ id: `n${i}`, kind: 'origin', label: `node ${i}` })),
        edges: Array.from({ length: size - 1 }, (_, i) => ({
          id: `e${i}`, source: `n${i}`, target: `n${i + 1}`, confidence: 'observed',
        })),
      },
    }));
  }

  it('keeps the full base graph and finds/prioritizes a connected match beyond the initial node cap', () => {
    const graph = largeGraph();
    expect(graph.nodes).toHaveLength(410);
    expect(graph.edges).toHaveLength(409);
    expect(selectE2eGraph(graph, {}).nodes).toHaveLength(350);
    const view = selectE2eGraph(graph, { query: 'NODE 409', maxNodes: 2 });
    expect(labels(view)).toContain('node 409');
    expect(view.matchedNodes).toBe(1);
    expect(view.omittedNodes).toBe(408);
    expectNoDanglingEdges(view);
  });

  it('prioritizes a focused node before the cap while retaining upstream and downstream evidence', () => {
    const graph = largeGraph();
    const focusId = graph.nodes.find(n => n.label === 'node 400')!.id;
    const view = selectE2eGraph(graph, { focusId, maxNodes: 3 });
    expect(labels(view)).toEqual(['node 400', 'node 399', 'node 401']);
    expect(view.omittedNodes).toBe(407);
    expectNoDanglingEdges(view);
  });

  it('searches source metadata such as pod membership before bounding', () => {
    const graph = buildE2eGraph(input({ services: services() }));
    expect(labels(selectE2eGraph(graph, { query: 'WEB-2', maxNodes: 1 }))).toEqual(['web deployment']);
    expect(selectE2eGraph(graph, { query: 'does-not-exist' })).toMatchObject({
      nodes: [], edges: [], matchedNodes: 0, omittedNodes: 0, omittedEdges: 0,
    });
  });

  it.each(['construct', 'workload'])('never traverses shared %s context to another connection when focusing or searching', context => {
    const pod = context === 'workload' ? { podName: 'web-1', podNamespace: 'shop' } : {};
    const graph = buildE2eGraph(input({ services: context === 'workload' ? services() : null, network: [observation([
      flow({ local: { ip: '10.1.1.1', ...pod }, remote: { ip: '10.1.1.2' }, traversedIds: ['NAT:nat-shared'] }),
      flow({ local: { ip: '10.2.2.1', ...pod }, remote: { ip: '10.2.2.2' }, traversedIds: ['NAT:nat-shared'] }),
    ])] }));
    const first = graph.nodes.find(n => n.kind === 'connection')!;
    for (const view of [
      selectE2eGraph(graph, { focusId: first.id }),
      selectE2eGraph(graph, { query: '10.1.1.1' }),
    ]) {
      expect(view.nodes.filter(n => n.kind === 'connection')).toHaveLength(1);
      expect(view.nodes.filter(n => n.kind === 'construct')).toHaveLength(1);
      expect(view.nodes.filter(n => n.kind === 'endpoint')).toHaveLength(2);
      expect(view.nodes.filter(n => n.kind === 'workload')).toHaveLength(context === 'workload' ? 1 : 0);
      expectNoDanglingEdges(view);
    }
  });

  it('applies evidence filters before reachability and preserves isolated nodes in selected layers', () => {
    const graph = buildE2eGraph(input({
      configured: configured(), services: services(),
      network: [observation([flow({ local: endpoint({ podName: 'web-1', podNamespace: 'shop' }) })])],
    }));
    const configOnly = selectE2eGraph(graph, { evidence: ['configuration'] });
    expect(configOnly.nodes).toHaveLength(2);
    expect(configOnly.edges).toHaveLength(1);
    const focusId = graph.nodes.find(n => n.kind === 'tg')!.id;
    const disconnected = selectE2eGraph(graph, {
      focusId, evidence: ['configuration', 'network', 'service', 'context'],
    });
    expect(disconnected.nodes).toHaveLength(2);
    expect(selectE2eGraph(graph, { evidence: [] })).toMatchObject({ nodes: [], edges: [], matchedNodes: 0 });
    const identityOnly = selectE2eGraph(graph, { evidence: ['identity'] });
    expect(identityOnly.edges.every(e => e.evidence === 'identity')).toBe(true);
    expect(identityOnly.nodes).toHaveLength(2);
    expectNoDanglingEdges(identityOnly);
  });

  it('limits edges to 700 by default, with accurate node/edge omissions and no dangling edges', () => {
    const graph = largeGraph(40);
    const first = graph.nodes[0].id;
    graph.edges = Array.from({ length: 750 }, (_, i) => ({
      id: `parallel-${i}`, source: first, target: graph.nodes[1 + i % 39].id,
      relation: 'configuration', evidence: 'configuration', directed: true,
    }));
    const view = selectE2eGraph(graph, {});
    expect(view.edges).toHaveLength(700);
    expect(view.omittedEdges).toBe(50);
    expect(view.omittedNodes).toBe(0);
    const bounded = selectE2eGraph(graph, { maxNodes: 4, maxEdges: 2 });
    expect(bounded.nodes).toHaveLength(4);
    expect(bounded.edges).toHaveLength(2);
    expect(bounded.omittedNodes).toBe(36);
    expect(bounded.omittedEdges).toBe(748);
    expectNoDanglingEdges(bounded);
    expect(selectE2eGraph(graph, { maxNodes: 0 })).toMatchObject({
      nodes: [], edges: [], omittedNodes: 40, omittedEdges: 750,
    });
  });
});
