import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ verifyUser: auth }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
import { GET } from './route';

describe('graph collection evidence API', () => {
  beforeEach(() => {
    auth.mockReset().mockResolvedValue({ sub: 'user' });
    query.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM topology_graph_state')) return {
        rows: [{ status: 'error', captured_at: '2026-09-11T01:00:00Z',
          attempted_at: '2026-09-11T02:00:00Z',
          details: { retainedPrevious: true, sources: [{ sourceId: 'tempo:1', status: 'error' }] } }],
      };
      return { rows: [] };
    });
  });

  it('returns failed collection evidence even when no graph nodes exist', async () => {
    const response = await GET(new Request('http://localhost/api/graph?class=trace'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.collection).toMatchObject({
      status: 'error', stale: true, retainedPrevious: true,
      sources: [{ sourceId: 'tempo:1', status: 'error' }],
    });
    expect(body.captured_at).toBe('2026-09-11T01:00:00Z');
  });

  it('does not expose collection state to an unauthenticated request', async () => {
    auth.mockResolvedValue(null);
    const response = await GET(new Request('http://localhost/api/graph?class=trace'));
    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not expose legacy traffic-volume normalization as confidence', async () => {
    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM topology_edges')
        ? [{ source: 'a', target: 'b', rel: 'calls', confidence: '0.5', meta: null }] : [],
    }));
    const response = await GET(new Request('http://localhost/api/graph?class=trace'));
    expect((await response.json()).edges[0].confidence).toBe('unknown');
  });
});
