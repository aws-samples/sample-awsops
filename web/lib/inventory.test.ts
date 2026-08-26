import { describe, it, expect, vi, beforeEach } from 'vitest';
const query = vi.fn();
const lambdaSend = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = lambdaSend; },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));
beforeEach(() => { query.mockReset(); lambdaSend.mockReset(); process.env.INV_SYNC_FUNCTION = 'fn'; });

describe('readResources', () => {
  it('returns rows + run status', async () => {
    query.mockResolvedValueOnce({ rows: [{ resource_id: 'i-1', data: { instance_type: 't3.micro' }, captured_at: 't' }] })
         .mockResolvedValueOnce({ rows: [{ status: 'succeeded', finished_at: 't', row_count: 1 }] });
    const { readResources } = await import('./inventory');
    const out = await readResources('ec2', { limit: 50, offset: 0 });
    expect(out.rows[0].resource_id).toBe('i-1');
    expect(out.run.status).toBe('succeeded');
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
  it('invokes the sync Lambda and parses the result', async () => {
    lambdaSend.mockResolvedValue({ Payload: new TextEncoder().encode(JSON.stringify({ status: 'succeeded', row_count: 3 })) });
    const { triggerSync } = await import('./inventory');
    const r = await triggerSync('ec2');
    expect(r.status).toBe('succeeded');
  });
});
