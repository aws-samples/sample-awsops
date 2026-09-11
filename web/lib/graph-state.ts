import type { Pool, PoolClient } from 'pg';

export type GraphStatus = 'ok' | 'empty' | 'partial' | 'unavailable' | 'error';
export interface GraphAttempt {
  status: GraphStatus;
  attemptedAt: string;
  publish: boolean;
  details: Record<string, unknown>;
}

/** Caller holds the trace advisory lock. Older collection attempts cannot replace newer data. */
export async function writeGraphState(client: PoolClient, account: string, attempt: GraphAttempt) {
  const result = await client.query(
    `INSERT INTO topology_graph_state (account_id, class, status, attempted_at, captured_at, details)
     VALUES ($1, 'trace', $2, $3::timestamptz,
             CASE WHEN $4 THEN $3::timestamptz ELSE NULL END, $5::jsonb)
     ON CONFLICT (account_id, class) DO UPDATE
       SET status = EXCLUDED.status, attempted_at = EXCLUDED.attempted_at,
           captured_at = CASE WHEN $4 THEN EXCLUDED.captured_at ELSE topology_graph_state.captured_at END,
           details = EXCLUDED.details
     WHERE topology_graph_state.attempted_at <= EXCLUDED.attempted_at`,
    [account, attempt.status, attempt.attemptedAt, attempt.publish, JSON.stringify(attempt.details)],
  );
  return result.rowCount !== 0;
}

export async function readGraphState(pool: Pool, account: string) {
  const unknown = { status: 'unknown', stale: true, attempted_at: null, captured_at: null, sources: [] };
  let row;
  try {
    const result = await pool.query(
      `SELECT status, attempted_at, captured_at, details
         FROM topology_graph_state
        WHERE class = 'trace' AND account_id = $1`,
      [account === '__all__' ? 'self' : account],
    );
    row = result.rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return unknown;
    throw error;
  }
  if (!row) return unknown;
  const captured = row.captured_at ? new Date(row.captured_at).getTime() : NaN;
  const configured = Number(process.env.GRAPH_REBUILD_INTERVAL_MINS ?? 0);
  const maxAgeMins = Number.isFinite(configured) ? Math.max(15, configured * 2) : 15;
  const stale = !Number.isFinite(captured) || Date.now() - captured > maxAgeMins * 60_000
    || row.status === 'error' || row.status === 'unavailable'
    || row.details?.retainedPrevious === true;
  return { ...row.details, status: row.status, stale,
    attempted_at: row.attempted_at, captured_at: row.captured_at };
}
