import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { downstream, upstream, FANOUT_CAP } from '@/lib/graph-query';
import { readGraphState, graphDiagnostic, type GraphClass } from '@/lib/graph-state';
import { graphReadTransaction, GraphReadBusy } from '@/lib/graph-transaction';
import { queueClaimMeta } from '@/lib/trace-evidence';

export const dynamic = 'force-dynamic';

function evidenceNodes(rows: Record<string, any>[], cls: string) {
  return cls !== 'trace' ? rows : rows.map(node =>
    node.kind === 'queue' ? { ...node, meta: queueClaimMeta(node.meta ?? {}) } : node);
}

function evidenceEdges(rows: Record<string, any>[], cls: string) {
  if (cls !== 'trace') return rows;
  return rows.map((edge) => {
    const spans = edge.meta?.spanCount;
    const metrics = edge.meta?.metricCount;
    const observed = typeof spans === 'number' && Number.isFinite(spans) && spans >= 0
      && typeof metrics === 'number' && Number.isFinite(metrics) && metrics >= 0
      && spans + metrics > 0;
    return { ...edge, confidence: observed ? 'observed' : 'unknown' };
  });
}

const NODE_LIMIT = 4000, EDGE_LIMIT = 8000;
const unknownCollection = (cls: GraphClass) => ({ status: 'unknown', stale: true,
  captured_at: null, attempted_at: null, sources: [], evidenceKind: cls === 'trace' ? 'trace' : 'inventory' });

// Bounds apply before edge metadata serialization/deduplication. Retain distinct returned
// evidence, constrain edges to visible nodes, and disclose any omitted raw rows.
async function graphRows(client: Parameters<Parameters<typeof graphReadTransaction>[1]>[0],
  cls: GraphClass, account: string, ids?: string[]) {
  const selection = `SELECT DISTINCT ON (id) id, kind, label, meta, captured_at FROM topology_nodes
    WHERE ($2 = '__all__' OR account_id = $2) AND class = $1 ${ids ? 'AND id = ANY($3)' : ''}
    ORDER BY id, captured_at DESC`;
  const nodes = await client.query(ids
    ? `SELECT * FROM (${selection}) selected ORDER BY (id=$4) DESC,id LIMIT ${NODE_LIMIT + 1}`
    : `${selection} LIMIT ${NODE_LIMIT + 1}`, ids ? [cls, account, ids, ids[0]] : [cls, account]);
  const visible = nodes.rows.slice(0, NODE_LIMIT);
  const edges = await client.query(`SELECT source, target, rel, confidence, to_jsonb(e)->'meta' AS meta FROM topology_edges e
    WHERE ($2 = '__all__' OR account_id = $2) AND class = $1 AND source = ANY($3) AND target = ANY($3)
    ORDER BY source, target, rel, captured_at DESC LIMIT ${EDGE_LIMIT + 1}`, [cls, account, visible.map(row => row.id)]);
  return { nodes: visible,
    edges: [...new Map(edges.rows.slice(0, EDGE_LIMIT).map(row => [JSON.stringify(row), row])).values()],
    truncated: nodes.rows.length > NODE_LIMIT || edges.rows.length > EDGE_LIMIT };
}

// Read-only graph access (ADR-043). GET returns the materialized topology graph for a class
// (flow|infra), or — when ?from=<nodeId> is passed — the per-resource SUBGRAPH: the node + its
// up/down neighborhood within `depth` hops (capped per hop by graph-query). No rebuild here —
// rebuilds run separately in the gated timer or scripts/v2/graph-rebuild.mjs manual runner.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  // Explicit allow-list (flow|infra|trace) — reject unknown rather than silently serving the WRONG
  // layer (a ternary fell back to 'flow' for any unknown value, so ?class=trace returned flow).
  const raw = url.searchParams.get('class') ?? 'flow';
  const ALLOWED = ['flow', 'infra', 'trace'];
  if (!ALLOWED.includes(raw)) {
    return Response.json({ status: 'error', message: `unknown class: ${raw}` }, { status: 400 });
  }
  const cls = raw as GraphClass;
  // Account scope: 'self' (default) | 12-digit member id | '__all__' (union across accounts).
  // Trace snapshots live under host storage scope 'self'. Claimed accounts in span/queue
  // telemetry do not change this scope or verify AWS ownership.
  const acctRaw = url.searchParams.get('account') ?? 'self';
  const account = acctRaw === '' ? 'self' : acctRaw;
  if (account !== 'self' && account !== '__all__' && !/^\d{12}$/.test(account)) {
    return Response.json({ status: 'error', message: `invalid account: ${account}` }, { status: 400 });
  }
  const from = url.searchParams.get('from');
  const depthRaw = Number(url.searchParams.get('depth'));
  const depth = Number.isFinite(depthRaw) && depthRaw > 0 ? depthRaw : 2;
  try {
    const result = await graphReadTransaction(getPool(), async client => {
      // Every row/state read observes one bounded publication snapshot. Serialize after release.
      await client.query('SAVEPOINT collection_read');
      let collection;
      try { collection = await readGraphState(client, account, cls); }
      catch (error) {
        console.error(`[graph-read] failed ${graphDiagnostic('graph_state', error)}`);
        collection = { ...unknownCollection(cls), failureReason: 'state_read_failed' };
      }
      await client.query('ROLLBACK TO SAVEPOINT collection_read');
      await client.query('RELEASE SAVEPOINT collection_read');
      let ids: string[] | undefined, capped = false;
      if (from) {
        const down = await downstream(client, from, { cls, depth, account });
        const up = await upstream(client, from, { cls, depth, account });
        ids = [...new Set([from, ...down.map(r => r.id), ...up.map(r => r.id)])];
        const cap = await client.query(`SELECT EXISTS (SELECT 1 FROM (
          SELECT source FROM topology_edges WHERE ($4 = '__all__' OR account_id = $4) AND class = $1 AND source = ANY($2)
          GROUP BY source HAVING count(*) > $3) t) AS capped`, [cls, ids, FANOUT_CAP, account]);
        capped = cap.rows[0]?.capped ?? false;
      }
      const rows = await graphRows(client, cls, account, ids);
      return { class: cls, account, ...(from ? { from, depth, capped } : {}),
        nodes: evidenceNodes(rows.nodes, cls), edges: evidenceEdges(rows.edges, cls),
        // Legacy display clock only. Never substitute this for collection publication/source proof.
        captured_at: collection.captured_at ?? (cls !== 'trace' && account !== '__all__' ? rows.nodes[0]?.captured_at ?? null : null),
        collection: { ...collection, readStatus: rows.truncated ? 'partial' : 'ok',
          ...(rows.truncated ? { readTruncated: true, readReason: 'row_limit' } : {}) } };
    });
    return Response.json(result);
  } catch (error) {
    const busy = error instanceof GraphReadBusy;
    const code = (error as { code?: string } | null)?.code;
    const reason = busy ? 'busy' : ['57014','25P03','25P04'].includes(code ?? '') ? 'timeout' : 'query_failed';
    if (busy) console.warn('[graph-read] shed {"reason":"busy"}');
    else console.error(`[graph-read] failed ${graphDiagnostic('graph_read', error)}`);
    return Response.json({ status: 'error', message: 'Graph read failed',
      class: cls, account, collection: { ...unknownCollection(cls), readStatus: 'unavailable',
        readReason: reason } }, { status: busy ? 503 : 500, ...(busy ? { headers: { 'Retry-After': '1' } } : {}) });
  }
}
