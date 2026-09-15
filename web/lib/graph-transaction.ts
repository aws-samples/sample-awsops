import type { Pool, PoolClient } from 'pg';

const activeGraphWork = new WeakMap<Pool, number>();
export class GraphReadBusy extends Error {}
export class GraphReadDeadline extends Error {
  constructor(readonly phase: 'acquire' | 'transaction') { super('graph read deadline exceeded'); }
}
type ReadLease = { client?: PoolClient; expired: boolean; released: boolean };

function admit(pool: Pool) {
  const active = activeGraphWork.get(pool) ?? 0;
  if (active >= 2) throw new GraphReadBusy('graph read busy');
  activeGraphWork.set(pool, active + 1);
  return () => {
    const remaining = (activeGraphWork.get(pool) ?? 1) - 1;
    if (remaining) activeGraphWork.set(pool, remaining); else activeGraphWork.delete(pool);
  };
}

/** Reads and rebuilds share two slots. Keep admission until a late checkout settles. */
export function graphReadTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>) {
  return admittedTransaction(pool, true, fn, true);
}

export function graphTransaction<T>(pool: Pool, readOnly: boolean, fn: (client: PoolClient) => Promise<T>) {
  return admittedTransaction(pool, readOnly, fn, false);
}

async function admittedTransaction<T>(pool: Pool, readOnly: boolean,
  fn: (client: PoolClient) => Promise<T>, requestBudget: boolean) {
  const release = admit(pool);
  const lease: ReadLease = { expired: false, released: false };
  const operation = runTransaction(pool, readOnly, fn, requestBudget, lease).finally(release);
  let timer: ReturnType<typeof setTimeout>;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const expire = () => {
      lease.expired = true;
      reject(new GraphReadDeadline(lease.client ? 'transaction' : 'acquire'));
      if (lease.client && !lease.released) {
        lease.released = true;
        try { lease.client.release(true); } catch { /* never replace the deadline */ }
      }
    };
    timer = setTimeout(() => {
      if (requestBudget || !lease.client) expire();
    }, 2000);
    // PG retains its separate 4s transaction limit/fatal SQLSTATE. This caller-side
    // ceiling also covers a response that never arrives after checkout.
    if (!requestBudget) watchdog = setTimeout(expire, 6000);
  });
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer!); if (watchdog) clearTimeout(watchdog); }
}

/** One shared-pool slot for a short transaction. Bounded lock waits and no remote IO in the callback.
 * PG17 transaction_timeout also bounds the sum of individually short statements. */
async function runTransaction<T>(pool: Pool, readOnly: boolean, fn: (client: PoolClient) => Promise<T>, requestBudget: boolean, lease?: ReadLease) {
  const client = await pool.connect();
  if (lease) {
    lease.client = client;
    if (lease.expired) {
      lease.released = true; client.release();
      throw new GraphReadDeadline('acquire');
    }
  }
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
    if (!clientError && !lease?.released) {
      try { await client.query('ROLLBACK'); }
      catch { discard = true; }
    }
    throw failure;
  } finally {
    // Keep local handling until release hands ownership back to pg-pool. Never reuse
    // a disconnected client or one whose transaction could not be rolled back.
    try {
      if (!lease?.released) {
        if (lease) lease.released = true;
        client.release(discard || !!clientError);
      }
    }
    finally { client.removeListener('error', onError); }
  }
}
