import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ verifyUser: auth }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query, connect: async () => ({ query, release() {} }) }) }));
import { GET } from './route';
import claimCases from '../../../lib/fixtures/trace-queue-claims.json';
afterEach(() => vi.restoreAllMocks());

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

  it.each(['flow', 'infra'])('returns %s source failure without changing the selected graph', async cls => {
    const response = await GET(new Request(`http://localhost/api/graph?class=${cls}`));
    expect((await response.json()).collection).toMatchObject({ status: 'error', stale: true, retainedPrevious: true });
    expect(query.mock.calls.find(([sql]) => sql.includes('FROM topology_graph_state'))?.[1]).toEqual(['self', cls]);
  });

  it('never presents host collection as union coverage or a node timestamp as source capture', async () => {
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM topology_nodes')
      ? [{ id: 'one', kind: 'vpc', captured_at: '2026-09-14T10:00:00Z' }] : [] }));
    const body = await (await GET(new Request('http://localhost/api/graph?class=infra&account=__all__'))).json();
    expect(body.collection).toMatchObject({ status: 'unknown', stale: true, coverage: 'unknown' });
    expect(body.captured_at).toBeNull();
    expect(body.nodes).toHaveLength(1);
  });

  it('retains readable graph with a safe state-read failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM topology_graph_state')) throw Object.assign(new Error('credential=secret'), { code: '42501' });
      return { rows: sql.includes('FROM topology_nodes') ? [{ id: 'retained', kind: 'vpc' }] : [] };
    });
    const response = await GET(new Request('http://localhost/api/graph?class=infra'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.collection).toMatchObject({ status: 'error', stale: true, failureReason: 'state_read_failed' });
    expect(body.nodes).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('credential');
    expect(log).toHaveBeenCalledWith('[graph-read] failed {"stage":"graph_state","code":"42501"}');
  });
  it('logs bounded read diagnostics while keeping errors out of the HTTP body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(Object.assign(new Error('credential=secret'), { code: 'credential=secret' }));
    const response = await GET(new Request('http://localhost/api/graph'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error', message: 'Graph read failed' });
    expect(log).toHaveBeenCalledWith('[graph-read] failed {"stage":"graph_read","code":"unknown"}');
  });
});

describe('queue attribution on retained snapshots', () => {
  it.each(['', '&from=queue:old'])('keeps claimed telemetry separate in trace API %s', async suffix => {
    auth.mockResolvedValue({ sub: 'user' });
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM topology_nodes') ? [{
      id: 'queue:old', kind: 'queue', label: 'orders', meta: {
        accountId: '111122223333', region: 'us-east-1', identityProvenance: 'aws_verified', infra_ref: 'inventory:queue',
      },
    }] : [] }));
    const body = await (await GET(new Request(`http://localhost/api/graph?class=trace${suffix}`))).json();
    expect(body.nodes[0].meta).toEqual({ claimedAccountId: null, claimedRegion: null, identityProvenance: 'telemetry_claim' });
  });

  it.each(claimCases)('rederives retained claims from destination $destination on both reads', async ({ destination, account, region }) => {
    auth.mockResolvedValue({ sub: 'user' });
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM topology_nodes') ? [{
      id: 'queue:old', kind: 'queue', label: 'orders', meta: {
        destination, accountId: '444455556666', region: 'us-west-2',
        claimedAccountId: '777788889999', claimedRegion: 'eu-west-1', infra_ref: 'inventory:queue',
      },
    }] : [] }));
    for (const suffix of ['', '&from=queue:old']) {
      const body = await (await GET(new Request(`http://localhost/api/graph?class=trace${suffix}`))).json();
      expect(body.nodes[0].meta).toEqual({
        destination, claimedAccountId: account, claimedRegion: region, identityProvenance: 'telemetry_claim',
      });
    }
  });
});
