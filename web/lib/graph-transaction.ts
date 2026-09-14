import type { Pool, PoolClient } from 'pg';

const activeRequests = new WeakMap<Pool, number>();
export class GraphReadBusy extends Error {}

/** Admit at most two graph requests per max:3 shared pool; leave one slot for auth. */
export async function graphReadTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>) {
  const active = activeRequests.get(pool) ?? 0;
  if (active >= 2) throw new GraphReadBusy('graph read busy');
  activeRequests.set(pool, active + 1);
  try { return await runTransaction(pool, true, fn, true); }
  finally {
    const remaining = (activeRequests.get(pool) ?? 1) - 1;
    if (remaining) activeRequests.set(pool, remaining); else activeRequests.delete(pool);
  }
}

export async function graphTransaction<T>(pool: Pool, readOnly: boolean, fn: (client: PoolClient) => Promise<T>) {
  return runTransaction(pool, readOnly, fn, false);
}

/** One shared-pool slot for a short transaction. No lock waits or remote IO in the callback.
 * PG17 transaction_timeout also bounds the sum of individually short statements. */
async function runTransaction<T>(pool: Pool, readOnly: boolean, fn: (client: PoolClient) => Promise<T>, requestBudget: boolean) {
  const client = await pool.connect();
  // pg-pool removes its idle error listener while checked out. A fatal query response
  // can be followed by a separate error event while ROLLBACK is pending.
  let clientError: Error | undefined;
  let discard = false;
  const onError = (error: Error) => { clientError ??= error; };
  client.on('error', onError);
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query(requestBudget ? "SET LOCAL statement_timeout = '1500ms'" : "SET LOCAL statement_timeout = '2s'");
    await client.query("SET LOCAL lock_timeout = '100ms'");
    await client.query(requestBudget ? "SET LOCAL idle_in_transaction_session_timeout = '1500ms'" : "SET LOCAL idle_in_transaction_session_timeout = '3s'");
    await client.query(requestBudget ? "SET LOCAL transaction_timeout = '2s'" : "SET LOCAL transaction_timeout = '4s'");
    const result = await fn(client);
    if (clientError) throw clientError;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Preserve the original query/application error. Only pg's generic follow-on rejection
    // after an idle disconnect is replaced by the earlier fatal client event.
    const unusable = (error as { message?: unknown } | null)?.message
      === 'Client has encountered a connection error and is not queryable';
    const failure = unusable && clientError ? clientError : error;
    if (!clientError) {
      try { await client.query('ROLLBACK'); }
      catch { discard = true; }
    }
    throw failure;
  } finally {
    // Keep local handling until release hands ownership back to pg-pool. Never reuse
    // a disconnected client or one whose transaction could not be rolled back.
    try { client.release(discard || !!clientError); }
    finally { client.removeListener('error', onError); }
  }
}
