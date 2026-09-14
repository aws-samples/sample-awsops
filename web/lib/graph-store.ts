import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { buildFlowGraph, type FlowInput, type FlowKind } from './flow-topology';
import { buildInfraGraph, type Row } from './infra-topology';
import type { TraceSource, TraceSpan, ServiceGraphCall, SourceRead } from './trace-source';
import { buildTraceGraph, type InfraNodeLike } from './trace-graph';
import { writeGraphState, type GraphAttempt, type GraphClass } from './graph-state';
import { currentAccountId } from './account';
import { graphTransaction, inventoryAccounts, inventorySnapshot, inventoryAttempt, INFRA_TYPES, type InventoryRow } from './graph-inventory';
export { resolveInfraRef } from './trace-graph';

/** Structural (duck-typed) interface for a Prometheus/Mimir service-graph metrics source — matches
 *  trace-source.ts's `MetricsCallsSource` class without importing it directly, so tests can supply a
 *  plain stub. Contributes `calls` edges only (see graph_catalog.py's capability-driven design). */
interface MetricsCallsSourceLike {
  available(): Promise<boolean>;
  calls(windowMins: number, endMs?: number): Promise<SourceRead<ServiceGraphCall>>;
}

// Inventory materialization runs in the gated web instrumentation timer or manual runner.
// Read/build per account with explicit budgets; only publication holds the class lock.
// EKS pods remain live-only. No worker job or cloud-side scheduling is introduced here.

// Exclude 'ipResolved' (a Record, not a Row[]) so input[key] narrows to Row[] for the push below.
const TYPE_TO_KEY: Record<string, Exclude<keyof FlowInput, 'ipResolved'>> = {
  route53: 'route53', cloudfront: 'cloudfront', alb: 'alb', nlb: 'nlb', target_group: 'tg',
  waf: 'waf', ec2: 'ec2', lambda: 'lambda', ecs_task: 'ecsTask', s3: 's3', subnet: 'subnet',
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
interface GEdge { source: string; target: string; rel: string; confidence: string; meta?: object }

export interface GraphRebuildResult {
  nodes: number; edges: number; published: number; retained: number; skipped: number;
  degraded: number; reasons: string[]; accountsTruncated?: boolean;
}
const emptyResult = (): GraphRebuildResult =>
  ({ nodes: 0, edges: 0, published: 0, retained: 0, skipped: 0, degraded: 0, reasons: [] });

// All classes share atomic state/row publication, bounded batches and nonwaiting locks.
async function writeGraph(pool: Pool, cls: GraphClass, lockKey: number, accountId: string,
  nodes: GNode[], edges: GEdge[], runId: string, attempt: GraphAttempt): Promise<GraphRebuildResult> {
  const publish = (value: GraphAttempt) => graphTransaction(pool, false, async client => {
    const locked = await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [lockKey]);
    if (!locked.rows[0]?.acquired) return { ...emptyResult(), skipped: 1, reasons: ['publication_busy'] };
    if (!await writeGraphState(client, accountId, value, cls))
      return { ...emptyResult(), skipped: 1, reasons: ['superseded'] };
    if (!value.publish) return { ...emptyResult(), retained: 1,
      reasons: cls === 'trace' ? [`collection_${value.status}`] : [] };
    await replaceGraph(client, cls, accountId, nodes, edges, runId);
    return { ...emptyResult(), nodes: nodes.length, edges: edges.length,
      published: 1, degraded: value.status === 'partial' ? 1 : 0 };
  });
  try { return await publish(attempt); }
  catch (error) {
    // The failed transaction rolled back BOTH state and rows. Best-effort failure evidence
    // uses a fresh bounded transaction; a newer attempt still wins. Always propagate failure.
    await publish({ ...attempt, status: 'error', publish: false,
      details: { ...attempt.details, retainedPrevious: true, failureReason: 'publication_failed' } }).catch(() => {});
    throw error;
  }
}

// One inventory rebuild at a time per request-serving pool; concurrent callers skip, not queue.
const inventoryBusy = new WeakSet<Pool>();

async function replaceGraph(client: PoolClient, cls: GraphClass, account: string,
  nodes: GNode[], edges: GEdge[], runId: string) {
  // Batched writes keep the publication lock brief even at the bounded input limit.
  for (let offset = 0; offset < nodes.length; offset += 200) {
    await client.query(`INSERT INTO topology_nodes(account_id,id,kind,label,meta,run_id,class)
      SELECT $1,n.id,n.kind,n.label,coalesce(n.meta,'{}'::jsonb),$3,$2
      FROM jsonb_to_recordset($4::jsonb) AS n(id text,kind text,label text,meta jsonb)
      ON CONFLICT(account_id,id,class) DO UPDATE SET kind=EXCLUDED.kind,label=EXCLUDED.label,
        meta=EXCLUDED.meta,run_id=EXCLUDED.run_id,captured_at=now()`,
    [account, cls, runId, JSON.stringify(nodes.slice(offset, offset + 200))]);
  }
  const trace = cls === 'trace'; // Inventory preserves existing edge metadata and schema compatibility.
  for (let offset = 0; offset < edges.length; offset += 200) {
    await client.query(`INSERT INTO topology_edges(account_id,source,target,rel,confidence,run_id,class${trace ? ',meta' : ''})
      SELECT $1,e.source,e.target,e.rel,e.confidence,$3,$2${trace ? ",coalesce(e.meta,'{}'::jsonb)" : ''}
      FROM jsonb_to_recordset($4::jsonb) AS e(source text,target text,rel text,confidence text,meta jsonb)
      ON CONFLICT(account_id,source,target,rel,class) DO UPDATE SET confidence=EXCLUDED.confidence,
        run_id=EXCLUDED.run_id,captured_at=now()${trace ? ',meta=EXCLUDED.meta' : ''}`,
    [account, cls, runId, JSON.stringify(edges.slice(offset, offset + 200))]);
  }
  await client.query('DELETE FROM topology_edges WHERE account_id=$1 AND class=$2 AND run_id<>$3', [account, cls, runId]);
  await client.query('DELETE FROM topology_nodes WHERE account_id=$1 AND class=$2 AND run_id<>$3', [account, cls, runId]);
}

async function rebuildInventory(pool: Pool, cls: GraphClass, lock: number, runId: string,
  types: string[], build: (rows: InventoryRow[]) => { nodes: GNode[]; edges: GEdge[] }): Promise<GraphRebuildResult> {
  const totals = emptyResult();
  const reason = (value: string) => { if (!totals.reasons.includes(value)) totals.reasons.push(value); };
  if (inventoryBusy.has(pool)) return { ...totals, skipped: 1, reasons: ['rebuild_busy'] };
  inventoryBusy.add(pool);
  const attemptedAt = new Date(Date.now()).toISOString();
  const deadline = performance.now() + 30_000;
  let account = 'self';
  let attempt: GraphAttempt | undefined;
  let publishing = false;
  try {
    const accounts = await inventoryAccounts(pool, cls, types);
    if (!accounts) return { ...totals, skipped: 1, reasons: ['state_schema_missing'] };
    if (accounts.length > 100) { totals.skipped++; totals.accountsTruncated = true; reason('account_limit'); }
    for (const [index, current] of accounts.slice(0, 100).entries()) {
      if (performance.now() >= deadline) {
        totals.skipped += Math.min(accounts.length, 100) - index; reason('time_limit'); break;
      }
      account = current; attempt = undefined; publishing = false;
      const snapshot = await inventorySnapshot(pool, cls, account, types);
      attempt = inventoryAttempt(snapshot, types, cls, account, attemptedAt);
      if (snapshot.truncated) reason('snapshot_limit');
      const graph = attempt.publish ? build(snapshot.rows) : { nodes: [], edges: [] };
      if (graph.nodes.length > 4000 || graph.edges.length > 8000
        || Buffer.byteLength(JSON.stringify(graph)) > 8 * 1024 * 1024) {
        attempt.publish = false; attempt.status = 'partial';
        attempt.details = { ...attempt.details, retainedPrevious: true, graphTruncated: true };
        reason('graph_limit');
      } else if (attempt.publish && attempt.status !== 'partial') {
        attempt.status = graph.nodes.length ? 'ok' : 'empty';
      }
      publishing = true;
      const outcome = await writeGraph(pool, cls, lock, account, graph.nodes, graph.edges, runId, attempt);
      for (const key of ['nodes', 'edges', 'published', 'retained', 'skipped', 'degraded'] as const) totals[key] += outcome[key];
      outcome.reasons.forEach(reason);
      // Yield between accounts, with no pool connection or lock held.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return totals;
  } catch (error) {
    // Failed publication rolls back rows AND state. Record only a bounded safe category;
    // preserve previous sources/clocks. A newer publication still wins the ordering guard.
    if (!publishing) await writeGraph(pool, cls, lock, account, [], [], runId, { attemptedAt, status: 'error', publish: false,
      details: { sources: attempt?.details.sources ?? [], retainedPrevious: true,
        failureReason: attempt ? 'publication_failed' : 'source_read_failed' } }).catch(() => {});
    throw error;
  } finally { inventoryBusy.delete(pool); }
}

export async function rebuildGraph(pool: Pool, runId: string = randomUUID()) {
  return rebuildInventory(pool, 'flow', FLOW_LOCK, runId, TYPES, rows => {
    const input: FlowInput = {};
    for (const row of rows) {
      const key = TYPE_TO_KEY[row.resource_type];
      if (key) (input[key] ??= []).push({ resource_id: row.resource_id, region: row.region, ...(row.data as object ?? {}) });
    }
    const graph = buildFlowGraph(input);
    const kinds = new Map(graph.nodes.map(node => [node.id, node.kind]));
    // L7 display labels remain live-only; persisted edges keep the existing traversal contract.
    return { nodes: graph.nodes, edges: graph.edges.map(edge => ({ source: edge.source, target: edge.target,
      rel: relFor(kinds.get(edge.source), kinds.get(edge.target)), confidence: edge.confidence })) };
  });
}

export async function rebuildInfraGraph(pool: Pool, runId: string = randomUUID()) {
  return rebuildInventory(pool, 'infra', INFRA_LOCK, runId, INFRA_TYPES, rows => {
    const graph = buildInfraGraph({
      resources: rows.filter(row => !NET_TYPES.includes(row.resource_type)),
      vpcs: rows.filter(row => row.resource_type === 'vpc'),
      subnets: rows.filter(row => row.resource_type === 'subnet'),
      securityGroups: rows.filter(row => row.resource_type === 'security_group'),
    });
    return { nodes: graph.nodes, edges: graph.edges.map(edge => ({ source: edge.source, target: edge.target,
      rel: edge.rel, confidence: 'observed' })) };
  });
}

// Trace collection and materialization share one explicit evidence window.
export async function rebuildTraceGraph(
  pool: Pool,
  sources: TraceSource[],
  runId: string = randomUUID(),
  metricsSources: MetricsCallsSourceLike[] = [],
): Promise<GraphRebuildResult> {
  const schema = await pool.query(
    `SELECT to_regclass('public.topology_graph_state') IS NOT NULL AS ready`,
  );
  if (schema.rows[0]?.ready !== true) return { ...emptyResult(), skipped: 1, reasons: ['state_schema_missing'] };
  const endMs = Date.now();
  const startMs = endMs - TRACE_WINDOW_MINS * 60_000;
  const failed = <T>(sourceId: string): SourceRead<T> => ({
    sourceId, items: [], status: 'error', reasons: ['source_failed'],
    windowStartMs: startMs, windowEndMs: endMs,
  });
  // Adapter status, not a separate readiness probe, distinguishes absent config from a failed read.
  const spanReads = await Promise.all(sources.map(async (source, i) => {
    try { return await source.recentSpans(TRACE_WINDOW_MINS, TRACE_SPAN_CAP, endMs); }
    catch { return failed<TraceSpan>(`trace:${i}`); }
  }));
  const metricReads = await Promise.all(metricsSources.map(async (source, i) => {
    try { return await source.calls(TRACE_WINDOW_MINS, endMs); }
    catch { return failed<ServiceGraphCall>(`metrics:${i}`); }
  }));
  const reads = [...spanReads, ...metricReads];
  const sourceDetails = reads.map((read) => ({
    sourceId: read.sourceId, status: read.status, reasons: read.reasons,
    itemCount: read.items.length, windowStartMs: read.windowStartMs, windowEndMs: read.windowEndMs,
  }));
  const hasFailure = reads.some((read) => read.status === 'error' || read.status === 'unavailable');
  const partial = reads.some((read) => read.status === 'partial');
  const spans = spanReads.flatMap((read) => read.items.map((span) => ({ ...span, sourceId: span.sourceId ?? read.sourceId })));
  const calls = metricReads.flatMap((read) => read.items.map((call) => ({
    ...call,
    clientIdentity: { ...call.clientIdentity, sourceId: call.clientIdentity?.sourceId ?? read.sourceId },
    serverIdentity: { ...call.serverIdentity, sourceId: call.serverIdentity?.sourceId ?? read.sourceId },
  })));
  if (!reads.length || hasFailure || (partial && !spans.length && !calls.length)) {
    const status = reads.some((read) => read.status === 'error') ? 'error'
      : partial ? 'partial' : 'unavailable';
    return writeGraph(pool, 'trace', TRACE_LOCK, 'self', [], [], runId, {
      status, attemptedAt: new Date(endMs).toISOString(), publish: false,
      details: { sources: sourceDetails, retainedPrevious: true, windowStartMs: startMs, windowEndMs: endMs },
    });
  }
  let infraNodes: InfraNodeLike[] = [];
  let infraUnavailable = false;
  try {
    const result = await pool.query(
      `SELECT id, kind, meta FROM topology_nodes WHERE account_id = 'self' AND class = 'infra'`,
    );
    infraNodes = result.rows as InfraNodeLike[];
  } catch { infraUnavailable = true; }
  const graph = buildTraceGraph(spans, calls, infraNodes, currentAccountId());
  // Preserve structurally important DB/queue/workload nodes before ranking service volume.
  const rank = (kind: string) => kind === 'service' ? 0 : 1;
  const nodes = graph.nodes.sort((a, b) => rank(b.kind) - rank(a.kind)
    || Number(b.meta.spanCount ?? 0) - Number(a.meta.spanCount ?? 0)).slice(0, TRACE_NODE_CAP);
  const kept = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target))
    .sort((a, b) => (b.meta.spanCount + b.meta.metricCount) - (a.meta.spanCount + a.meta.metricCount))
    .slice(0, TRACE_EDGE_CAP);
  const nodeDrops = graph.nodes.length - nodes.length;
  const edgeDrops = graph.edges.length - edges.length;
  const incomplete = partial || infraUnavailable || nodeDrops > 0 || edgeDrops > 0
    || graph.orphanSpans > 0 || graph.invalidSpans > 0 || graph.unresolvedMessaging > 0;
  const status = incomplete ? 'partial' : nodes.length ? 'ok' : 'empty';
  return writeGraph(pool, 'trace', TRACE_LOCK, 'self', nodes, edges, runId, {
    status, attemptedAt: new Date(endMs).toISOString(), publish: true,
    details: {
      sources: sourceDetails, retainedPrevious: false, windowStartMs: startMs, windowEndMs: endMs,
      nodeDrops, edgeDrops, orphanSpans: graph.orphanSpans, invalidSpans: graph.invalidSpans,
      unresolvedMessaging: graph.unresolvedMessaging,
      infraUnavailable,
    },
  });
}
