import { describe, it, expect, vi } from 'vitest';
// FakeTraceSource lives in trace-source.ts, which transitively imports datasources →
// integration-credentials (aws-sdk). Stub those so this DB-aggregation test needs no AWS SDK.
vi.mock('@/lib/datasources', () => ({
  getDefaultDatasource: vi.fn(async () => null),
  resolveConnConfig: vi.fn(async () => ({})),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: vi.fn(async () => ({ rows: [] })) }));
import { rebuildTraceGraph, resolveInfraRef } from './graph-store';
import { FakeTraceSource, type TraceSpan, type ServiceGraphCall } from './trace-source';

// In-memory MetricsCallsSource-shaped stub for tests (the interface, not the real connector-backed
// class — mirrors FakeTraceSource's role for TraceSource).
class FakeMetricsCallsSource {
  constructor(private readonly rows: ServiceGraphCall[], private readonly isAvailable: boolean = true) {}
  async available(): Promise<boolean> { return this.isAvailable; }
  async calls(_windowMins: number): Promise<ServiceGraphCall[]> { return this.rows; }
}

// A pool that records every client.query call (sql + params) and lets the inventory/infra SELECT
// (pool.query) return a seeded row set, mirroring graph-store.test.ts's mockPool.
function mockPool(infraNodeRows: unknown[] = []) {
  const calls: string[] = [];
  const params: unknown[][] = [];
  const client = {
    query: vi.fn((sql: string, p?: unknown[]) => { calls.push(String(sql)); if (p) params.push(p); return Promise.resolve({ rows: [] }); }),
    release: vi.fn(),
  };
  const pool = {
    // rebuildTraceGraph may query infra nodes for bridge-ref resolution
    query: vi.fn(() => Promise.resolve({ rows: infraNodeRows })),
    connect: vi.fn(() => Promise.resolve(client)),
  };
  return { pool, client, calls, params };
}

const span = (over: Partial<TraceSpan>): TraceSpan => ({
  traceId: 't', spanId: 's', service: 'svc', kind: 'SERVER', startMs: 0, durationMs: 1, ...over,
});

describe('rebuildTraceGraph aggregation', () => {
  // checkout(svc) → orders(svc) → postgres(db); checkout runs on k8s workload shop/checkout
  const spans: TraceSpan[] = [
    span({ traceId: 'x', spanId: 'p', service: 'checkout', k8sNamespace: 'shop', k8sPod: 'checkout-1', k8sDeployment: 'checkout' }),
    span({ traceId: 'x', spanId: 'c', parentSpanId: 'p', service: 'orders' }),
    span({ traceId: 'x', spanId: 'q', parentSpanId: 'c', service: 'orders', dbSystem: 'postgresql', dbHost: 'aurora.rds', dbName: 'orders' }),
  ];

  it('produces service/db/workload nodes + calls/queries/runs_on edges (class=trace)', async () => {
    const { pool, client, params } = mockPool();
    const res = await rebuildTraceGraph(pool as never, [new FakeTraceSource(spans, true)], 'RUNT');

    // upserts went out with class='trace'
    expect(params.some((p) => p.includes('trace'))).toBe(true);
    expect(params.some((p) => p.includes('flow') || p.includes('infra'))).toBe(false);

    // node ids inserted
    const allParams = params.flat().map(String);
    expect(allParams).toContain('svc:checkout');
    expect(allParams).toContain('svc:orders');
    expect(allParams.some((s) => s.startsWith('db:postgresql:'))).toBe(true);
    expect(allParams).toContain('workload:shop/checkout');

    // edges: calls (checkout→orders), queries (orders→db), runs_on (checkout→workload)
    expect(allParams).toContain('calls');
    expect(allParams).toContain('queries');
    expect(allParams).toContain('runs_on');

    expect(res.nodes).toBeGreaterThan(0);
    expect(res.edges).toBeGreaterThan(0);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('COMMIT'));
  });

  it('stamps meta.cluster on the workload node from the span k8s.cluster.name (deep-link bridge), ' +
    'and qualifies the node id by cluster so it does not merge with other clusters (PR #155 MAJOR fix)', async () => {
    const withCluster: TraceSpan[] = [
      span({ traceId: 'x', spanId: 'p', service: 'checkout', k8sNamespace: 'shop', k8sDeployment: 'checkout', k8sCluster: 'mall-apne2-az-a' }),
    ];
    const { pool, params } = mockPool();
    await rebuildTraceGraph(pool as never, [new FakeTraceSource(withCluster, true)], 'RUNC');
    // node upsert params = [id, kind, label, metaJson, runId, class]; find the workload node row.
    const wl = params.find((p) => p[0] === 'workload:mall-apne2-az-a/shop/checkout');
    expect(wl).toBeTruthy();
    expect(JSON.parse(String(wl![3])).cluster).toBe('mall-apne2-az-a');
  });

  it('the SAME namespace/deployment on two different clusters produces two distinct workload ' +
    'nodes, each keeping its own cluster (regression: an unqualified id would merge them and pin ' +
    'meta.cluster to whichever span landed first, sending the deep-link to the wrong cluster)', async () => {
    const twoClusters: TraceSpan[] = [
      span({ traceId: 'x', spanId: 'a', service: 'checkout', k8sNamespace: 'shop', k8sDeployment: 'checkout', k8sCluster: 'mall-apne2-az-a' }),
      span({ traceId: 'y', spanId: 'b', service: 'checkout', k8sNamespace: 'shop', k8sDeployment: 'checkout', k8sCluster: 'mall-apne2-az-c' }),
    ];
    const { pool, params } = mockPool();
    await rebuildTraceGraph(pool as never, [new FakeTraceSource(twoClusters, true)], 'RUNC2');
    const wlA = params.find((p) => p[0] === 'workload:mall-apne2-az-a/shop/checkout');
    const wlC = params.find((p) => p[0] === 'workload:mall-apne2-az-c/shop/checkout');
    expect(wlA).toBeTruthy();
    expect(wlC).toBeTruthy();
    expect(JSON.parse(String(wlA![3])).cluster).toBe('mall-apne2-az-a');
    expect(JSON.parse(String(wlC![3])).cluster).toBe('mall-apne2-az-c');
  });

  it('a span with no k8s.cluster.name still gets an unqualified workload node (graceful, no throw)', async () => {
    const noCluster: TraceSpan[] = [
      span({ traceId: 'x', spanId: 'p', service: 'checkout', k8sNamespace: 'shop', k8sDeployment: 'checkout' }),
    ];
    const { pool, params } = mockPool();
    await rebuildTraceGraph(pool as never, [new FakeTraceSource(noCluster, true)], 'RUNC3');
    const wl = params.find((p) => p[0] === 'workload:shop/checkout');
    expect(wl).toBeTruthy();
    expect(JSON.parse(String(wl![3])).cluster).toBeUndefined();
  });

  it('confidence is normalized to (0,1] by the max edge count (spec contract, M3)', async () => {
    // checkout→orders twice (calls count 2), orders→postgres once (queries count 1).
    // max edge count = 2 → calls normalizes to "1", queries to "0.5"; every confidence ∈ (0,1].
    const dup: TraceSpan[] = [
      span({ traceId: 'a', spanId: 'p1', service: 'checkout' }),
      span({ traceId: 'a', spanId: 'c1', parentSpanId: 'p1', service: 'orders' }),
      span({ traceId: 'b', spanId: 'p2', service: 'checkout' }),
      span({ traceId: 'b', spanId: 'c2', parentSpanId: 'p2', service: 'orders' }),
      span({ traceId: 'b', spanId: 'q2', parentSpanId: 'c2', service: 'orders', dbSystem: 'postgresql', dbHost: 'aurora.rds', dbName: 'orders' }),
    ];
    const { pool, params } = mockPool();
    await rebuildTraceGraph(pool as never, [new FakeTraceSource(dup, true)], 'RUNT2');
    // edge upsert params = [source, target, rel, confidence, runId, class]; confidence is index 3.
    const callsEdge = params.find((p) => p.includes('calls'));
    const queriesEdge = params.find((p) => p.includes('queries'));
    expect(callsEdge?.[3]).toBe('1');     // max count (2) → 1
    expect(queriesEdge?.[3]).toBe('0.5'); // 1 / 2
    for (const p of params.filter((x) => x.includes('calls') || x.includes('queries'))) {
      const conf = Number(p[3]);
      expect(conf).toBeGreaterThan(0);
      expect(conf).toBeLessThanOrEqual(1);
    }
  });
});

describe('rebuildTraceGraph multi-source union (registry-driven graph sources, 2026-07-08)', () => {
  it('unions spans across multiple available TraceSource instances', async () => {
    const a = new FakeTraceSource([span({ traceId: 'a', spanId: 'a1', service: 'checkout' })], true);
    const b = new FakeTraceSource([span({ traceId: 'b', spanId: 'b1', service: 'orders' })], true);
    const { pool, params } = mockPool();
    await rebuildTraceGraph(pool as never, [a, b], 'RUNM1');
    const allParams = params.flat().map(String);
    expect(allParams).toContain('svc:checkout');
    expect(allParams).toContain('svc:orders');
  });

  it('an unavailable source among several contributes nothing but does not block the rest', async () => {
    const available = new FakeTraceSource([span({ traceId: 'a', spanId: 'a1', service: 'checkout' })], true);
    const unavailable = new FakeTraceSource([span({ traceId: 'z', spanId: 'z1', service: 'ghost' })], false);
    const { pool, params } = mockPool();
    await rebuildTraceGraph(pool as never, [available, unavailable], 'RUNM2');
    const allParams = params.flat().map(String);
    expect(allParams).toContain('svc:checkout');
    expect(allParams).not.toContain('svc:ghost');
  });

  it('empty sources array + no metrics sources sweeps (allowEmpty) exactly like an unavailable single source', async () => {
    const { pool, calls } = mockPool();
    const res = await rebuildTraceGraph(pool as never, [], 'RUNM3');
    expect(res).toEqual({ nodes: 0, edges: 0 });
    expect(calls.some((s) => s.includes('DELETE FROM topology_edges') && s.includes('class = $1'))).toBe(true);
  });

  it('a metrics-only source (no span sources at all) produces service nodes + calls edges', async () => {
    const metrics = new FakeMetricsCallsSource([{ client: 'checkout', server: 'orders', count: 4 }]);
    const { pool, params } = mockPool();
    const res = await rebuildTraceGraph(pool as never, [], 'RUNM4', [metrics]);
    const allParams = params.flat().map(String);
    expect(allParams).toContain('svc:checkout');
    expect(allParams).toContain('svc:orders');
    expect(allParams).toContain('calls');
    expect(res.nodes).toBeGreaterThan(0);
    expect(res.edges).toBeGreaterThan(0);
  });

  it('an unavailable metrics source contributes nothing (no throw)', async () => {
    const metrics = new FakeMetricsCallsSource([{ client: 'a', server: 'b', count: 1 }], false);
    const { pool, params } = mockPool();
    const res = await rebuildTraceGraph(pool as never, [], 'RUNM5', [metrics]);
    expect(res).toEqual({ nodes: 0, edges: 0 });
    expect(params.some((p) => p.includes('svc:a'))).toBe(false);
  });

  it('metrics-sourced calls merge into the SAME edge as span-derived calls for a matching client/server pair', async () => {
    // span source: checkout→orders once (calls count 1). metrics source: checkout→orders count 3.
    // merged bucket count = 1 + 3 = 4 — proves it's a single summed edge, not two separate rows.
    const spanSrc = new FakeTraceSource([
      span({ traceId: 'a', spanId: 'p1', service: 'checkout' }),
      span({ traceId: 'a', spanId: 'c1', parentSpanId: 'p1', service: 'orders' }),
    ], true);
    const metrics = new FakeMetricsCallsSource([{ client: 'checkout', server: 'orders', count: 3 }]);
    const { pool, params } = mockPool();
    await rebuildTraceGraph(pool as never, [spanSrc], 'RUNM6', [metrics]);
    const callsEdges = params.filter((p) => p.includes('calls'));
    expect(callsEdges).toHaveLength(1); // one merged edge row, not two
    expect(callsEdges[0]?.[3]).toBe('1'); // sole edge → normalizes to max (1)
  });
});

describe('rebuildTraceGraph no-op when source unavailable (T3 + allowEmpty sweep)', () => {
  it('returns {0,0}, never throws, and SWEEPS stale trace rows (allowEmpty) without touching flow/infra', async () => {
    const { pool, calls, params } = mockPool();
    const res = await rebuildTraceGraph(pool as never, [new FakeTraceSource([], false)], 'RUNT3');
    expect(res).toEqual({ nodes: 0, edges: 0 });
    // even with 0 nodes, the destructive sweep must run for class='trace'
    expect(calls.some((s) => s.includes('DELETE FROM topology_edges') && s.includes('class = $1') && s.includes('run_id <> $2'))).toBe(true);
    expect(calls.some((s) => s.includes('DELETE FROM topology_nodes') && s.includes('class = $1') && s.includes('run_id <> $2'))).toBe(true);
    // class scope is trace only
    expect(params.some((p) => p.includes('trace'))).toBe(true);
    expect(params.some((p) => p.includes('flow') || p.includes('infra'))).toBe(false);
  });
});

describe('resolveInfraRef (bridge-ref matcher, pure)', () => {
  const infraNodes = [
    { id: 'rds:awsops-v2-aurora', kind: 'rds', meta: { host: 'awsops-v2-aurora.cluster-xyz.ap-northeast-2.rds.amazonaws.com' } },
    { id: 'ec2:i-1', kind: 'ec2', meta: { host: '10.0.0.1' } },
  ];

  it('matches a trace db host to the infra RDS node id (exact host)', () => {
    expect(resolveInfraRef('awsops-v2-aurora.cluster-xyz.ap-northeast-2.rds.amazonaws.com', infraNodes)).toBe('rds:awsops-v2-aurora');
    // case-insensitive exact
    expect(resolveInfraRef('AWSOPS-V2-AURORA.CLUSTER-XYZ.ap-northeast-2.rds.amazonaws.com', infraNodes)).toBe('rds:awsops-v2-aurora');
  });

  it('matches on the leading DNS label (cluster name) — a safe prefix, not arbitrary substring', () => {
    // trace host = first label of the infra host
    expect(resolveInfraRef('awsops-v2-aurora', infraNodes)).toBe('rds:awsops-v2-aurora');
  });

  it('does NOT false-match a short host as a mid-string substring (fix #2)', () => {
    const nodes = [{ id: 'rds:db', kind: 'rds', meta: { host: 'database.cluster-abc.rds.amazonaws.com' } }];
    // "db" is a substring of "database…" but is NOT the leading label → must NOT match
    expect(resolveInfraRef('db', nodes)).toBeUndefined();
    // a partial leading fragment that isn't a whole label boundary must NOT match either
    expect(resolveInfraRef('data', nodes)).toBeUndefined();
    // the real leading label does match
    expect(resolveInfraRef('database', nodes)).toBe('rds:db');
  });

  it('does NOT match when the infra host is a substring of the (longer) trace host', () => {
    const nodes = [{ id: 'rds:short', kind: 'rds', meta: { host: 'aurora' } }];
    // old bidirectional logic matched host.includes(nh); the tightened matcher must not
    expect(resolveInfraRef('aurora.cluster-xyz.rds.amazonaws.com', nodes)).toBeUndefined();
  });

  it('returns undefined for an unmatched host (node still emitted, no infra_ref)', () => {
    expect(resolveInfraRef('some-other-db.example.com', infraNodes)).toBeUndefined();
    expect(resolveInfraRef(undefined, infraNodes)).toBeUndefined();
    expect(resolveInfraRef('aurora', [])).toBeUndefined();
  });

  it('does NOT match a production-shaped infra node with no host (nothing to match against)', () => {
    // A node lacking meta.host (e.g. a resource type infra-topology never stamps a host for) still
    // can't bridge — this is the general "unmatched" case, not a dormant-feature gap: infra-topology
    // now stamps meta.host for any resource carrying data.endpoint_address (M2, see below).
    const prodInfra = [{ id: 'ec2:i-1', kind: 'ec2', meta: { invType: 'ec2', resourceId: 'i-1' } }];
    expect(resolveInfraRef('awsops-v2-aurora.cluster-xyz.rds.amazonaws.com', prodInfra)).toBeUndefined();
  });

  it('matches a production-shaped RDS infra node once infra-topology stamps meta.host (M2 bridge active)', () => {
    // infra-topology.ts now spreads { host } from data.endpoint_address alongside { invType, resourceId }
    // — the instance-endpoint case matches exactly; this is the case the bridge is designed for.
    const prodInfra = [{
      id: 'rds:db-1', kind: 'rds',
      meta: { invType: 'rds', resourceId: 'db-1', host: 'db-1.abc123.us-east-1.rds.amazonaws.com' },
    }];
    expect(resolveInfraRef('db-1.abc123.us-east-1.rds.amazonaws.com', prodInfra)).toBe('rds:db-1');
  });
});
