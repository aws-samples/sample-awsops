import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
import { GET } from './route';

beforeEach(() => {
  query.mockReset();
  vi.stubEnv('AURORA_ENDPOINT', 'database.example.com');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/db database clock', () => {
  it('returns the database-provided UTC clock from the same table-count query', async () => {
    const serverTime = '2026-09-14T12:34:56.789Z';
    query.mockResolvedValue({ rows: [{ public_tables: 42, server_time: serverTime, secret: 'PRIVATE' }] });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', public_tables: 42, server_time: serverTime });
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
    expect(sql).toContain('AS server_time');
    expect(sql).toContain('count(*)::int AS public_tables');
    expect(sql).toContain("WHERE schemaname = 'public'");
  });

  it('preserves the unconfigured response without reading or inventing a clock', async () => {
    vi.stubEnv('AURORA_ENDPOINT', '');
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unconfigured', message: 'AURORA_ENDPOINT not set' });
    expect(query).not.toHaveBeenCalled();
  });

  it('preserves the generic error response without database details or a local clock', async () => {
    query.mockRejectedValue(new Error('PRIVATE_DATABASE_DETAIL'));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error' });
  });
});
