import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const setDefaultDatasource = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/datasources', () => ({ setDefaultDatasource: (...a: unknown[]) => setDefaultDatasource(...a) }));

const req = () => new Request('http://x/api/datasources/7/default', { method: 'POST', headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  for (const m of [verifyUser, isAdmin, setDefaultDatasource]) m.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
  isAdmin.mockResolvedValue(true);
  setDefaultDatasource.mockResolvedValue(undefined);
});

describe('POST /api/datasources/[id]/default', () => {
  it('admin-only', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req(), { params: { id: '7' } })).status).toBe(403);
    expect(setDefaultDatasource).not.toHaveBeenCalled();
  });
  it('sets the default and returns ok', async () => {
    const { POST } = await import('./route');
    const resp = await POST(req(), { params: { id: '7' } });
    expect(resp.status).toBe(200);
    expect(setDefaultDatasource).toHaveBeenCalledWith(7);
  });
  it('400 on a bad id', async () => {
    const { POST } = await import('./route');
    expect((await POST(req(), { params: { id: 'abc' } })).status).toBe(400);
  });
  it('404 when the datasource is missing', async () => {
    setDefaultDatasource.mockRejectedValue(new Error('datasource not found'));
    const { POST } = await import('./route');
    expect((await POST(req(), { params: { id: '9' } })).status).toBe(404);
  });
});
