import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheUnavailableError } from '@/lib/bounded-cache';

const verifyUser = vi.fn();
const dnsLogStatus = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
const coreDnsGroups = vi.fn(async () => [] as unknown[]);
vi.mock('@/lib/dns-logs', () => ({ dnsLogStatus: (...a: unknown[]) => dnsLogStatus(...a), coreDnsGroups: () => coreDnsGroups() }));

const req = () => new Request('http://x/api/dns-logs', { headers: { cookie: 'awsops_token=t' } });
beforeEach(() => { vi.resetModules(); verifyUser.mockReset().mockResolvedValue({ email: 'u@example.com' }); dnsLogStatus.mockReset(); });

describe('GET /api/dns-logs', () => {
  it('a saturated cache, deadline, throttle or 5xx is a retryable 503, never "not configured"', async () => {
    const { GET } = await import('./route');
    for (const error of [new CacheUnavailableError('capacity'), new CacheUnavailableError('deadline'),
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException', $retryable: { throttling: true } }),
      Object.assign(new Error('x'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } })]) {
      dnsLogStatus.mockRejectedValueOnce(error);
      const res = await GET(req());
      expect(res.status).toBe(503);
    }
  });
  it('a saturated CoreDNS group read is a retryable 503, not "no CoreDNS groups"', async () => {
    dnsLogStatus.mockResolvedValue({ configs: [], groups: [] });
    coreDnsGroups.mockRejectedValueOnce(new CacheUnavailableError('deadline'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(503);
  });

  it('keeps the onboarding 200 for a genuine permission/onboarding failure', async () => {
    const { GET } = await import('./route');
    dnsLogStatus.mockRejectedValueOnce(new Error('denied'));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).configs).toEqual([]);
  });
});
