import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheUnavailableError } from '@/lib/bounded-cache';

const sdkError = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(name), { name, ...extra });
const throttled = () => sdkError('ThrottlingException', { $retryable: { throttling: true }, $metadata: { httpStatusCode: 400 } });
const serverError = () => sdkError('InternalServerException', { $metadata: { httpStatusCode: 500 } });
const denied = () => sdkError('AccessDeniedException', { $metadata: { httpStatusCode: 403 } });

const verifyUser = vi.fn();
const dnsLogStatus = vi.fn();
const dnsAnalytics = vi.fn();
const coreDnsGroups = vi.fn();
const coreDnsAnalytics = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/dns-logs', () => ({
  dnsLogStatus: (...a: unknown[]) => dnsLogStatus(...a),
  dnsAnalytics: (...a: unknown[]) => dnsAnalytics(...a),
  coreDnsGroups: (...a: unknown[]) => coreDnsGroups(...a),
  coreDnsAnalytics: (...a: unknown[]) => coreDnsAnalytics(...a),
}));

const req = (query: string) => new Request(`http://x/api/dns-logs/analytics?${query}`, { headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  vi.resetModules();
  for (const fn of [verifyUser, dnsLogStatus, dnsAnalytics, coreDnsGroups, coreDnsAnalytics]) fn.mockReset();
  verifyUser.mockResolvedValue({ email: 'u@example.com' });
});

describe('GET /api/dns-logs/analytics', () => {
  it.each([
    ['resolver', () => dnsLogStatus],
    ['coredns', () => coreDnsGroups],
  ])('maps a %s allow-list lookup failure to a retryable 503, not unknown log group', async (source, lookup) => {
    const { GET } = await import('./route');
    for (const error of [new CacheUnavailableError('capacity'), new CacheUnavailableError('deadline'), throttled(), serverError()]) {
      lookup().mockRejectedValueOnce(error);
      const res = await GET(req(`source=${source}&group=/g`));
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');
      const body = await res.json();
      expect(body).toMatchObject({ status: 'error', retryable: true });
      expect(body.message).not.toMatch(/unknown/);
    }
    expect(dnsAnalytics).not.toHaveBeenCalled();
    expect(coreDnsAnalytics).not.toHaveBeenCalled();
  });

  it.each([
    ['resolver', () => dnsLogStatus],
    ['coredns', () => coreDnsGroups],
  ])('a permanent %s lookup failure is a non-retryable error, not a 503', async (source, lookup) => {
    lookup().mockRejectedValue(denied());
    const { GET } = await import('./route');
    const res = await GET(req(`source=${source}&group=/g`));
    expect(res.status).toBe(502);
    expect(res.headers.get('Retry-After')).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({ status: 'error', retryable: false, message: 'log group lookup failed' });
    expect(JSON.stringify(body)).not.toContain('AccessDenied');
  });

  it('a saturated analytics read is a retryable 503 without the internal message', async () => {
    dnsLogStatus.mockResolvedValue({ configs: [], groups: ['/g'] });
    dnsAnalytics.mockRejectedValue(new CacheUnavailableError('capacity'));
    const { GET } = await import('./route');
    const res = await GET(req('group=/g'));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('capacity reached');
  });

  it('keeps 404 for a group absent from a successful lookup', async () => {
    dnsLogStatus.mockResolvedValue({ configs: [], groups: ['/other'] });
    coreDnsGroups.mockResolvedValue([{ group: '/other' }]);
    const { GET } = await import('./route');
    expect((await GET(req('group=/g'))).status).toBe(404);
    expect((await GET(req('source=coredns&group=/g'))).status).toBe(404);
  });
});
