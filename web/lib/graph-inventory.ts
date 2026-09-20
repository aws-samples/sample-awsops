import type { Pool } from 'pg';
import type { GraphClass } from './graph-state';
import { graphTransaction } from './graph-transaction';
export { graphTransaction } from './graph-transaction';
export * from './graph-inventory-read';

/** One bounded metadata write for skipped accounts; never touches graph rows or publication clocks. */
export async function recordUnattempted(pool: Pool, cls: GraphClass, lock: number, accounts: string[], at: string) {
  if (!accounts.length) return true;
  return graphTransaction(pool, false, async client => {
    if (!(await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [lock])).rows[0]?.acquired) return false;
    await client.query(`INSERT INTO topology_graph_state(account_id,class,status,attempted_at,captured_at,details)
      SELECT account,$1,'unavailable',$3::timestamptz,NULL,
        jsonb_build_object('sources','[]'::jsonb,'sourceAttempted',false,'failureReason','not_attempted',
          'retainedPrevious',EXISTS(SELECT 1 FROM topology_nodes WHERE account_id=account AND class=$1))
      FROM unnest($2::text[]) pending(account)
      ON CONFLICT(account_id,class) DO UPDATE SET status=EXCLUDED.status, attempted_at=EXCLUDED.attempted_at,
        details=EXCLUDED.details || jsonb_build_object(
          'retainedPrevious',topology_graph_state.captured_at IS NOT NULL OR (EXCLUDED.details->>'retainedPrevious')::boolean,
          'publishedSources',coalesce(topology_graph_state.details->'publishedSources','[]'::jsonb),
          'lastSourceAttemptedAtMs',CASE WHEN topology_graph_state.details->>'sourceAttempted'='false'
            THEN topology_graph_state.details->'lastSourceAttemptedAtMs'
            ELSE to_jsonb(extract(epoch FROM topology_graph_state.attempted_at)*1000) END)
      WHERE topology_graph_state.attempted_at < EXCLUDED.attempted_at`, [cls, accounts, at]);
    return true;
  });
}

