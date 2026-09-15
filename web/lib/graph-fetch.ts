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

/** Failed reads remain visible evidence, never an empty collection or a raw HTTP/error string. */
export async function fetchGraph(url: string, signal: AbortSignal): Promise<GraphData> {
  const unavailable = (reason: 'busy' | 'timeout' | 'query_failed'): GraphData => ({
    nodes: [], edges: [], captured_at: null,
    collection: { status: 'unknown', stale: true, readStatus: 'unavailable', readReason: reason },
  });
  try {
    const response = await fetch(url, { signal });
    if (response.status === 401 || (response.redirected && new URL(response.url).pathname === '/login')) {
      throw new GraphFetchError('unauthenticated');
    }
    if (response.status === 403) throw new GraphFetchError('forbidden');
    if (response.status >= 400 && response.status < 500) throw new GraphFetchError('rejected');
    const body = await response.json();
    if (!response.ok) {
      const reason = body?.collection?.readReason;
      return unavailable(reason === 'busy' || reason === 'timeout' ? reason : 'query_failed');
    }
    return Array.isArray(body?.nodes) && Array.isArray(body?.edges) ? body : unavailable('query_failed');
  } catch (error) {
    if (signal.aborted || error instanceof GraphFetchError) throw error;
    return unavailable('query_failed');
  }
}
