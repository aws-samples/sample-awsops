import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { buildFlowGraph, type FlowInput, type FlowKind } from './flow-topology';
import { buildInfraGraph, type Row } from './infra-topology';
import type { TraceSource, TraceSpan, ServiceGraphCall, SourceRead } from './trace-source';
import { buildTraceGraph, type InfraNodeLike } from './trace-graph';
import { writeGraphState, type GraphAttempt } from './graph-state';
import { currentAccountId } from './account';
export { resolveInfraRef } from './trace-graph';

/** Structural (duck-typed) interface for a Prometheus/Mimir service-graph metrics source — matches
 *  trace-source.ts's `MetricsCallsSource` class without importing it directly, so tests can supply a
 *  plain stub. Contributes `calls` edges only (see graph_catalog.py's capability-driven design). */
interface MetricsCallsSourceLike {
  available(): Promise<boolean>;
  calls(windowMins: number, endMs?: number): Promise<SourceRead<ServiceGraphCall>>;
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

// Shared writer: one advisory-locked tx, class+account-scoped upsert + mark-sweep. The empty-build
// guard preserves the last-good graph when inventory is unsynced/failed (skip the destructive sweep) —
// this is RIGHT for flow/infra (a transient empty fetch must not wipe a live graph). The trace layer is
// the exception: an intentionally-empty build (source unavailable) MUST sweep its stale rows, so it
// passes `allowEmpty = true`. Default false keeps the flow/infra guard verbatim (one writer, no
// duplicate sweep). The sweep is ACCOUNT-scoped so one account's rebuild never wipes another's rows.
async function writeGraph(pool: Pool, cls: string, lockKey: number, accountId: string, nodes: GNode[], edges: GEdge[], runId: string, allowEmpty = false, attempt?: GraphAttempt) {
  if (nodes.length === 0 && !allowEmpty) return { nodes: 0, edges: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    if (attempt) {
      const current = await writeGraphState(client, accountId, attempt);
      if (!current || !attempt.publish) {
        await client.query('COMMIT');
        return { nodes: 0, edges: 0 };
      }
    }
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
      const hasMetadata = e.meta !== undefined;
      await client.query(
        `INSERT INTO topology_edges (account_id, source, target, rel, confidence, run_id, class${hasMetadata ? ', meta' : ''})
         VALUES ($7, $1, $2, $3, $4, $5, $6${hasMetadata ? ', $8::jsonb' : ''})
         ON CONFLICT (account_id, source, target, rel, class) DO UPDATE
           SET confidence = EXCLUDED.confidence, run_id = EXCLUDED.run_id, captured_at = now()
               ${hasMetadata ? ', meta = EXCLUDED.meta' : ''}`,
        [e.source, e.target, e.rel, e.confidence, runId, cls, accountId,
          ...(hasMetadata ? [JSON.stringify(e.meta)] : [])],
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

// Trace collection and materialization share one explicit evidence window.
export async function rebuildTraceGraph(
  pool: Pool,
  sources: TraceSource[],
  runId: string = randomUUID(),
  metricsSources: MetricsCallsSourceLike[] = [],
): Promise<{ nodes: number; edges: number }> {
  const schema = await pool.query(
    `SELECT to_regclass('public.topology_graph_state') IS NOT NULL AS ready`,
  );
  if (schema.rows[0]?.ready !== true) return { nodes: 0, edges: 0 };
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
    return writeGraph(pool, 'trace', TRACE_LOCK, 'self', [], [], runId, true, {
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
  return writeGraph(pool, 'trace', TRACE_LOCK, 'self', nodes, edges, runId, true, {
    status, attemptedAt: new Date(endMs).toISOString(), publish: true,
    details: {
      sources: sourceDetails, retainedPrevious: false, windowStartMs: startMs, windowEndMs: endMs,
      nodeDrops, edgeDrops, orphanSpans: graph.orphanSpans, invalidSpans: graph.invalidSpans,
      unresolvedMessaging: graph.unresolvedMessaging,
      infraUnavailable,
    },
  });
}
