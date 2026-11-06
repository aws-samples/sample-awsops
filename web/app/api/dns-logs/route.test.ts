import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheUnavailableError } from '@/lib/bounded-cache';

const verifyUser = vi.fn();
const dnsLogStatus = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/dns-logs', () => ({ dnsLogStatus: (...a: unknown[]) => dnsLogStatus(...a), coreDnsGroups: async () => [] }));

const req = () => new Request('http://x/api/dns-logs', { headers: { cookie: 'awsops_token=t' } });
beforeEach(() => { vi.resetModules(); verifyUser.mockReset().mockResolvedValue({ email: 'u@example.com' }); dnsLogStatus.mockReset(); });

describe('GET /api/dns-logs', () => {
  it('a saturated cache or load deadline is a retryable 503, never "not configured"', async () => {
    const { GET } = await import('./route');
    for (const error of [new CacheUnavailableError('capacity'), new CacheUnavailableError('deadline')]) {
      dnsLogStatus.mockRejectedValueOnce(error);
      const res = await GET(req());
      expect(res.status).toBe(503);
    }
  });
  it('keeps the onboarding 200 for a genuine permission/onboarding failure', async () => {
    const { GET } = await import('./route');
    dnsLogStatus.mockRejectedValueOnce(new Error('denied'));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).configs).toEqual([]);
  });
});
