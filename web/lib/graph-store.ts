import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { buildFlowGraph, type FlowInput, type FlowKind } from './flow-topology';
import { buildInfraGraph, type Row } from './infra-topology';
import type { TraceSource, TraceSpan, ServiceGraphCall } from './trace-source';

/** Structural (duck-typed) interface for a Prometheus/Mimir service-graph metrics source — matches
 *  trace-source.ts's `MetricsCallsSource` class without importing it directly, so tests can supply a
 *  plain stub. Contributes `calls` edges only (see graph_catalog.py's capability-driven design). */
interface MetricsCallsSourceLike {
  available(): Promise<boolean>;
  calls(windowMins: number): Promise<ServiceGraphCall[]>;
}

// ADR-043 materializer: read synced inventory from Aurora → reuse the SAME builders the UI uses
// (no rule duplication) → upsert the derived graph into topology_nodes/edges under one
// advisory-locked transaction with class-scoped mark-sweep. Runs OFF the BFF request path
// (thin-BFF mandate) — invoked by scripts/v2/graph-rebuild.mjs (and the post-sync worker job).
// Step 1 = traffic-flow (class='flow', buildFlowGraph). Step 2 = resource-relationship
// (class='infra', buildInfraGraph). The two classes share the tables but are key-distinct
// (class is in the node PK + edge UNIQUE), so each rebuild mark-sweeps ONLY its own class.
// EKS pods are live in-cluster, not synced → not materialized here (the UI resolves them live).

// Exclude 'ipResolved' (a Record, not a Row[]) so input[key] narrows to Row[] for the push below.
const TYPE_TO_KEY: Record<string, Exclude<keyof FlowInput, 'ipResolved'>> = {
  route53: 'route53', cloudfront: 'cloudfront', alb: 'alb', nlb: 'nlb', target_group: 'tg',
  waf: 'waf', ec2: 'ec2', lambda: 'lambda', ecs_task: 'ecsTask', s3: 's3',
  // L7 origin resolution: API Gateway (→Lambda/VPC-Link→LB) + CloudFront VPC origins (→ALB/NLB).
  apigatewayv2_api: 'apigatewayv2_api', apigatewayv2_integration: 'apigatewayv2_integration',
  cloudfront_vpc_origin: 'cloudfront_vpc_origin',
};
const TYPES = Object.keys(TYPE_TO_KEY);
const FLOW_LOCK = 0x746f706f;   // 'topo' — flow rebuilds serialize on this key
const INFRA_LOCK = 0x696e6672;  // 'infr' — infra rebuilds use a DISTINCT key so the two can run concurrently
const TRACE_LOCK = 0x74726163;  // 'trac' — trace rebuilds use a DISTINCT key (class='trace' layer)
const NET_TYPES = ['vpc', 'subnet', 'security_group'];
// Trace-layer aggregation bounds — cap top-N nodes/edges; drops are logged (no silent truncation).
const TRACE_WINDOW_MINS = 60;
// Pinned to clickhouse_mcp's MAX_ROWS_CAP (1000): the adapter passes max_rows=cap and the shared
// ClickHouse tool hard-caps result rows at 1000, so a larger LIMIT would be a fiction the tool
// silently truncates. Widening the shared cap for a dormant layer isn't justified (M1).
const TRACE_SPAN_CAP = 1000;
const TRACE_NODE_CAP = 200;
const TRACE_EDGE_CAP = 500;

// Relationship label for a flow edge, derived from the endpoint node kinds (builder edges are untyped).
function relFor(sk: FlowKind | undefined, tk: FlowKind | undefined): string {
  if (sk === 'route53') return 'ROUTES_TO';
  if (sk === 'cloudfront') return tk === 'waf' ? 'PROTECTED_BY' : 'ORIGIN';
  if (sk === 'alb' || sk === 'nlb') return 'TARGETS';
  if (sk === 'tg') return 'TARGETS';
  return 'EDGE';
}

interface GNode { id: string; kind: string; label: string; meta?: Record<string, unknown> }
interface GEdge { source: string; target: string; rel: string; confidence: string }

// Shared writer: one advisory-locked tx, class+account-scoped upsert + mark-sweep. The empty-build
// guard preserves the last-good graph when inventory is unsynced/failed (skip the destructive sweep) —
// this is RIGHT for flow/infra (a transient empty fetch must not wipe a live graph). The trace layer is
// the exception: an intentionally-empty build (source unavailable) MUST sweep its stale rows, so it
// passes `allowEmpty = true`. Default false keeps the flow/infra guard verbatim (one writer, no
// duplicate sweep). The sweep is ACCOUNT-scoped so one account's rebuild never wipes another's rows.
async function writeGraph(pool: Pool, cls: string, lockKey: number, accountId: string, nodes: GNode[], edges: GEdge[], runId: string, allowEmpty = false) {
  if (nodes.length === 0 && !allowEmpty) return { nodes: 0, edges: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    for (const n of nodes) {
      await client.query(
        `INSERT INTO topology_nodes (account_id, id, kind, label, meta, run_id, class)
         VALUES ($7, $1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id, id, class) DO UPDATE
           SET kind = EXCLUDED.kind, label = EXCLUDED.label, meta = EXCLUDED.meta,
               run_id = EXCLUDED.run_id, captured_at = now()`,
        [n.id, n.kind, n.label, JSON.stringify(n.meta ?? {}), runId, cls, accountId],
      );
    }
    for (const e of edges) {
      await client.query(
        `INSERT INTO topology_edges (account_id, source, target, rel, confidence, run_id, class)
         VALUES ($7, $1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id, source, target, rel, class) DO UPDATE
           SET confidence = EXCLUDED.confidence, run_id = EXCLUDED.run_id, captured_at = now()`,
        [e.source, e.target, e.rel, e.confidence, runId, cls, accountId],
      );
    }
    // class+account-scoped mark-sweep: drop only THIS class+account's rows not written by this run.
    await client.query(`DELETE FROM topology_edges WHERE account_id = $3 AND class = $1 AND run_id <> $2`, [cls, runId, accountId]);
    await client.query(`DELETE FROM topology_nodes WHERE account_id = $3 AND class = $1 AND run_id <> $2`, [cls, runId, accountId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { nodes: nodes.length, edges: edges.length };
}

// Accounts present in inventory for the given types (undefined = all types). The host account is
// stored as the 'self' sentinel by sync_lambda; member accounts appear as their 12-digit ids —
// each gets its own materialized graph (topology tables are account-keyed since ADR-043).
async function inventoryAccounts(pool: Pool, types?: string[]): Promise<string[]> {
  const r = types
    ? await pool.query(`SELECT DISTINCT account_id FROM inventory_resources WHERE resource_type = ANY($1)`, [types])
    : await pool.query(`SELECT DISTINCT account_id FROM inventory_resources`);
  const accounts = (r.rows as { account_id: string }[]).map((x) => x.account_id);
  return accounts.length > 0 ? accounts : ['self'];
}

// Step 1 — traffic-flow graph (class='flow'), materialized PER ACCOUNT (host = 'self' sentinel).
export async function rebuildGraph(pool: Pool, runId: string = randomUUID()): Promise<{ nodes: number; edges: number }> {
  const totals = { nodes: 0, edges: 0 };
  for (const account of await inventoryAccounts(pool, TYPES)) {
    const inv = await pool.query(
      `SELECT resource_type, resource_id, region, data FROM inventory_resources
       WHERE account_id = $2 AND resource_type = ANY($1)`,
      [TYPES, account],
    );
    const input: FlowInput = {};
    for (const r of inv.rows as { resource_type: string; resource_id: unknown; region: unknown; data?: object }[]) {
      const key = TYPE_TO_KEY[r.resource_type];
      if (!key) continue;
      (input[key] ??= []).push({ resource_id: r.resource_id, region: r.region, ...(r.data ?? {}) });
    }
    const g = buildFlowGraph(input);
    const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
    // NOTE: FlowEdge.label (L7 ALB path/host:port + API GW route_key) is intentionally NOT persisted —
    // the materialized graph is a TRAVERSAL structure (topology_edges has no label column); the L7
    // labels are a LIVE-only display feature rendered client-side on /topology from buildFlowGraph.
    const edges: GEdge[] = g.edges.map((e) => ({
      source: e.source, target: e.target,
      rel: relFor(kindOf.get(e.source), kindOf.get(e.target)), confidence: e.confidence,
    }));
    const w = await writeGraph(pool, 'flow', FLOW_LOCK, account, g.nodes, edges, runId);
    totals.nodes += w.nodes; totals.edges += w.edges;
  }
  return totals;
}

// Step 2 — resource-relationship graph (class='infra'), materialized PER ACCOUNT.
export async function rebuildInfraGraph(pool: Pool, runId: string = randomUUID()): Promise<{ nodes: number; edges: number }> {
  const totals = { nodes: 0, edges: 0 };
  for (const account of await inventoryAccounts(pool)) {
    const inv = await pool.query(
      `SELECT resource_type, resource_id, region, data FROM inventory_resources WHERE account_id = $1`,
      [account],
    );
    const rows = inv.rows as Row[];
    const isNet = (t: unknown) => NET_TYPES.includes(String(t));
    const g = buildInfraGraph({
      resources: rows.filter((r) => !isNet(r.resource_type)),
      vpcs: rows.filter((r) => r.resource_type === 'vpc'),
      subnets: rows.filter((r) => r.resource_type === 'subnet'),
      securityGroups: rows.filter((r) => r.resource_type === 'security_group'),
    });
    const edges: GEdge[] = g.edges.map((e) => ({ source: e.source, target: e.target, rel: e.rel, confidence: 'observed' }));
    const w = await writeGraph(pool, 'infra', INFRA_LOCK, account, g.nodes, edges, runId);
    totals.nodes += w.nodes; totals.edges += w.edges;
  }
  return totals;
}

// --- Step 3 — trace-level (application) graph (class='trace') -------------------------------------
// A service call-graph derived from distributed traces (otel first), built OFF the BFF like flow/infra.
// Dormant until the otel pipeline lands spans: source.available()===false → an empty layer that STILL
// sweeps stale trace rows (allowEmpty), never touching flow/infra. See the 2026-06-25 trace-topology spec.

interface InfraNodeLike { id: string; kind?: string; meta?: Record<string, unknown> | null }

// Pure bridge-ref matcher: resolve a trace db host against the current infra-layer nodes → the infra
// RDS/Aurora node id whose meta.host matches. Matching is SAFE (no arbitrary bidirectional substring,
// which false-matched short hosts like "db" against "database.rds.amazonaws.com"): we accept an exact
// host match, OR a leading-DNS-label match where the trace host is the first label of the infra host
// (e.g. "awsops-v2-aurora" → "awsops-v2-aurora.cluster-xyz.…rds.amazonaws.com"). Unmatched → undefined
// (the db node is still emitted, just without meta.infra_ref). No DB access — unit-testable on inputs.
export function resolveInfraRef(dbHost: string | undefined, infraNodes: InfraNodeLike[]): string | undefined {
  if (!dbHost) return undefined;
  const host = String(dbHost).toLowerCase();
  if (!host) return undefined;
  for (const n of infraNodes) {
    const nh = String((n.meta as Record<string, unknown> | undefined)?.host ?? '').toLowerCase();
    if (!nh) continue;
    if (nh === host) return n.id;
    // Leading-label match: the trace host equals the first DNS label of the infra host, OR is a
    // dotted prefix of it (`${host}.` is a real label boundary — never a mid-label substring).
    if (nh.split('.')[0] === host || nh.startsWith(`${host}.`)) return n.id;
  }
  return undefined;
}

export async function rebuildTraceGraph(
  pool: Pool,
  sources: TraceSource[],
  runId: string = randomUUID(),
  metricsSources: MetricsCallsSourceLike[] = [],
): Promise<{ nodes: number; edges: number }> {
  // Registry-driven (2026-07-08): each source's readiness is independent — filter down to the
  // available ones and union their contributions. No-op path (nothing available anywhere): empty
  // trace layer, but DO sweep stale trace rows.
  const availableSources: TraceSource[] = [];
  for (const s of sources) if (await s.available()) availableSources.push(s);
  const availableMetricsSources: MetricsCallsSourceLike[] = [];
  for (const m of metricsSources) if (await m.available()) availableMetricsSources.push(m);
  // Trace stays host-scoped ('self'): spans have no AWS-account dimension.
  if (availableSources.length === 0 && availableMetricsSources.length === 0) {
    return writeGraph(pool, 'trace', TRACE_LOCK, 'self', [], [], runId, true);
  }

  const spanLists = await Promise.all(availableSources.map((s) => s.recentSpans(TRACE_WINDOW_MINS, TRACE_SPAN_CAP)));
  const spans = spanLists.flat();

  // Resolve bridge refs against the current infra-layer nodes (best-effort; failure is non-fatal).
  let infraNodes: InfraNodeLike[] = [];
  try {
    const r = await pool.query(
      `SELECT id, kind, meta FROM topology_nodes WHERE account_id = 'self' AND class = 'infra'`,
    );
    infraNodes = r.rows as InfraNodeLike[];
  } catch {
    infraNodes = [];
  }

  // Index spans by spanId so a child can look up its parent's service (the calls edge).
  const byId = new Map<string, TraceSpan>();
  for (const s of spans) byId.set(s.spanId, s);

  const nodes = new Map<string, GNode>();
  const edgeCounts = new Map<string, { source: string; target: string; rel: string; n: number }>();
  const bump = (source: string, target: string, rel: string, inc = 1) => {
    const k = `${source} ${target} ${rel}`;
    const e = edgeCounts.get(k);
    if (e) e.n += inc; else edgeCounts.set(k, { source, target, rel, n: inc });
  };
  const svcId = (svc: string) => `svc:${svc}`;
  const dbId = (sys: string, hostOrName: string) => `db:${sys}:${hostOrName}`;
  // cluster-qualified when known: the same namespace/deployment name commonly exists on more than
  // one onboarded EKS cluster (e.g. the same MSA replicated across az-a/az-c) — an unqualified id
  // would merge them into one node whose meta.cluster is whichever span happened to land first,
  // sending the service-map deep-link to the wrong cluster (review finding, PR #155).
  const wlId = (ns: string, dep: string, cluster?: string) =>
    cluster ? `workload:${cluster}/${ns}/${dep}` : `workload:${ns}/${dep}`;
  const svcSpanCount = new Map<string, number>();

  for (const s of spans) {
    if (!s.service) continue;
    const sid = svcId(s.service);
    svcSpanCount.set(sid, (svcSpanCount.get(sid) ?? 0) + 1);
    if (!nodes.has(sid)) {
      nodes.set(sid, { id: sid, kind: 'service', label: s.service, meta: { spanCount: 0 } });
    }
    // service → service (calls): parent span's service → this span's service when both differ
    if (s.parentSpanId) {
      const parent = byId.get(s.parentSpanId);
      if (parent?.service && parent.service !== s.service) {
        const psid = svcId(parent.service);
        if (!nodes.has(psid)) nodes.set(psid, { id: psid, kind: 'service', label: parent.service, meta: { spanCount: 0 } });
        bump(psid, sid, 'calls');
      }
    }
    // service → db (queries): a DB-client span carries db.system
    if (s.dbSystem) {
      const hostOrName = s.dbHost || s.dbName || 'unknown';
      // Key the node on host AND dbName when both exist: two logical DBs on one Aurora/RDS host
      // (same host, different db.name) are DISTINCT nodes — keying on host alone collapsed them into
      // one node and merged their `queries` edge counts (F1), which also skewed the confidence norm.
      const idKey = s.dbHost && s.dbName ? `${s.dbHost}/${s.dbName}` : hostOrName;
      const id = dbId(s.dbSystem, idKey);
      if (!nodes.has(id)) {
        // infra_ref bridge (M2, active): infra-topology.ts stamps meta.host from data.endpoint_address
        // on RDS nodes. Known ceiling: sync covers rds *instances* only, whose endpoint_address is the
        // instance endpoint (e.g. "db-1.xyz…"), not the Aurora cluster/writer endpoint apps typically
        // connect through — a trace db.host on the cluster endpoint won't share a leading DNS label
        // with the instance endpoint, so it won't match. Upgrade path: sync an rds_cluster type.
        const infra_ref = resolveInfraRef(s.dbHost, infraNodes);
        const meta: Record<string, unknown> = { system: s.dbSystem, host: s.dbHost ?? null };
        if (s.dbName) meta.dbName = s.dbName;
        if (infra_ref) meta.infra_ref = infra_ref;
        nodes.set(id, { id, kind: 'db', label: `${s.dbSystem}:${hostOrName}`, meta });
      }
      bump(sid, id, 'queries');
    }
    // service → workload (runs_on): the workload the span originates from (k8s attrs)
    if (s.k8sNamespace && s.k8sDeployment) {
      const id = wlId(s.k8sNamespace, s.k8sDeployment, s.k8sCluster);
      if (!nodes.has(id)) {
        // workload eks_ref/tg_ref bridge refs are best-effort; EKS node data isn't readily queryable
        // here (pods are live in-cluster, not synced). TODO(trace-topology): resolve eks_ref/tg_ref.
        // meta.cluster (from the span's k8s.cluster.name resource attr) lets the service-map UI
        // deep-link to /topology?cluster=eks:<name> — the nav bridge to the main flow topology's
        // cluster filter (which reads the same cluster name off live-resolved EKS target nodes).
        // ponytail: a span with no k8s.cluster.name still gets an unqualified node (deep-link just
        // stays inactive for it, graceful) rather than trying to merge it into a clustered node —
        // resource attrs are consistently present-or-absent per service, so real mixing is rare.
        const meta: Record<string, unknown> = { namespace: s.k8sNamespace, deployment: s.k8sDeployment, pods: [] as string[] };
        if (s.k8sCluster) meta.cluster = s.k8sCluster;
        const label = s.k8sCluster
          ? `${s.k8sNamespace}/${s.k8sDeployment} @${s.k8sCluster}`
          : `${s.k8sNamespace}/${s.k8sDeployment}`;
        nodes.set(id, { id, kind: 'workload', label, meta });
      }
      if (s.k8sPod) {
        const pods = (nodes.get(id)!.meta!.pods as string[]);
        if (!pods.includes(s.k8sPod)) pods.push(s.k8sPod);
      }
      bump(sid, id, 'runs_on');
    }
  }

  // Fold in metrics-sourced service-graph calls (Prometheus/Mimir, Istio mesh or Tempo
  // metrics-generator) — aggregate `calls` edges only, no spans, so they merge into the SAME
  // edgeCounts bucket as any span-derived `calls` edge for a matching client/server pair (summed,
  // not a separate row) and never touch `queries`/`runs_on` (capability-driven design).
  for (const m of availableMetricsSources) {
    const calls = await m.calls(TRACE_WINDOW_MINS);
    for (const c of calls) {
      const csid = svcId(c.client);
      const ssid = svcId(c.server);
      if (!nodes.has(csid)) nodes.set(csid, { id: csid, kind: 'service', label: c.client, meta: { spanCount: 0 } });
      if (!nodes.has(ssid)) nodes.set(ssid, { id: ssid, kind: 'service', label: c.server, meta: { spanCount: 0 } });
      bump(csid, ssid, 'calls', c.count);
    }
  }

  // Stamp service spanCount.
  for (const [id, c] of svcSpanCount) {
    const n = nodes.get(id);
    if (n?.meta) n.meta.spanCount = c;
  }

  // Cap top-N (by span/edge volume) and note drops — no silent truncation.
  let nodeList = [...nodes.values()];
  let edgeList = [...edgeCounts.values()];
  const nodeDrops = Math.max(0, nodeList.length - TRACE_NODE_CAP);
  const edgeDrops = Math.max(0, edgeList.length - TRACE_EDGE_CAP);
  if (nodeDrops > 0) {
    // Rank by node kind FIRST (db/workload are structurally important and carry spanCount 0 → ranking
    // by spanCount alone would drop them before trivial services), then by spanCount within a kind.
    const kindRank = (k: string) => (k === 'db' ? 2 : k === 'workload' ? 1 : 0); // services last
    nodeList = nodeList
      .sort((a, b) =>
        kindRank(b.kind) - kindRank(a.kind) ||
        Number((b.meta?.spanCount as number) ?? 0) - Number((a.meta?.spanCount as number) ?? 0))
      .slice(0, TRACE_NODE_CAP);
  }
  if (edgeDrops > 0) {
    edgeList = edgeList.sort((a, b) => b.n - a.n).slice(0, TRACE_EDGE_CAP);
  }
  if (nodeDrops > 0 || edgeDrops > 0) {
    console.warn(`[graph-rebuild] trace cap: dropped ${nodeDrops} nodes, ${edgeDrops} edges (caps ${TRACE_NODE_CAP}/${TRACE_EDGE_CAP})`);
  }
  // Drop edges whose endpoints were capped out.
  const keep = new Set(nodeList.map((n) => n.id));
  edgeList = edgeList.filter((e) => keep.has(e.source) && keep.has(e.target));

  // confidence ∈ (0,1] per the trace-topology spec: normalize the raw edge span-count by the max
  // emitted count (max-edge normalization — needs no total-span knowledge). Emitted as a decimal
  // string ("0.5"); NOTE this makes the shared `confidence` column polymorphic vs flow/infra's
  // 'observed' keyword, so consumers must tolerate both a keyword and a numeric string (M3).
  const maxN = edgeList.reduce((m, e) => Math.max(m, e.n), 0);
  const edges: GEdge[] = edgeList.map((e) => ({
    source: e.source, target: e.target, rel: e.rel,
    confidence: maxN > 0 ? String(e.n / maxN) : '0',
  }));
  return writeGraph(pool, 'trace', TRACE_LOCK, 'self', nodeList, edges, runId, true);
}
