import { describe, expect, it, vi } from 'vitest';
import { readGraphState } from './graph-state';

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
