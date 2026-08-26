import type { Pool } from 'pg';

// Recursive-CTE traversal over topology_edges (ADR-043). PG 17 CYCLE clause for cycle safety
// + a hard depth backstop. Class-scoped (flow|infra). A per-hop LATERAL fan-out cap bounds hub
// nodes (a large subnet / shared SG can have hundreds of members) so the subgraph stays usable;
// default security-group nodes are not expanded (unless they are the start node) for the same reason.
export interface GraphReach { id: string; depth: number }

export const MAX_DEPTH = 8;     // hard ceiling on traversal depth
export const FANOUT_CAP = 20;   // max neighbors expanded PER node (hairball-hub guard)

// down = follow source→target (what this node fronts/leads to);
// up   = follow target→source (what leads to / depends on this node).
// Params: $1 = start node id, $2 = class, $3 = max depth (caller clamps to <= MAX_DEPTH),
//         $4 = account_id ('self' | 12-digit | '__all__' = no account filter).
export function traversalSql(dir: 'down' | 'up'): string {
  const cur = dir === 'down' ? 'source' : 'target';
  const next = dir === 'down' ? 'target' : 'source';
  return `WITH RECURSIVE walk(node, depth) AS (
            SELECT $1::text, 0
            UNION ALL
            SELECT nbr.next, w.depth + 1
              FROM walk w
              -- per-hop fan-out cap: at most FANOUT_CAP neighbors expanded for THIS node (not the
              -- whole traversal), so a hub (shared subnet/SG) cannot explode the result.
              JOIN LATERAL (
                SELECT e.${next} AS next
                  FROM topology_edges e
                 WHERE ($4 = '__all__' OR e.account_id = $4) AND e.class = $2 AND e.${cur} = w.node
                 ORDER BY e.${next}
                 LIMIT ${FANOUT_CAP}
              ) nbr ON true
             WHERE w.depth < $3
               -- don't expand FROM a default security group (huge hub) unless it is the start node
               AND (w.depth = 0 OR NOT EXISTS (
                 SELECT 1 FROM topology_nodes n
                  WHERE ($4 = '__all__' OR n.account_id = $4) AND n.class = $2 AND n.id = w.node
                    AND n.kind = 'sg' AND (n.meta ->> 'default') = 'true'
               ))
          ) CYCLE node SET is_cycle USING path
          SELECT node AS id, min(depth) AS depth
            FROM walk WHERE node <> $1
           GROUP BY node ORDER BY min(depth), node`;
}

const clampDepth = (d?: number): number => {
  const n = Math.floor(d ?? MAX_DEPTH);
  return Number.isFinite(n) ? Math.min(MAX_DEPTH, Math.max(1, n)) : MAX_DEPTH; // NaN/Infinity → MAX_DEPTH
};

export async function downstream(pool: Pool, id: string, opts?: { cls?: string; depth?: number; account?: string }): Promise<GraphReach[]> {
  const r = await pool.query(traversalSql('down'), [id, opts?.cls ?? 'flow', clampDepth(opts?.depth), opts?.account ?? 'self']);
  return r.rows as GraphReach[];
}
export async function upstream(pool: Pool, id: string, opts?: { cls?: string; depth?: number; account?: string }): Promise<GraphReach[]> {
  const r = await pool.query(traversalSql('up'), [id, opts?.cls ?? 'flow', clampDepth(opts?.depth), opts?.account ?? 'self']);
  return r.rows as GraphReach[];
}
// Blast radius = everything that depends on this node (reached by following edges backwards).
export const blastRadius = upstream;
