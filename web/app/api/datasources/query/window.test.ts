import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const getDatasource = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'synthetic-user' }) }));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: (...args: unknown[]) => invoke(...args) }));
vi.mock('@/lib/datasources', () => ({
  getDatasource: (...args: unknown[]) => getDatasource(...args),
  resolveConnConfig: async () => ({ endpoint: 'https://provider.example.test', timeoutS: 35 }),
}));
import { POST } from './route';

function request(kind: string, range?: unknown, id?: number) {
  return new Request('https://app.example.test/api/datasources/query', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: kind, query: 'synthetic', range, id }),
  });
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ result: [], traces: [], series: [] });
  getDatasource.mockReset();
});

describe('provider query-window contract', () => {
  it.each(['tempo', 'jaeger', 'dynatrace', 'datadog'])('forwards a selected window to %s and returns the effective bounds', async kind => {
    const response = await POST(request(kind, { window: 86400, step: 360 }));
    expect(response.status).toBe(200);
    const call = invoke.mock.calls[0][0];
    expect(Number(call.args.end) - Number(call.args.start)).toBe(86400);
    expect(call.args.step).toBeUndefined();
    const body = await response.json();
    expect(body.metadata.window).toEqual({ start: call.args.start, end: call.args.end });
    expect(body.metadata.scope).toBe('shared');
  });

  it.each(['tempo', 'jaeger', 'dynatrace', 'datadog'])('%s explicitly retains its one-hour default without a selected range', async kind => {
    await POST(request(kind));
    const args = invoke.mock.calls[0][0].args;
    expect(Number(args.end) - Number(args.start)).toBe(3600);
  });

  it.each([true, { window: 3600, step: 60 }])('rejects a SQL API range instead of ignoring it', async range => {
    expect((await POST(request('clickhouse', range))).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([[], '24h', 42, null])('rejects malformed range shapes', async range => {
    expect((await POST(request('tempo', range))).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns the effective provider or transport ceiling without exposing connection credentials', async () => {
    getDatasource.mockResolvedValue({ id: 1, kind: 'prometheus', settings: { timeoutS: 35 } });
    const response = await POST(request('prometheus', false, 1));
    const body = await response.json();
    expect(invoke.mock.calls[0][0].args.timeout).toBe('35s');
    expect(body.metadata).toMatchObject({ timeoutMode: 'execution', effectiveTimeoutS: 35 });
    expect(JSON.stringify(body)).not.toContain('provider.example.test');
  });

  it.each([false, true, 0, -1, 'missing', '1.5', Number.MAX_SAFE_INTEGER + 1])('a malformed explicit ID cannot select the legacy kind default', async id => {
    const response = await POST(new Request('https://app.example.test/api/datasources/query', {
      method: 'POST', body: JSON.stringify({ id, slug: 'prometheus', query: 'up' }),
    }));
    expect(response.status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
    expect(getDatasource).not.toHaveBeenCalled();
  });
});
