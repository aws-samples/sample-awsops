import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const invokeMcpLambdaTool = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/mcp-lambda-invoke', () => ({
  invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a),
  KNOWN_MCP_LAMBDA_KINDS: ['notion', 'clickhouse', 'prometheus', 'loki', 'tempo', 'mimir'],
}));

function req(body: unknown) {
  return new Request('http://x/api/datasources/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const m of [verifyUser, isAdmin, invokeMcpLambdaTool]) m.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
  isAdmin.mockResolvedValue(true);
  invokeMcpLambdaTool.mockResolvedValue({ ok: true, latency_ms: 42 });
});

describe('POST /api/datasources/test', () => {
  it('401 unauthenticated / 403 non-admin', async () => {
    verifyUser.mockResolvedValueOnce(null);
    let { POST } = await import('./route');
    expect((await POST(req({ kind: 'prometheus', endpoint: 'http://p:9090' }))).status).toBe(401);
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(false);
    ({ POST } = await import('./route'));
    expect((await POST(req({ kind: 'prometheus', endpoint: 'http://p:9090' }))).status).toBe(403);
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('probes ${kind}_health with an inline conn-config and returns {ok,latencyMs}', async () => {
    const { POST } = await import('./route');
    const resp = await POST(req({ kind: 'prometheus', endpoint: 'http://p:9090', authType: 'bearer', creds: { token: 't' } }));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, latencyMs: 42, error: undefined });
    const call = invokeMcpLambdaTool.mock.calls[0][0];
    expect(call.tool).toBe('prometheus_health');
    expect(call.connConfig).toEqual({ endpoint: 'http://p:9090', authType: 'bearer', token: 't' });
  });

  it('SSRF-blocks a metadata/loopback endpoint with 400 and no invoke', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'prometheus', endpoint: 'http://169.254.169.254/' }))).status).toBe(400);
    expect((await POST(req({ kind: 'prometheus', endpoint: 'http://0.0.0.0:9090' }))).status).toBe(400);
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind and a missing endpoint', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ kind: 'notion', endpoint: 'http://10.0.0.5' }))).status).toBe(400); // notion is not a datasource kind
    expect((await POST(req({ kind: 'prometheus' }))).status).toBe(400);
  });

  it('returns ok:false (200) on a connector error — never the secret', async () => {
    invokeMcpLambdaTool.mockRejectedValue(new Error('HTTP 401 Unauthorized'));
    const { POST } = await import('./route');
    const resp = await POST(req({ kind: 'clickhouse', endpoint: 'http://10.0.0.5:8123', authType: 'basic', creds: { username: 'u', password: 'supersecret' } }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('supersecret');
  });
});
