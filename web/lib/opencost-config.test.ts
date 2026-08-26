import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
const writeAudit = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
vi.mock('@/lib/catalog', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

const orig = process.env.AURORA_ENDPOINT;
beforeEach(() => { query.mockReset(); writeAudit.mockReset(); process.env.AURORA_ENDPOINT = 'x'; });
afterEach(() => { if (orig === undefined) delete process.env.AURORA_ENDPOINT; else process.env.AURORA_ENDPOINT = orig; });

describe('getOpencostConfig', () => {
  it('returns null without AURORA_ENDPOINT (no query)', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { getOpencostConfig } = await import('./opencost-config');
    expect(await getOpencostConfig('c')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it('maps a row', async () => {
    query.mockResolvedValue({ rows: [{ cluster: 'c', chart_version: '1.0', config: { a: 1 }, updated_by: 'u', updated_at: '2026-06-11' }] });
    const { getOpencostConfig } = await import('./opencost-config');
    expect(await getOpencostConfig('c')).toEqual({ cluster: 'c', chartVersion: '1.0', config: { a: 1 }, updatedBy: 'u', updatedAt: '2026-06-11' });
  });
  it('returns null on empty rows and degrades to null on query error', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const { getOpencostConfig } = await import('./opencost-config');
    expect(await getOpencostConfig('c')).toBeNull();
    query.mockRejectedValueOnce(new Error('db down'));
    expect(await getOpencostConfig('c')).toBeNull();
  });
});

describe('upsertOpencostConfig', () => {
  it('returns false without AURORA_ENDPOINT', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { upsertOpencostConfig } = await import('./opencost-config');
    expect(await upsertOpencostConfig({ cluster: 'c', chartVersion: null, config: {}, updatedBy: 'u' })).toBe(false);
  });
  it('upserts (ON CONFLICT), audits, returns true', async () => {
    query.mockResolvedValue({ rows: [] });
    const { upsertOpencostConfig } = await import('./opencost-config');
    expect(await upsertOpencostConfig({ cluster: 'c', chartVersion: '1.0', config: { x: 1 }, updatedBy: 'u' })).toBe(true);
    const [sql, params] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(String(sql)).toContain('ON CONFLICT (cluster) DO UPDATE');
    expect(params).toEqual(['c', '1.0', JSON.stringify({ x: 1 }), 'u']);
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ actor: 'u', objectType: 'opencost_config', objectId: 'c' }));
  });
  it('degrades to false on query error (no throw)', async () => {
    query.mockRejectedValue(new Error('db down'));
    const { upsertOpencostConfig } = await import('./opencost-config');
    expect(await upsertOpencostConfig({ cluster: 'c', chartVersion: null, config: {}, updatedBy: 'u' })).toBe(false);
  });
});
