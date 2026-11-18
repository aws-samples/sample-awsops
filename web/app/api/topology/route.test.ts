import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), pool: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: mocks.verify }));
vi.mock('@/lib/db', () => ({ getPool: mocks.pool }));
import { GET } from './route';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it('authenticates before flag disclosure and rejects unsupported scopes before opening a DB connection', async () => {
  vi.stubEnv('TOPOLOGY_ENTITIES_ENABLED', 'false');
  const request = new Request('http://localhost/api/topology?account=__all__');
  expect((await GET(request)).status).toBe(401);
  mocks.verify.mockResolvedValue({ sub: 'fixture' });
  expect((await GET(request)).status).toBe(404);
  vi.stubEnv('TOPOLOGY_ENTITIES_ENABLED', 'true');
  expect((await GET(request)).status).toBe(422);
  expect((await GET(new Request('http://localhost/api/topology?cursor=200'))).status).toBe(400);
  expect(mocks.pool).not.toHaveBeenCalled();
});
