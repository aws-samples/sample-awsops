import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const getDiagSignals = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/diag-signals', () => ({ getDiagSignals: (...a: unknown[]) => getDiagSignals(...a) }));

import { GET } from './route';

function req() { return new Request('http://x/api/datasources/7/diag-signals', { headers: { cookie: 'c' } }); }

beforeEach(() => { verifyUser.mockReset(); getDiagSignals.mockReset(); });

describe('GET /api/datasources/[id]/diag-signals', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const res = await GET(req(), { params: { id: '7' } });
    expect(res.status).toBe(401);
    expect(getDiagSignals).not.toHaveBeenCalled();
  });

  it('400 on a non-numeric id', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const res = await GET(req(), { params: { id: 'abc' } });
    expect(res.status).toBe(400);
  });

  it('returns ready/unavailable for a valid id', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getDiagSignals.mockResolvedValue({ ready: [{ signalKey: 'oom_kills' }], unavailable: [] });
    const res = await GET(req(), { params: { id: '7' } });
    expect(res.status).toBe(200);
    expect(getDiagSignals).toHaveBeenCalledWith(7);
    const body = await res.json();
    expect(body.ready[0].signalKey).toBe('oom_kills');
  });

  it('500 surfaces a read error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getDiagSignals.mockRejectedValue(new Error('db'));
    const res = await GET(req(), { params: { id: '7' } });
    expect(res.status).toBe(500);
  });
});
