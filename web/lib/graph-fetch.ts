import type { GraphCollection } from '@/components/topology/GraphCollectionStatus';

export type GraphFetchFailure = 'unauthenticated' | 'forbidden' | 'rejected';
export class GraphFetchError extends Error {
  constructor(readonly reason: GraphFetchFailure) { super(reason); }
}

interface GraphData {
  nodes: { id: string; kind: string; label: string; meta?: Record<string, unknown> }[];
  edges: { source: string; target: string; rel: string }[];
  captured_at: string | null;
  capped?: boolean;
  collection?: GraphCollection;
}

// Supplied bounded recovery: only typed admission failures may be retried.
const BUSY_DELAYS = [250, 500, 1000, 2000];
class GraphRecoveryError extends Error {
  constructor(readonly reason: 'busy' | 'timeout') { super(reason); }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Five attempts at most, within ten seconds; retain the sample's safe data/error contract. */
export async function fetchGraph(url: string, signal: AbortSignal): Promise<GraphData> {
  const unavailable = (reason: 'busy' | 'timeout' | 'query_failed'): GraphData => ({
    nodes: [], edges: [], captured_at: null,
    collection: { status: 'unknown', stale: true, readStatus: 'unavailable', readReason: reason },
  });
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  let lastReadReason: 'busy' | undefined;
  const timeout = setTimeout(() => controller.abort(new GraphRecoveryError('timeout')), 10000);
  try {
    for (let attempt = 0; ; attempt++) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await fetch(url, { signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (response.status === 401 || (response.redirected && new URL(response.url).pathname === '/login')) {
        throw new GraphFetchError('unauthenticated');
      }
      if (response.status === 403) throw new GraphFetchError('forbidden');
      if (response.status >= 400 && response.status < 500) throw new GraphFetchError('rejected');
      if (response.status !== 503) lastReadReason = undefined;
      const body = await response.json();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (response.status === 503 && body?.collection?.readStatus === 'unavailable'
        && body.collection.readReason === 'busy') {
        lastReadReason = 'busy';
        if (attempt === BUSY_DELAYS.length) throw new GraphRecoveryError('busy');
        const hint = Number(response.headers.get('Retry-After'));
        const delay = Math.max(BUSY_DELAYS[attempt], Number.isFinite(hint) && hint > 0 ? hint * 1000 : 0);
        await pause(Math.min(delay, 10000), controller.signal);
        continue;
      }
      lastReadReason = undefined;
      if (!response.ok) {
        const reason = body?.collection?.readReason;
        return unavailable(reason === 'busy' || reason === 'timeout' ? reason : 'query_failed');
      }
      return Array.isArray(body?.nodes) && Array.isArray(body?.edges) ? body : unavailable('query_failed');
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof GraphFetchError) throw error;
    if (controller.signal.aborted) return unavailable(lastReadReason ?? 'timeout');
    return unavailable(error instanceof GraphRecoveryError ? error.reason : 'query_failed');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
