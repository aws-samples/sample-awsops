import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const query = vi.hoisted(() => vi.fn());
const verify = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/auth', () => ({
  verifyUser: verify, ownerKeysForRead: () => ['caller-sub'],
}));
vi.mock('@/lib/admin', () => ({ isAdmin: async () => false }));
import { GET } from './route';

describe('authorized workload observations', () => {
  beforeEach(() => {
    verify.mockReset().mockResolvedValue({ sub: 'caller-sub' });
    query.mockReset().mockResolvedValue({ rows: [] });
  });
  it('rejects an unauthenticated request before reading job observations', async () => {
    verify.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://localhost/api/jobs/observability'));
    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  it('scopes observations by authenticated ownership, ignoring a requested owner', async () => {
    const response = await GET(new NextRequest('http://localhost/api/jobs/observability?owner=other-user'));
    expect(response.status).toBe(200);
    expect(query.mock.calls[0][0]).toContain('requested_by = ANY($1)');
    expect(query.mock.calls[0][1][0]).toEqual(['caller-sub']);
    const body = await response.json();
    expect(body.summary.attainment).toBeNull();
    expect(body.jobs).toEqual([]);
  });
  it.each(['windowHours=0', 'windowHours=169', 'targetMs=-1', 'targetMs=Infinity', 'type=%27'])(
    'rejects invalid query bounds: %s', async (params) => {
      const response = await GET(new NextRequest(`http://localhost/api/jobs/observability?${params}`));
      expect(response.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    },
  );
});
