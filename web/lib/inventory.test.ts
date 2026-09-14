import { describe, it, expect, vi, beforeEach } from 'vitest';
const query = vi.fn();
const lambdaSend = vi.fn();
const poolMock: { query: (...a: unknown[]) => unknown; connect?: unknown } = { query: (...a: unknown[]) => query(...a) };
vi.mock('@/lib/db', () => ({ getPool: () => poolMock }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = lambdaSend; },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));
beforeEach(() => {
  query.mockReset(); lambdaSend.mockReset(); poolMock.connect = vi.fn();
  process.env.INV_SYNC_FUNCTION = 'fn';
});

describe('readResources', () => {
  it('reads ordered rows and the global ledger/count with one pool query and no checked-out client', async () => {
    const snapshot = { rows: [{ resource_id: 'old' }], run: { status: 'succeeded', finished_at: '2026-09-13T00:00:00Z', row_count: 1 } };
    query.mockResolvedValue({ rows: [snapshot] });
    const { readResources } = await import('./inventory');
    expect(await readResources('target_group', { limit: 500, offset: 0 }))
      .toEqual({ ...snapshot, consistency: 'statement-snapshot' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(poolMock.connect).not.toHaveBeenCalled();
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('inventory_resources');
    expect(sql).toContain('inventory_sync_runs');
    expect(sql).toMatch(/jsonb_agg/i);
    expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|SET LOCAL|ROLLBACK/);
  });

  it.each(['ec2', 'target_group', 'subnet'])('propagates a %s query failure without acquiring a manual client', async type => {
    const error = new Error('original query failure');
    query.mockRejectedValue(error);
    const { readResources } = await import('./inventory');
    await expect(readResources(type, { limit: 500, offset: 0 })).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
    expect(poolMock.connect).not.toHaveBeenCalled();
  });

  it.each([null, { status: 'partial', row_count: 12 }])('keeps an empty page and its nullable ledger: %j', async run => {
    query.mockResolvedValue({ rows: [{ rows: [], run }] });
    const { readResources } = await import('./inventory');
    expect(await readResources('ec2', { limit: 5, offset: 500 }))
      .toEqual({ rows: [], run, consistency: 'statement-snapshot' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not fabricate an empty inventory if the one-row query envelope is absent', async () => {
    query.mockResolvedValue({ rows: [] });
    const { readResources } = await import('./inventory');
    await expect(readResources('ec2', { limit: 5, offset: 0 })).rejects.toThrow('invalid inventory snapshot');
  });

  it('applies the real worst-first alarm ordering before the page limit and inside JSON aggregation', async () => {
    query.mockResolvedValue({ rows: [{ rows: [], run: null }] });
    const { readResources } = await import('./inventory');
    await readResources('cloudwatch_alarm', { limit: 5, offset: 10 });
    const sql = query.mock.calls[0][0];
    expect(sql.match(/CASE lower\(data->>'state_value'\)/g)).toHaveLength(2);
    expect(sql.match(/state_updated_timestamp/g)).toHaveLength(2);
    expect(query.mock.calls[0][1]).toEqual(['cloudwatch_alarm', ['self'], 5, 10]);
  });

  it('uses timestamp plus the full scoped primary key for stable five-row pagination', async () => {
    query.mockResolvedValue({ rows: [{ rows: [], run: null }] });
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
    query.mockResolvedValueOnce({ rows: [{ rows: [{ resource_id: 'i-1', data: { instance_type: 't3.micro' }, captured_at: 't' }], run: ledger }] });
    const { readResources } = await import('./inventory');
    const out = await readResources('ec2', { limit: 50, offset: 0, accounts: accounts === '__all__' ? accounts : [...accounts] });
    expect(out.rows[0].resource_id).toBe('i-1'); expect(out.run).toEqual(ledger);
    expect(query.mock.calls[0][0]).toContain("account_id = 'self'"); expect(query).toHaveBeenCalledTimes(1);
  });

  it('__all__ regions (default) → no region predicate in the WHERE clause', async () => {
    query.mockResolvedValueOnce({ rows: [{ rows: [], run: null }] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0 });
    const [sql] = query.mock.calls[0];
    expect(sql).not.toMatch(/region\s*=|region\s*<>/i);
  });

  it('explicit regions → region = ANY($n) with includeGlobal folded into the array', async () => {
    query.mockResolvedValueOnce({ rows: [{ rows: [], run: null }] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: ['ap-northeast-2', 'us-east-1'], includeGlobal: true });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/region = ANY/);
    expect(params).toContainEqual(['ap-northeast-2', 'us-east-1', 'global']);
  });

  it('includeGlobal=false with explicit regions → global excluded from the array', async () => {
    query.mockResolvedValueOnce({ rows: [{ rows: [], run: null }] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: ['ap-northeast-2'], includeGlobal: false });
    const [, params] = query.mock.calls[0];
    expect(params).toContainEqual(['ap-northeast-2']);
  });

  it('includeGlobal=false with __all__ regions → excludes region=global directly', async () => {
    query.mockResolvedValueOnce({ rows: [{ rows: [], run: null }] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: '__all__', includeGlobal: false });
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/region <> 'global'/);
  });

  it('empty region selection → guarded to a non-matching sentinel, not an unfiltered query', async () => {
    query.mockResolvedValueOnce({ rows: [{ rows: [], run: null }] });
    const { readResources } = await import('./inventory');
    await readResources('ec2', { limit: 50, offset: 0, regions: [], includeGlobal: false });
    const [, params] = query.mock.calls[0];
    expect(params).toContainEqual(['__none__']);
  });

  it('includeGlobal=false strips a caller-supplied "global" out of explicit regions', async () => {
    query.mockResolvedValueOnce({ rows: [{ rows: [], run: null }] });
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
