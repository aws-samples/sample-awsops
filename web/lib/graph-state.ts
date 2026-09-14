import type { Pool, PoolClient } from 'pg';

export type GraphStatus = 'ok' | 'empty' | 'partial' | 'unavailable' | 'error';
export type GraphClass = 'flow' | 'infra' | 'trace';
export interface GraphAttempt {
  status: GraphStatus;
  attemptedAt: string;
  publish: boolean;
  details: Record<string, unknown>;
}

/** Caller stages and SQLSTATE only; never serialize provider/DB messages or arbitrary codes. */
export function graphDiagnostic(stage: string, error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return JSON.stringify({
    stage: ['flow', 'infra', 'trace_sources', 'trace', 'graph_state', 'graph_read'].includes(stage) ? stage : 'unknown',
    code: typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown',
  });
}

/** Caller holds the class advisory lock and publishes rows in this same transaction.
 * captured_at is the successful publication; source clocks belong to publishedSources.
 * Failed attempts preserve both. Trace keeps its existing window-end timestamp default. */
export async function writeGraphState(client: PoolClient, account: string, attempt: GraphAttempt, cls: GraphClass = 'trace') {
  const result = await client.query(
    `INSERT INTO topology_graph_state (account_id, class, status, attempted_at, captured_at, details)
     VALUES ($1, $6, $2, $3::timestamptz,
             CASE WHEN $4 THEN CASE WHEN $6 = 'trace' THEN $3::timestamptz ELSE clock_timestamp() END ELSE NULL END,
             $5::jsonb || CASE WHEN $6 <> 'trace' THEN
               jsonb_build_object('publishedSources', CASE WHEN $4 THEN $5::jsonb->'sources' ELSE '[]'::jsonb END)
               ELSE '{}'::jsonb END)
     ON CONFLICT (account_id, class) DO UPDATE
       SET status = EXCLUDED.status, attempted_at = EXCLUDED.attempted_at,
           captured_at = CASE WHEN $4 THEN EXCLUDED.captured_at ELSE topology_graph_state.captured_at END,
           details = EXCLUDED.details || CASE WHEN NOT $4 AND $6 <> 'trace' THEN
             jsonb_build_object('publishedSources', coalesce(topology_graph_state.details->'publishedSources', '[]'::jsonb))
             ELSE '{}'::jsonb END
     WHERE topology_graph_state.attempted_at < EXCLUDED.attempted_at`,
    [account, attempt.status, attempt.attemptedAt, attempt.publish, JSON.stringify(attempt.details), cls],
  );
  return result.rowCount !== 0;
}

export async function readGraphState(pool: Pick<Pool, 'query'>, account: string, cls: GraphClass = 'trace') {
  const unknown = { status: 'unknown', stale: true, attempted_at: null, captured_at: null, sources: [] };
  // A host state is not evidence for an account union. No unbounded per-account payload.
  if (account === '__all__') return { ...unknown, coverage: 'unknown' };
  let row;
  try {
    const result = await pool.query(
      `SELECT status, attempted_at, captured_at, details
         FROM topology_graph_state
        WHERE class = $2 AND account_id = $1`,
      [account, cls],
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
    || row.details?.retainedPrevious === true
    || (cls !== 'trace' && inventorySourcesStale(row.details?.publishedSources));
  return { ...row.details, ...(cls !== 'trace' ? { evidenceKind: 'inventory' } : {}), status: row.status, stale,
    attempted_at: row.attempted_at, captured_at: row.captured_at };
}

/** Same default as inventory_read_mcp._inventory_stale_after_minutes. */
export function inventorySourcesStale(value: unknown): boolean {
  if (!Array.isArray(value) || !value.length) return true;
  const configured = Number(process.env.INVENTORY_STALE_AFTER_MINUTES ?? 30);
  const minutes = Number.isInteger(configured) && configured > 0 && configured <= 1440 ? configured : 30;
  return value.some(source => {
    if (!source || typeof source !== 'object') return true;
    if (!Number.isSafeInteger(source.itemCount) || source.itemCount < 0) return true;
    const clocks = [source.lastSuccessAtMs, ...(source.itemCount > 0 ? [source.capturedAtMs] : [])];
    return !['ok', 'empty'].includes(source.status) || clocks.some(clock =>
      typeof clock !== 'number' || !Number.isFinite(clock) || clock <= 0
      || clock > Date.now() || Date.now() - clock > minutes * 60_000);
  });
}
