import { describe, it, expect, vi, beforeEach } from 'vitest';
const query = vi.fn();
const lambdaSend = vi.fn();
const connectionQuery = vi.fn();
const release = vi.fn();
const poolMock: { query: (...a: unknown[]) => unknown; connect?: unknown } = { query: (...a: unknown[]) => query(...a) };
vi.mock('@/lib/db', () => ({ getPool: () => poolMock }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = lambdaSend; },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));
beforeEach(() => {
  query.mockReset(); lambdaSend.mockReset(); release.mockReset(); connectionQuery.mockReset();
  connectionQuery.mockImplementation((sql: string, ...args: unknown[]) =>
    /^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql) ? Promise.resolve({ rows: [] }) : query(sql, ...args));
  poolMock.connect = vi.fn().mockResolvedValue({ query: connectionQuery, release });
  process.env.INV_SYNC_FUNCTION = 'fn';
});

describe('readResources', () => {
  it('keeps rows and global ledger/count in one read-only snapshot while a sweep finishes between reads', async () => {
    const old = { rows: [{ resource_id: 'old' }], run: { status: 'succeeded', finished_at: '2026-09-13T00:00:00Z', row_count: 1 } };
    let live = old, snapshot: typeof old | undefined;
    const sql = vi.fn(async (text: string) => {
      if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/.test(text)) snapshot = live;
      const read = snapshot ?? live;
      if (/FROM inventory_resources/.test(text)) {
        live = { rows: [{ resource_id: 'new' }], run: { ...old.run, finished_at: '2026-09-14T00:00:00Z', row_count: 2 } };
        return { rows: read.rows };
      }
      return { rows: /FROM inventory_sync_runs/.test(text) ? [read.run] : [] };
    });
    query.mockImplementation(sql); // The old pool.query path observes the torn ledger.
    poolMock.connect = vi.fn().mockResolvedValue({ query: sql, release });
    const { readResources } = await import('./inventory');
    const page = await readResources('target_group', { limit: 500, offset: 0 });
    expect(page).toMatchObject({ rows: old.rows, run: old.run, consistency: 'repeatable-read' });
    expect(query).not.toHaveBeenCalled();
    expect(sql.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(sql.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(['BEGIN', 'SET LOCAL', 'inventory_resources', 'inventory_sync_runs', 'COMMIT'])(
    'rolls back and releases the same client after %s failure without returning a consistency marker', async failure => {
      const error = new Error('original query failure');
      connectionQuery.mockImplementation(async (sql: string) => {
        if (sql.includes(failure)) throw error;
        return { rows: [] };
      });
      const { readResources } = await import('./inventory');
      await expect(readResources('target_group', { limit: 500, offset: 0 })).rejects.toBe(error);
      expect(connectionQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(release).toHaveBeenCalledTimes(1);
    });

  it('discards the connection after rollback failure and preserves the original error', async () => {
    const error = new Error('row read failed');
    connectionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('inventory_resources')) throw error;
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [] };
    });
    const { readResources } = await import('./inventory');
    await expect(readResources('subnet', { limit: 500, offset: 0 })).rejects.toBe(error);
    expect(release).toHaveBeenCalledWith(true);
  });

  it('uses timestamp plus the full scoped primary key for stable five-row pagination', async () => {
    query.mockResolvedValue({ rows: [] });
    const { readResources } = await import('./inventory');
    for (const offset of [0, 5, 10]) {
      await readResources('cloudfront', { limit: 5, offset, accounts: '__all__' });
    }
    for (const [sql, params] of query.mock.calls.filter(([sql]) => String(sql).includes('FROM inventory_resources'))) {
      expect(sql).toMatch(/ORDER BY captured_at DESC, account_id ASC, region ASC, resource_id ASC LIMIT/);
      expect(params.at(-2)).toBe(5);
    }
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('FROM inventory_resources'))
      .map(([, params]) => params.at(-1))).toEqual([0, 5, 10]);
  });
  it.each([['self'], ['123456789012'], '__all__'] as const)('returns scoped rows and the global sweep ledger for %j', async accounts => {
    const ledger = { status: 'partial', finished_at: '2026-09-14T00:00:00Z', last_success_at: '2026-09-13T00:00:00Z', row_count: 1200 };
    query.mockResolvedValueOnce({ rows: [{ resource_id: 'i-1', data: { instance_type: 't3.micro' }, captured_at: 't' }] })
         .mockResolvedValueOnce({ rows: [ledger] });
    const { readResources } = await import('./inventory');
    const out = await readResources('ec2', { limit: 50, offset: 0, accounts: accounts === '__all__' ? accounts : [...accounts] });
    expect(out.rows[0].resource_id).toBe('i-1'); expect(out.run).toEqual(ledger);
    expect(query.mock.calls[1][0]).toContain("account_id = 'self'"); expect(query.mock.calls[1][1]).toEqual(['ec2']);
  });

  it('__all__ regions (default) → no region predicate in the WHERE clause', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0 });
    const [sql] = query.mock.calls[0];
    expect(sql).not.toMatch(/region\s*=|region\s*<>/i);
  });

  it('explicit regions → region = ANY($n) with includeGlobal folded into the array', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: ['ap-northeast-2', 'us-east-1'], includeGlobal: true });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/region = ANY/);
    expect(params).toContainEqual(['ap-northeast-2', 'us-east-1', 'global']);
  });

  it('includeGlobal=false with explicit regions → global excluded from the array', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: ['ap-northeast-2'], includeGlobal: false });
    const [, params] = query.mock.calls[0];
    expect(params).toContainEqual(['ap-northeast-2']);
  });

  it('includeGlobal=false with __all__ regions → excludes region=global directly', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: '__all__', includeGlobal: false });
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/region <> 'global'/);
  });

  it('empty region selection → guarded to a non-matching sentinel, not an unfiltered query', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: [], includeGlobal: false });
    const [, params] = query.mock.calls[0];
    expect(params).toContainEqual(['__none__']);
  });

  it('includeGlobal=false strips a caller-supplied "global" out of explicit regions', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: ['ap-northeast-2', 'global'], includeGlobal: false });
    const [, params] = query.mock.calls[0];
    expect(params).toContainEqual(['ap-northeast-2']);
  });
});
describe('triggerSync', () => {
  it('queues the sync Lambda asynchronously through the bounded path', async () => {
    lambdaSend.mockResolvedValue({ StatusCode: 202 });
    const { triggerSync } = await import('./inventory');
    await expect(triggerSync('ec2')).resolves.toEqual({ status: 'queued' });
    const command = lambdaSend.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      FunctionName: 'fn',
      InvocationType: 'Event',
    });
  });

  it('rejects an unexpected async invoke status', async () => {
    lambdaSend.mockResolvedValue({ StatusCode: 200 });
    const { triggerSync } = await import('./inventory');
    await expect(triggerSync('ec2')).rejects.toThrow('inventory sync enqueue failed');
  });
});

describe('readAggregates (gap L102 — full-fleet server-side aggregates)', () => {
  const connQuery = vi.fn();
  const release = vi.fn();
  beforeEach(() => {
    connQuery.mockReset(); release.mockReset();
    poolMock.connect = vi.fn().mockResolvedValue({ query: connQuery, release });
  });

  it('ONE UNION ALL round-trip inside a SET LOCAL statement_timeout transaction, scoped like readResources', async () => {
    const { readAggregates } = await import('./inventory');
    connQuery.mockResolvedValue({ rows: [] });
    connQuery.mockImplementation(async (sql: string) => (/UNION ALL/.test(sql)
      ? { rows: [{ k: '__total__', name: null, value: 1234 }, { k: 'instance_type', name: 't3.micro', value: 900 }] }
      : { rows: [] }));
    const out = await readAggregates('ec2', { regions: ['ap-northeast-2'], accounts: '__all__' });
    expect(out.total).toBe(1234);
    expect(out.dist![0]).toEqual({ name: 't3.micro', value: 900 });
    const sqls = connQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/SET LOCAL statement_timeout = \d+/);
    const main = sqls.find((q) => /UNION ALL/.test(q))!;
    expect(main).toMatch(/'__total__'/);
    expect(main).toMatch(/region = ANY/);                 // scoped like readResources
    expect(main).toMatch(/ORDER BY 2 DESC, 1 ASC LIMIT 50/); // deterministic tiebreak + cap
    expect((main.match(/UNION ALL/g) ?? []).length).toBeGreaterThan(0);
    expect(sqls.at(-1)).toBe('COMMIT');
    expect(release).toHaveBeenCalled();
    // exactly ONE data statement — never a serial 1+N chain on the max:3 pool
    expect(sqls.filter((q) => /inventory_resources/.test(q)).length).toBe(1);
  });

  it('EXCLUDES client-derived spec keys (dynamodb billing_h, ecs_task cluster_h/cpu_h/memory_h, lambda runtime/vpc_h, opensearch encryption_status_h, msk kafka_version)', async () => {
    const { readAggregates } = await import('./inventory');
    connQuery.mockResolvedValue({ rows: [] });
    for (const [type, banned] of [
      ['dynamodb', ['billing_h']],
      ['ecs_task', ['cluster_h', 'cpu_h', 'memory_h']],
      ['lambda', ['runtime', 'vpc_h']],
      ['opensearch', ['encryption_status_h']],
      ['msk', ['kafka_version']],
    ] as [string, string[]][]) {
      connQuery.mockClear();
      await readAggregates(type, {});
      const main = connQuery.mock.calls.map((c) => String(c[0])).find((q) => /UNION ALL|__total__/.test(q))!;
      for (const k of banned) {
        expect(main.includes(`data->>'${k}'`)).toBe(false);
      }
    }
  });

  it('ROLLBACK + release on failure; unknown type returns an empty shape without touching the pool', async () => {
    const { readAggregates } = await import('./inventory');
    connQuery.mockImplementation(async (sql: string) => { if (/UNION ALL|__total__/.test(sql)) throw new Error('boom'); return { rows: [] }; });
    await expect(readAggregates('ec2', {})).rejects.toThrow('boom');
    expect(connQuery.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK');
    expect(release).toHaveBeenCalled();
    connQuery.mockClear();
    const out = await readAggregates('not_a_type', {});
    expect(out).toEqual({ total: 0, state: null, dist: null, dist2: null, facets: {} });
    expect(connQuery).not.toHaveBeenCalled();
  });
});
