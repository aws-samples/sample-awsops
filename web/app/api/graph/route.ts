import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { downstream, upstream, FANOUT_CAP } from '@/lib/graph-query';
import { readGraphState, graphDiagnostic, type GraphClass } from '@/lib/graph-state';
import { graphReadTransaction, GraphReadBusy, GraphReadDeadline } from '@/lib/graph-transaction';
import { queueClaimMeta } from '@/lib/trace-evidence';
import { redactInventorySecrets } from '@/lib/inventory-redaction';
import { splitUnionNodeId, unionNodeId, type GraphSelection } from '@/lib/graph-identity';

export const dynamic = 'force-dynamic';

function evidenceNodes(rows: Record<string, any>[], cls: string, union: boolean) {
  return rows.map(node => {
    const meta = redactInventorySecrets(node.meta);
    const { account_id, ...fields } = node;
    return { ...fields, id: union && account_id ? unionNodeId(account_id, node.id) : node.id,
      meta: cls === 'trace' && node.kind === 'queue' ? queueClaimMeta(meta ?? {}) : meta };
  });
}

function evidenceEdges(rows: Record<string, any>[], cls: string, union: boolean) {
  return rows.map((edge) => {
    const meta = redactInventorySecrets(edge.meta);
    const { account_id, ...fields } = edge;
    const scoped = { ...fields,
      source: union && account_id ? unionNodeId(account_id, edge.source) : edge.source,
      target: union && account_id ? unionNodeId(account_id, edge.target) : edge.target };
    if (cls !== 'trace') return { ...scoped, meta };
    const spans = meta?.spanCount;
    const metrics = meta?.metricCount;
    const observed = typeof spans === 'number' && Number.isFinite(spans) && spans >= 0
      && typeof metrics === 'number' && Number.isFinite(metrics) && metrics >= 0
      && spans + metrics > 0;
    return { ...scoped, meta, confidence: observed ? 'observed' : 'unknown' };
  });
}

const NODE_LIMIT = 4000, EDGE_LIMIT = 8000;
const unknownCollection = (cls: GraphClass) => ({ status: 'unknown', stale: true,
  captured_at: null, attempted_at: null, sources: [], evidenceKind: cls === 'trace' ? 'trace' : 'inventory' });

// Bounds apply before edge metadata serialization/deduplication. Retain distinct returned
// evidence, constrain edges to visible nodes, and disclose any omitted raw rows.
async function graphRows(client: Parameters<Parameters<typeof graphReadTransaction>[1]>[0],
  cls: GraphClass, account: string, ids?: string[]) {
  const selection = `SELECT DISTINCT ON (account_id, id) account_id, id, kind, label, meta, captured_at FROM topology_nodes
    WHERE ($2 = '__all__' OR account_id = $2) AND class = $1 ${ids ? 'AND id = ANY($3)' : ''}
    ORDER BY account_id, id, captured_at DESC`;
  const nodes = await client.query(ids
    ? `SELECT selected.* FROM (${selection}) selected
       JOIN unnest($3::text[]) WITH ORDINALITY nearest(id,priority) USING(id)
       ORDER BY nearest.priority LIMIT ${NODE_LIMIT + 1}`
    : `SELECT selected.* FROM (${selection}) selected
       ORDER BY CASE WHEN $1 = 'infra' THEN CASE kind WHEN 'vpc' THEN 0 WHEN 'subnet' THEN 1
         WHEN 'sg' THEN 2 ELSE 3 END ELSE 0 END, account_id, id LIMIT ${NODE_LIMIT + 1}`,
    ids ? [cls, account, ids] : [cls, account]);
  const visible = nodes.rows.slice(0, NODE_LIMIT);
  const edges = await client.query(`SELECT account_id, source, target, rel, confidence, to_jsonb(e)->'meta' AS meta FROM topology_edges e
    WHERE ($2 = '__all__' OR account_id = $2) AND class = $1
      AND source = ANY($3::text[]) AND target = ANY($3::text[])
      AND EXISTS (SELECT 1 FROM unnest($3::text[], $4::text[]) n(id,account_id)
        WHERE n.account_id=e.account_id AND n.id=e.source)
      AND EXISTS (SELECT 1 FROM unnest($3::text[], $4::text[]) n(id,account_id)
        WHERE n.account_id=e.account_id AND n.id=e.target)
    ORDER BY account_id, source, target, rel, captured_at DESC LIMIT ${EDGE_LIMIT + 1}`,
    [cls, account, visible.map(row => row.id), visible.map(row => row.account_id ?? account)]);
  return { nodes: visible,
    edges: edges.rows.slice(0, EDGE_LIMIT),
    truncated: nodes.rows.length > NODE_LIMIT || edges.rows.length > EDGE_LIMIT };
}

async function graphRoot(client: Parameters<Parameters<typeof graphReadTransaction>[1]>[0],
  cls: GraphClass, account: string, requested: string) {
  const wrapped = splitUnionNodeId(requested);
  const scope = wrapped?.account ?? account, id = wrapped?.id ?? requested;
  const parameters = [cls, scope, id];
  const predicate = `WHERE class=$1 AND ($2='__all__' OR account_id=$2)`;
  // Retained legacy publications can coexist with rebuilt scoped nodes. An exact
  // legacy ID must not hide another account/region's matching scoped identity.
  // Wrapped candidate links explicitly name a saved row, including regionless rows.
  // Preserve old wrapped links after rebuild only when that exact row is absent.
  const exact = wrapped ? await client.query(`SELECT DISTINCT account_id,id FROM topology_nodes ${predicate}
    AND id=$3 ORDER BY account_id,id LIMIT 3`, parameters) : undefined;
  const matches = exact?.rows.length ? exact : await client.query(
    `SELECT DISTINCT account_id,id FROM topology_nodes ${predicate}
      AND (id=$3 OR meta->>'legacyId'=$3) ORDER BY account_id,id LIMIT 3`, parameters);
  const selection: GraphSelection = { status: matches.rows.length > 1 ? 'ambiguous'
    : matches.rows.length ? 'resolved' : 'not_found', requested_id: requested };
  const displayId = (row: Record<string, any>) => account === '__all__'
    ? unionNodeId(row.account_id, row.id) : row.id;
  if (matches.rows.length > 1) {
    selection.candidate_ids = matches.rows.slice(0, 2).map(row => unionNodeId(row.account_id, row.id));
    selection.candidates_truncated = matches.rows.length > 2;
  }
  if (matches.rows.length === 1) {
    selection.resolved_id = displayId(matches.rows[0]);
    selection.account_id = matches.rows[0].account_id ?? scope;
  }
  return { selection, root: matches.rows.length === 1 ? {
    account: matches.rows[0].account_id ?? scope, id: matches.rows[0].id,
  } : null };
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
  const from = url.searchParams.get('from')?.trim();
  const wrapped = from ? splitUnionNodeId(from) : null;
  if (from && (from.length > 4096 || wrapped && account !== '__all__' && wrapped.account !== account)) {
    return Response.json({ status: 'error', message: 'invalid resource scope' }, { status: 400 });
  }
  const depthRaw = Number(url.searchParams.get('depth'));
  const depth = Number.isFinite(depthRaw) && depthRaw > 0 ? depthRaw : 2;
  try {
    const result = await graphReadTransaction(getPool(), async client => {
      const resolved = from ? await graphRoot(client, cls, account, from) : undefined;
      const readAccount = resolved?.root?.account ?? account;
      // Every row/state read observes one bounded publication snapshot. Serialize after release.
      await client.query('SAVEPOINT collection_read');
      let collection;
      try { collection = await readGraphState(client, readAccount, cls); }
      catch (error) {
        console.error(`[graph-read] failed ${graphDiagnostic('graph_state', error)}`);
        collection = { ...unknownCollection(cls), failureReason: 'state_read_failed' };
      }
      await client.query('ROLLBACK TO SAVEPOINT collection_read');
      await client.query('RELEASE SAVEPOINT collection_read');
      let ids: string[] | undefined, capped = false;
      if (resolved?.root) {
        const root = resolved.root.id;
        const down = await downstream(client, root, { cls, depth, account: readAccount });
        const up = await upstream(client, root, { cls, depth, account: readAccount });
        const distances = new Map<string, number>([[root, 0]]);
        for (const node of [...down, ...up]) {
          if (Number.isFinite(node.depth)) distances.set(node.id, Math.min(node.depth, distances.get(node.id) ?? Infinity));
        }
        ids = [...distances].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([id]) => id);
        const cap = await client.query(`SELECT EXISTS (SELECT 1 FROM (
          SELECT source FROM topology_edges WHERE ($4 = '__all__' OR account_id = $4) AND class = $1 AND source = ANY($2)
          GROUP BY source HAVING count(*) > $3) t) AS capped`, [cls, ids, FANOUT_CAP, readAccount]);
        capped = cap.rows[0]?.capped ?? false;
      }
      const rows = resolved && !resolved.root ? { nodes: [], edges: [], truncated: false }
        : await graphRows(client, cls, readAccount, ids);
      return { class: cls, account, ...(from ? { from, depth, capped, selection: resolved!.selection } : {}),
        nodes: rows.nodes, edges: rows.edges,
        // Legacy display clock only. Never substitute this for collection publication/source proof.
        captured_at: collection.captured_at ?? (cls !== 'trace' && readAccount !== '__all__' ? rows.nodes[0]?.captured_at ?? null : null),
        collection: { ...collection, readStatus: rows.truncated ? 'partial' : 'ok',
          ...(rows.truncated ? { readTruncated: true, readReason: 'row_limit' } : {}) } };
    });
    // Normalize annotations/deduplicate and serialize only after commit and client release.
    const edges = [...new Map(evidenceEdges(result.edges, cls, account === '__all__').map(edge => [JSON.stringify(edge), edge])).values()];
    return Response.json({ ...result, nodes: evidenceNodes(result.nodes, cls, account === '__all__'), edges });
  } catch (error) {
    const busy = error instanceof GraphReadBusy;
    const code = (error as { code?: string } | null)?.code;
    const reason = busy ? 'busy' : error instanceof GraphReadDeadline || ['57014','25P03','25P04','55P03'].includes(code ?? '') ? 'timeout' : 'query_failed';
    if (busy) console.warn('[graph-read] shed {"reason":"busy"}');
    else if (error instanceof GraphReadDeadline) console.warn(`[graph-read] deadline ${JSON.stringify({ phase: error.phase })}`);
    else console.error(`[graph-read] failed ${graphDiagnostic('graph_read', error)}`);
    return Response.json({ status: 'error', message: 'Graph read failed',
      class: cls, account, collection: { ...unknownCollection(cls), readStatus: 'unavailable',
        readReason: reason } }, { status: busy ? 503 : 500, ...(busy ? { headers: { 'Retry-After': '1' } } : {}) });
  }
}
