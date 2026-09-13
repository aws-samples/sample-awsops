import { beforeEach, expect, it, vi } from 'vitest';
const { verify, probe } = vi.hoisted(() => ({ verify: vi.fn(), probe: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: verify }));
vi.mock('@/lib/deployment-readiness', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/deployment-readiness')>(), deploymentReadiness: probe,
}));
import { POST } from './route';
const body = { nonce: 'a'.repeat(32), expectedAccountId: '123456789012', expectedCloudfrontId: 'E123EXAMPLE' };
const request = (data: unknown) => new Request('https://test/api/deployment/readiness', {
  method: 'POST', headers: { cookie: 'awsops_token=fixture' }, body: JSON.stringify(data),
});
beforeEach(() => { verify.mockReset(); probe.mockReset(); verify.mockResolvedValue({ sub: 'ordinary-user' }); });
it('authenticates before reading or invoking and does not use an admin bypass', async () => {
  verify.mockResolvedValue(null);
  expect((await POST(request(body))).status).toBe(401); expect(probe).not.toHaveBeenCalled();
});
it.each([{}, { ...body, expectedAccountId: 'self' }, { ...body, gateway: 'evil' }])('rejects invalid bounded body', async data => {
  expect((await POST(request(data))).status).toBe(400); expect(probe).not.toHaveBeenCalled();
});
it('caps body bytes and never invokes oversized requests', async () => {
  expect((await POST(request({ value: 'x'.repeat(2000) }))).status).toBe(413);
  expect(probe).not.toHaveBeenCalled();
});
it.each([['ready', 200], ['not_ready', 503]] as const)('ordinary users get no-store %s evidence', async (status, code) => {
  probe.mockResolvedValue({ status, reason: status === 'ready' ? 'ok' : 'disabled' });
  const response = await POST(request(body));
  expect(response.status).toBe(code); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(probe).toHaveBeenCalledWith(body);
});
