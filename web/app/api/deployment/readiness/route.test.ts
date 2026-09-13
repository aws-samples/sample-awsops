import { beforeEach, expect, it, vi } from 'vitest';
const { verify, probe, admin } = vi.hoisted(() => ({ verify: vi.fn(), probe: vi.fn(), admin: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: verify }));
vi.mock('@/lib/admin', () => ({ isAdmin: admin }));
vi.mock('@/lib/deployment-readiness', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/deployment-readiness')>(), deploymentReadiness: probe,
}));
let POST: (request: Request) => Promise<Response>;
const body = { nonce: 'a'.repeat(32), expectedAccountId: '123456789012', expectedCloudfrontId: 'E123EXAMPLE' };
const request = (data: unknown) => new Request('https://test/api/deployment/readiness', {
  method: 'POST', headers: { cookie: 'awsops_token=fixture' }, body: JSON.stringify(data),
});
beforeEach(async () => {
  vi.resetModules(); verify.mockReset(); probe.mockReset(); admin.mockReset(); admin.mockResolvedValue(false);
  verify.mockResolvedValue({ sub: 'ci-user', groups: ['deployment-verifiers'] });
  ({ POST } = await import('./route'));
});
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
it.each([['ready', 200], ['not_ready', 503]] as const)('deployment verifiers get no-store %s evidence', async (status, code) => {
  probe.mockResolvedValue({ status, reason: status === 'ready' ? 'ok' : 'disabled' });
  const response = await POST(request(body));
  expect(response.status).toBe(code); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(probe).toHaveBeenCalledWith(body);
});

it('refuses ordinary authenticated users before the billed probe', async () => {
  verify.mockResolvedValue({ sub: 'ordinary-user', groups: [] });
  expect((await POST(request(body))).status).toBe(403); expect(probe).not.toHaveBeenCalled();
});
it('also permits existing administrators', async () => {
  verify.mockResolvedValue({ sub: 'operator', groups: [] }); admin.mockResolvedValue(true);
  probe.mockResolvedValue({ status: 'ready', reason: 'ok' });
  expect((await POST(request(body))).status).toBe(200);
});
it('serializes probes and keeps a process-wide cooldown after completion', async () => {
  let finish!: (value: unknown) => void;
  probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = POST(request(body));
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
  const concurrent = await POST(request(body));
  expect(concurrent.status).toBe(429); expect(concurrent.headers.get('retry-after')).toBeTruthy();
  finish({ status: 'ready', reason: 'ok' }); expect((await first).status).toBe(200);
  expect((await POST(request(body))).status).toBe(429);
  expect(probe).toHaveBeenCalledTimes(1);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
  try {
    probe.mockResolvedValue({ status: 'ready', reason: 'ok' });
    expect((await POST(request(body))).status).toBe(200);
    expect(probe).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});
