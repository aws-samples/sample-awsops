import { describe, it, expect, vi, beforeEach } from 'vitest';

// HTTP adapter-layer test: initiateAuth is mocked (its own behavior is covered by lib/login.test.ts);
// sessionCookie/safeNext run for real so we exercise the route's wiring of the lib helpers.
const initiateAuth = vi.fn();
vi.mock('@/lib/login', async () => {
  const actual = await vi.importActual<typeof import('@/lib/login')>('@/lib/login');
  return { ...actual, initiateAuth: (...a: unknown[]) => initiateAuth(...a) };
});

const req = (body: unknown, raw = false) =>
  new Request('http://x/api/auth/login', {
    method: 'POST',
    body: raw ? (body as string) : JSON.stringify(body),
  });

beforeEach(() => {
  initiateAuth.mockReset();
});

describe('POST /api/auth/login', () => {
  it('400 invalid_request on non-JSON body', async () => {
    const { POST } = await import('./route');
    const res = await POST(req('not json', true));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(initiateAuth).not.toHaveBeenCalled();
  });

  it('400 invalid_request when email/password missing', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ password: 'pw' }))).status).toBe(400);
    expect((await POST(req({ email: 'a@b.com' }))).status).toBe(400);
    expect((await POST(req({ email: '', password: 'pw' }))).status).toBe(400);
    expect(initiateAuth).not.toHaveBeenCalled();
  });

  it('400 invalid_request when fields exceed length limits', async () => {
    const { POST } = await import('./route');
    const longEmail = 'a'.repeat(255);
    const longPw = 'p'.repeat(257);
    expect((await POST(req({ email: longEmail, password: 'pw' }))).status).toBe(400);
    expect((await POST(req({ email: 'a@b.com', password: longPw }))).status).toBe(400);
    expect(initiateAuth).not.toHaveBeenCalled();
  });

  it('200 with Set-Cookie and redirect on success', async () => {
    initiateAuth.mockResolvedValue({ ok: true, idToken: 'eyJ.id.tok', expiresIn: 43200 });
    const { POST } = await import('./route');
    const res = await POST(req({ email: 'admin@example.com', password: 'pw', remember: true, next: '/cost' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirect: '/cost' });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('awsops_token=eyJ.id.tok');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Max-Age=43200');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(initiateAuth).toHaveBeenCalledWith('admin@example.com', 'pw');
  });

  it("sanitizes an unsafe next to '/' on success", async () => {
    initiateAuth.mockResolvedValue({ ok: true, idToken: 'tok', expiresIn: 43200 });
    const { POST } = await import('./route');
    const res = await POST(req({ email: 'a@b.com', password: 'pw', next: '//evil.com' }));
    expect(res.status).toBe(200);
    expect((await res.json()).redirect).toBe('/');
  });

  it('emits a session cookie (no Max-Age) when remember is absent', async () => {
    initiateAuth.mockResolvedValue({ ok: true, idToken: 'tok', expiresIn: 43200 });
    const { POST } = await import('./route');
    const res = await POST(req({ email: 'a@b.com', password: 'pw' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('Max-Age');
  });

  it('401 invalid_credentials', async () => {
    initiateAuth.mockResolvedValue({ ok: false, code: 'invalid_credentials' });
    const { POST } = await import('./route');
    const res = await POST(req({ email: 'a@b.com', password: 'wrong' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('403 challenge', async () => {
    initiateAuth.mockResolvedValue({ ok: false, code: 'challenge' });
    const { POST } = await import('./route');
    const res = await POST(req({ email: 'a@b.com', password: 'pw' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'challenge' });
  });

  it('502 unavailable', async () => {
    initiateAuth.mockResolvedValue({ ok: false, code: 'unavailable' });
    const { POST } = await import('./route');
    const res = await POST(req({ email: 'a@b.com', password: 'pw' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });
});
