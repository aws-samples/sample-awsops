import type { Pool, PoolClient } from 'pg';

/** One shared-pool slot for a short transaction. No lock waits or remote IO in the callback.
 * PG17 transaction_timeout also bounds the sum of individually short statements. */
export async function graphTransaction<T>(pool: Pool, readOnly: boolean, fn: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  // pg-pool removes its idle error listener while checked out. A fatal query response
  // can be followed by a separate error event while ROLLBACK is pending.
  let clientError: Error | undefined;
  let discard = false;
  const onError = (error: Error) => { clientError ??= error; };
  client.on('error', onError);
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL statement_timeout = '2s'");
    await client.query("SET LOCAL lock_timeout = '100ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '3s'");
    await client.query("SET LOCAL transaction_timeout = '4s'");
    const result = await fn(client);
    if (clientError) throw clientError;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Capture before cleanup: a later disconnect/rollback error must not replace the
    // original rejection (notably SQLSTATE 25P04) used by callers and failure recording.
    const failure = clientError ?? error;
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
