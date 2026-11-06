import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheUnavailableError } from '@/lib/bounded-cache';

const verifyUser = vi.fn();
const nfmStatus = vi.fn();
const nfmTopContributors = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/nfm', () => ({
  nfmStatus: (...a: unknown[]) => nfmStatus(...a),
  nfmTopContributors: (...a: unknown[]) => nfmTopContributors(...a),
  NFM_METRICS: ['DATA_TRANSFERRED'],
  NFM_CATEGORIES: ['INTER_AZ'],
}));

const req = () => new Request('http://x/api/nfm/query?monitor=nfm-vpc-all', { headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  vi.resetModules();
  verifyUser.mockReset(); nfmStatus.mockReset(); nfmTopContributors.mockReset();
  verifyUser.mockResolvedValue({ email: 'u@example.com' });
});

describe('GET /api/nfm/query', () => {
  it('maps a failed or saturated monitor lookup to a retryable 503, not unknown monitor', async () => {
    const { GET } = await import('./route');
    for (const error of [new CacheUnavailableError('capacity'), new CacheUnavailableError('deadline'), new Error('throttled')]) {
      nfmStatus.mockRejectedValueOnce(error);
      const res = await GET(req());
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');
      const body = await res.json();
      expect(body).toMatchObject({ status: 'error', retryable: true });
      expect(body.message).not.toMatch(/unknown/);
    }
    expect(nfmTopContributors).not.toHaveBeenCalled();
  });

  it('keeps 404 for a monitor absent from a successful lookup', async () => {
    nfmStatus.mockResolvedValue({ monitors: [{ name: 'other', status: 'ACTIVE', cluster: null }], scopeCount: 0 });
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(404);
  });

  it('a saturated top-contributors read is a retryable 503 without the internal message', async () => {
    nfmStatus.mockResolvedValue({ monitors: [{ name: 'nfm-vpc-all' }] });
    nfmTopContributors.mockRejectedValue(new CacheUnavailableError('capacity'));
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('capacity reached');
  });
});
