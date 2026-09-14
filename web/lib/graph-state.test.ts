import { afterEach, describe, expect, it, vi } from 'vitest';
import { inventorySourcesStale, readGraphState } from './graph-state';

afterEach(() => vi.unstubAllEnvs());

describe('graph state during rollout', () => {
  it('reports unknown collection before its additive migration is applied', async () => {
    const pool = { query: vi.fn(async () => { throw Object.assign(new Error('missing relation'), { code: '42P01' }); }) };
    await expect(readGraphState(pool as never, 'self')).resolves.toMatchObject({ status: 'unknown', stale: true });
  });
  it('does not disguise permission failures as an unmigrated schema', async () => {
    const pool = { query: vi.fn(async () => { throw Object.assign(new Error('denied'), { code: '42501' }); }) };
    await expect(readGraphState(pool as never, 'self')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('inventory capture quality', () => {
  it.each([undefined, null, -1, false, '0', 0.5])('missing or invalid row count %s cannot certify capture', itemCount => {
    expect(inventorySourcesStale([{ status: 'ok', itemCount, lastSuccessAtMs: Date.now() - 1000 }])).toBe(true);
  });
  it('requires capture for nonempty data but allows durable successful zero', () => {
    const source = { status: 'ok', producerStatus: 'succeeded', itemCount: 1, lastSuccessAtMs: Date.now() - 1000 };
    expect(inventorySourcesStale([source])).toBe(true);
    expect(inventorySourcesStale([{ ...source, status: 'empty', itemCount: 0 }])).toBe(false);
  });
  it.each(['0', '1441', 'NaN', '30.5'])('invalid threshold %s falls back to the inventory 30 minute policy', threshold => {
    vi.stubEnv('INVENTORY_STALE_AFTER_MINUTES', threshold);
    expect(inventorySourcesStale([{ status: 'empty', itemCount: 0, lastSuccessAtMs: Date.now() - 31 * 60_000 }])).toBe(true);
  });
});

describe('graph producer and scope honesty', () => {
  it.each(['failed', 'running', 'partial', 'unknown', undefined])('does not certify fresh producer status %s', producerStatus => {
    expect(inventorySourcesStale([{ status: 'empty', producerStatus, itemCount: 0, lastSuccessAtMs: Date.now() - 1000 }])).toBe(true);
  });
  it('reads the host trace state for an all-account selector without extending inventory coverage', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ status: 'ok', captured_at: new Date().toISOString(), details: {} }] });
    expect(await readGraphState({ query } as never, '__all__', 'trace')).toMatchObject({ status: 'ok' });
    expect(query.mock.calls[0][1]).toEqual(['self', 'trace']);
    query.mockClear();
    expect(await readGraphState({ query } as never, '__all__', 'infra')).toMatchObject({ status: 'unknown', coverage: 'unknown', evidenceKind: 'inventory' });
    expect(query).not.toHaveBeenCalled();
  });
});
