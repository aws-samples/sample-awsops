import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheUnavailableError } from '@/lib/bounded-cache';

const verifyUser = vi.fn();
const nfmStatus = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/nfm', () => ({ nfmStatus: (...a: unknown[]) => nfmStatus(...a), NFM_METRICS: [], NFM_CATEGORIES: [] }));

const req = () => new Request('http://x/api/nfm', { headers: { cookie: 'awsops_token=t' } });
beforeEach(() => { vi.resetModules(); verifyUser.mockReset().mockResolvedValue({ email: 'u@example.com' }); nfmStatus.mockReset(); });

describe('GET /api/nfm', () => {
  it('a saturated cache, timeout, throttle or 5xx is a retryable 503, never "not onboarded"', async () => {
    const { GET } = await import('./route');
    for (const error of [new CacheUnavailableError('capacity'), Object.assign(new Error('t'), { name: 'TimeoutError' }),
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException', $retryable: { throttling: true } }),
      Object.assign(new Error('x'), { name: 'InternalServerException', $metadata: { httpStatusCode: 500 } })]) {
      nfmStatus.mockRejectedValueOnce(error);
      const res = await GET(req());
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');
      expect(JSON.stringify(await res.json())).not.toContain('capacity reached');
    }
  });
  it('keeps the onboarding 200 for a genuine permission/onboarding failure', async () => {
    const { GET } = await import('./route');
    nfmStatus.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).monitors).toEqual([]);
  });
});
