import { beforeEach, describe, expect, it, vi } from 'vitest';
const verifyUser = vi.fn();
const getAllowedClusters = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/eks-registry', () => ({ getAllowedClusters: (...a: unknown[]) => getAllowedClusters(...a) }));
import { GET } from './route';
import { EksScopeError } from '@/lib/eks-context';

const req = () => new Request('http://x/api/eks/registrations', { headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  vi.stubEnv('HOST_ACCOUNT_ID', '123456789012');
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  verifyUser.mockReset(); getAllowedClusters.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
});

describe('GET /api/eks/registrations', () => {
  it('401 when unauthenticated (no registry read)', async () => {
    verifyUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(getAllowedClusters).not.toHaveBeenCalled();
  });

  it('returns exactly { clusters: [{ id, name, accountId, region }] }, parsing ARN and bare ids', async () => {
    getAllowedClusters.mockResolvedValue(new Set(['shop', 'arn:aws:eks:us-east-1:111111111111:cluster/orders', 'bad id']));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['clusters', 'truncated']);
    expect(body.truncated).toBe(false); // the registry read is uncapped; said explicitly so the client can rely on it
    expect(body.clusters).toEqual([
      { id: 'arn:aws:eks:us-east-1:111111111111:cluster/orders', name: 'orders', accountId: '111111111111', region: 'us-east-1' },
      { id: 'shop', name: 'shop', accountId: '123456789012', region: 'ap-northeast-2' },
    ]);
    expect(getAllowedClusters).toHaveBeenCalledWith(true); // the registry is required, never env-only
  });

  it('a bare id names the numeric host account, or `self` when HOST_ACCOUNT_ID is unset', async () => {
    getAllowedClusters.mockResolvedValue(new Set(['shop']));
    expect((await (await GET(req())).json()).clusters[0].accountId).toBe('123456789012');
    vi.stubEnv('HOST_ACCOUNT_ID', '');
    expect((await (await GET(req())).json()).clusters[0].accountId).toBe('self');
  });

  it('an unavailable registry is a 503 error, never a partial list', async () => {
    getAllowedClusters.mockRejectedValue(new EksScopeError('EKS registration registry is unavailable', 503));
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.clusters).toBeUndefined();
  });
});
