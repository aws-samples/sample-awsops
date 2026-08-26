import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { downstream, upstream, FANOUT_CAP } from '@/lib/graph-query';

export const dynamic = 'force-dynamic';

// Read-only graph access (ADR-043). GET returns the materialized topology graph for a class
// (flow|infra), or — when ?from=<nodeId> is passed — the per-resource SUBGRAPH: the node + its
// up/down neighborhood within `depth` hops (capped per hop by graph-query). No rebuild here —
// rebuild is heavy and runs OFF the BFF (scripts/v2/graph-rebuild.mjs), per the thin-BFF mandate.
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
  const cls = raw;
  // Account scope: 'self' (default) | 12-digit member id | '__all__' (union across accounts).
  // Trace is host-scoped by construction (spans carry no AWS-account dimension) — its rows only
  // exist under 'self', so member scopes honestly return an empty trace graph.
  const acctRaw = url.searchParams.get('account') ?? 'self';
  const account = acctRaw === '' ? 'self' : acctRaw;
  if (account !== 'self' && account !== '__all__' && !/^\d{12}$/.test(account)) {
    return Response.json({ status: 'error', message: `invalid account: ${account}` }, { status: 400 });
  }
  const from = url.searchParams.get('from');
  const depthRaw = Number(url.searchParams.get('depth'));
  const depth = Number.isFinite(depthRaw) && depthRaw > 0 ? depthRaw : 2;
  const pool = getPool();
  try {
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
        pool.query(`SELECT DISTINCT source, target, rel, confidence FROM topology_edges
                      WHERE ($3 = '__all__' OR account_id = $3) AND class = $1 AND source = ANY($2) AND target = ANY($2)`, [cls, ids, account]),
        // capped = some included node actually has more neighbors than the per-hop cap showed
        pool.query(`SELECT EXISTS (SELECT 1 FROM (
                      SELECT source FROM topology_edges WHERE ($4 = '__all__' OR account_id = $4) AND class = $1 AND source = ANY($2)
                      GROUP BY source HAVING count(*) > $3) t) AS capped`, [cls, ids, FANOUT_CAP, account]),
      ]);
      return Response.json({
        from, depth, class: cls, account, nodes: nodes.rows, edges: edges.rows,
        captured_at: nodes.rows[0]?.captured_at ?? null, capped: cap.rows[0]?.capped ?? false,
      });
    }
    const [nodes, edges] = await Promise.all([
      pool.query(`SELECT DISTINCT ON (id) id, kind, label, meta, captured_at FROM topology_nodes
                    WHERE ($2 = '__all__' OR account_id = $2) AND class = $1
                    ORDER BY id, captured_at DESC`, [cls, account]),
      pool.query(`SELECT DISTINCT source, target, rel, confidence FROM topology_edges
                    WHERE ($2 = '__all__' OR account_id = $2) AND class = $1`, [cls, account]),
    ]);
    return Response.json({ class: cls, account, nodes: nodes.rows, edges: edges.rows, captured_at: nodes.rows[0]?.captured_at ?? null });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
