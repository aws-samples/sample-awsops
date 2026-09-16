import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), lookup: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: mocks.auth }));
vi.mock('@/lib/vpc-connectivity', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/vpc-connectivity')>(), getVpcConnectivity: mocks.lookup,
}));
import { GET } from './route';
import { VpcConnectivityError } from '@/lib/vpc-connectivity';

const url = 'https://example.test/api/vpc-connectivity?account=self&region=us-east-1&vpcId=vpc-11111111';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ sub: 'immutable-sub' });
  mocks.lookup.mockResolvedValue({
    source: { vpcId: 'vpc-11111111', accountId: '111111111111', ownerId: '111111111111', region: 'us-east-1' },
    checkedAt: '2026-09-16T10:00:00Z', peerings: [], transitGateways: [], limitations: [], incompleteSources: [],
  });
});

describe('GET /api/vpc-connectivity', () => {
  it('authenticates before parsing input or initiating any lookup', async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET(new Request(url, { headers: { cookie: 'awsops_token=session' } }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: 'error', code: 'unauthenticated' });
    expect(mocks.auth).toHaveBeenCalledWith('awsops_token=session');
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it('passes explicit scope to the lookup and returns the contract without shared HTTP caching', async () => {
    const response = await GET(new Request(url.replace('account=self', 'account=222222222222')));
    expect(response.status).toBe(200);
    expect(mocks.lookup).toHaveBeenCalledWith({ account: '222222222222', region: 'us-east-1', vpcId: 'vpc-11111111' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ checkedAt: '2026-09-16T10:00:00Z', limitations: [], incompleteSources: [] });
  });

  it.each([
    '?region=us-east-1&vpcId=vpc-11111111', '?account=self&vpcId=vpc-11111111',
    '?account=self&region=us-east-1', '?account=self&account=222222222222&region=us-east-1&vpcId=vpc-11111111',
    '?account=__all__&region=us-east-1&vpcId=vpc-11111111',
    '?account=self&region=us-gov-west-1&vpcId=vpc-11111111',
    '?account=self&region=us-east-999&vpcId=vpc-11111111',
    '?account=self&region=us-east-1&vpcId=vpc-invalid',
  ])('rejects missing, duplicate or invalid scope: %s', async query => {
    const response = await GET(new Request(`https://example.test/api/vpc-connectivity${query}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: 'error', code: 'invalid_request' });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_request', 400], ['not_found', 404], ['account_unavailable', 403], ['lookup_failed', 502],
  ] as const)('maps only the stable %s error code', async (code, status) => {
    mocks.lookup.mockRejectedValue(new VpcConnectivityError(code));
    const response = await GET(new Request(url));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ status: 'error', code });
  });

  it('does not expose arbitrary provider messages or spoofed error codes', async () => {
    mocks.lookup.mockRejectedValue({ code: 'private-secret', message: 'accessKey=test-access provider details' });
    const response = await GET(new Request(url));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ status: 'error', code: 'lookup_failed' });
  });
});
