import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { downstream, upstream, FANOUT_CAP } from '@/lib/graph-query';
import { readGraphState, graphDiagnostic, type GraphClass } from '@/lib/graph-state';
import { graphTransaction } from '@/lib/graph-transaction';
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

// Read-only graph access (ADR-043). GET returns the materialized topology graph for a class
// (flow|infra), or — when ?from=<nodeId> is passed — the per-resource SUBGRAPH: the node + its
// up/down neighborhood within `depth` hops (capped per hop by graph-query). No rebuild here —
// bounded rebuilds run separately from this request in the gated timer or manual runner.
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
    return await graphTransaction(getPool(), true, async client => {
      // Every neighborhood/row/state read observes one bounded publication snapshot.
      const pool = client;
      await client.query('SAVEPOINT collection_read');
      let collection;
      try { collection = await readGraphState(pool, account, cls); }
      catch (error) {
        console.error(`[graph-read] failed ${graphDiagnostic('graph_state', error)}`);
        collection = { status: 'error', stale: true, captured_at: null, attempted_at: null,
          sources: [], failureReason: 'state_read_failed' };
      }
      // Also clears an absent-relation error swallowed by the rollout-compatible state reader.
      await client.query('ROLLBACK TO SAVEPOINT collection_read');
      if (from) {
        // per-resource neighborhood: union of up + down reachable ids (each capped per hop in SQL)
        const [down, up] = await Promise.all([
          downstream(pool, from, { cls, depth, account }),
          upstream(pool, from, { cls, depth, account }),
        ]);
        const ids = [...new Set([from, ...down.map((r) => r.id), ...up.map((r) => r.id)])];
        const [nodes, edges, cap] = await Promise.all([
          // DISTINCT ON: under '__all__' the same node id may exist in more than one account's graph
          // (AWS ids are practically unique, but the PK allows it) — keep the freshest row per id.
          pool.query(`SELECT DISTINCT ON (id) id, kind, label, meta, captured_at FROM topology_nodes
                        WHERE ($3 = '__all__' OR account_id = $3) AND class = $1 AND id = ANY($2)
                        ORDER BY id, captured_at DESC`, [cls, ids, account]),
           pool.query(`SELECT DISTINCT source, target, rel, confidence, to_jsonb(e)->'meta' AS meta FROM topology_edges e
                        WHERE ($3 = '__all__' OR account_id = $3) AND class = $1 AND source = ANY($2) AND target = ANY($2)`, [cls, ids, account]),
          // capped = some included node actually has more neighbors than the per-hop cap showed
          pool.query(`SELECT EXISTS (SELECT 1 FROM (
                        SELECT source FROM topology_edges WHERE ($4 = '__all__' OR account_id = $4) AND class = $1 AND source = ANY($2)
                        GROUP BY source HAVING count(*) > $3) t) AS capped`, [cls, ids, FANOUT_CAP, account]),
        ]);
        return Response.json({
          from, depth, class: cls, account, nodes: evidenceNodes(nodes.rows, cls), edges: evidenceEdges(edges.rows, cls),
          captured_at: collection.captured_at,
          capped: cap.rows[0]?.capped ?? false, collection,
        });
      }
      const [nodes, edges] = await Promise.all([
        pool.query(`SELECT DISTINCT ON (id) id, kind, label, meta, captured_at FROM topology_nodes
                      WHERE ($2 = '__all__' OR account_id = $2) AND class = $1
                      ORDER BY id, captured_at DESC`, [cls, account]),
        pool.query(`SELECT DISTINCT source, target, rel, confidence, to_jsonb(e)->'meta' AS meta FROM topology_edges e
                      WHERE ($2 = '__all__' OR account_id = $2) AND class = $1`, [cls, account]),
      ]);
      return Response.json({ class: cls, account, nodes: evidenceNodes(nodes.rows, cls), edges: evidenceEdges(edges.rows, cls),
        captured_at: collection.captured_at, collection });
    });
  } catch (error) {
    console.error(`[graph-read] failed ${graphDiagnostic('graph_read', error)}`);
    return Response.json({ status: 'error', message: 'Graph read failed' }, { status: 500 });
  }
}
