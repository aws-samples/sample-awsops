import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const connection = vi.hoisted(() => ({ current: null as unknown as EventEmitter, release: vi.fn() }));
beforeEach(() => {
  connection.release.mockReset();
  connection.current = Object.assign(new EventEmitter(), { query, release: connection.release });
});
vi.mock('@/lib/auth', () => ({ verifyUser: auth }));
const sharedPool = vi.hoisted(() => ({ query, connect: async () => connection.current }));
vi.mock('@/lib/db', () => ({ getPool: () => sharedPool }));
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

  it('bounds reads before any graph query starts', async () => {
    await GET(new Request('http://localhost/api/graph'));
    const calls = query.mock.calls.map(([sql]) => sql as string);
    const read = calls.findIndex(sql => sql.includes('FROM topology_graph_state'));
    for (const setting of ['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'transaction_timeout']) {
      const at = calls.findIndex(sql => sql.startsWith(`SET LOCAL ${setting}`));
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(read);
    }
  });
  it('discards a connection when rollback fails without exposing either failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM topology_nodes')) throw Object.assign(new Error('private query failure'), { code: '42501' });
      if (sql === 'ROLLBACK') throw new Error('private rollback failure');
      return { rows: [] };
    });
    const response = await GET(new Request('http://localhost/api/graph'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: 'error', message: 'Graph read failed',
      collection: { status: 'unknown', readStatus: 'unavailable', readReason: 'query_failed' } });
    expect(connection.release).toHaveBeenCalledWith(true);
  });
  it('handles a checked-out client error event and discards the fatal connection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let unhandled = false;
    const fatal = Object.assign(new Error('private disconnect'), { code: '57P01' });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM topology_nodes')) {
        try { connection.current.emit('error', fatal); } catch { unhandled = true; }
        throw fatal;
      }
      return { rows: [] };
    });
    const response = await GET(new Request('http://localhost/api/graph'));
    expect(response.status).toBe(500);
    expect(unhandled).toBe(false);
    expect(connection.release).toHaveBeenCalledWith(true);
    expect(connection.current.listenerCount('error')).toBe(0);
  });

  it('keeps the legacy row clock separate when inventory collection state is absent', async () => {
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM topology_nodes')
      ? [{ id: 'vpc:one', captured_at: '2026-09-14T10:00:00Z' }] : [] }));
    const body = await (await GET(new Request('http://localhost/api/graph?class=infra&account=self'))).json();
    expect(body.captured_at).toBe('2026-09-14T10:00:00Z');
    expect(body.collection).toMatchObject({ status: 'unknown', captured_at: null, stale: true });
  });
  it('commits and releases before serializing the response and uses a sub-revocation budget', async () => {
    const json = Response.json.bind(Response);
    vi.spyOn(Response, 'json').mockImplementation((body, init) => {
      expect(connection.release).toHaveBeenCalled();
      return json(body, init);
    });
    await GET(new Request('http://localhost/api/graph'));
    expect(query).toHaveBeenCalledWith("SET LOCAL transaction_timeout = '2s'");
  });
  it('sheds an overlapping graph request before pool checkout without inventing collector failure', async () => {
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM topology_graph_state')) { started(); await pending; }
      return { rows: [] };
    });
    const first = GET(new Request('http://localhost/api/graph'));
    await ready;
    try {
      const second = await GET(new Request('http://localhost/api/graph'));
      expect(second.status).toBe(503);
      expect((await second.json()).collection).toMatchObject({ status: 'unknown', readStatus: 'unavailable', readReason: 'busy' });
    } finally { release(); await first; }
    expect((await GET(new Request('http://localhost/api/graph'))).status).toBe(200);
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
    expect(body.collection).toMatchObject({ status: 'unknown', stale: true, evidenceKind: 'inventory', failureReason: 'state_read_failed' });
    expect(body.nodes).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('credential');
    expect(log).toHaveBeenCalledWith('[graph-read] failed {"stage":"graph_state","code":"42501"}');
  });
  it('logs bounded read diagnostics while keeping errors out of the HTTP body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(Object.assign(new Error('credential=secret'), { code: 'credential=secret' }));
    const response = await GET(new Request('http://localhost/api/graph'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: 'error', message: 'Graph read failed',
      collection: { status: 'unknown', readStatus: 'unavailable', readReason: 'query_failed' } });
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
