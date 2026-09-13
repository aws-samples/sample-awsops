import { expect, it, vi, afterEach } from 'vitest';
import { readCollectionStatus } from './inventory-collection';
afterEach(() => vi.unstubAllEnvs());
it('keeps disabled, missing runs, unknown fields and read failure distinct from zero-row success', async () => {
  vi.stubEnv('INV_SYNC_FUNCTION', '');
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(await readCollectionStatus({ query }, ['self'])).toEqual({ configured: false, readOk: true, runs: [] });
  vi.stubEnv('INV_SYNC_FUNCTION', 'sync');
  expect(await readCollectionStatus({ query }, ['self'])).toEqual({ configured: true, readOk: true, runs: [] });
  query.mockResolvedValue({ rows: [{ resource_type: 'cloudfront', account_id: 'self', status: 'succeeded',
    last_success_at: '2026-09-13T14:00:00Z', row_count: 0, unknown_attribute_count: null, error: 'SECRET' }] });
  const result = await readCollectionStatus({ query }, ['self']);
  expect(result.runs[0]).toMatchObject({ type: 'cloudfront', status: 'succeeded', row_count: 0,
    unknown_attribute_count: null, unknown_attributes: null, last_success_at: '2026-09-13T14:00:00.000Z' });
  expect(JSON.stringify(result)).not.toContain('SECRET');
  query.mockRejectedValue(new Error('SECRET'));
  expect(await readCollectionStatus({ query }, ['self'])).toEqual({ configured: true, readOk: false, runs: [] });
});
it('uses bound account scope and never selects error strings', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  await readCollectionStatus({ query }, ['self', '123456789012', "'OR true"]);
  expect(query.mock.calls[0][1]).toEqual([['self', '123456789012']]);
  expect(query.mock.calls[0][0]).not.toMatch(/\berror\b/);
});
