import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const createRun = vi.fn();
const getCheck = vi.fn();
const listRunsForCheck = vi.fn();
const networkPathLiveTopologyCapabilityGate = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/network-path', async () => {
  const actual = await vi.importActual<typeof import('@/lib/network-path')>('@/lib/network-path');
  return {
    ...actual,
    createRun: (...a: unknown[]) => createRun(...a),
    getCheck: (...a: unknown[]) => getCheck(...a),
    listRunsForCheck: (...a: unknown[]) => listRunsForCheck(...a),
  };
});
// L2 finding #3: the real capability gate is unconditionally 503 today (fetch_live_topology is
// unimplemented) — mocked here so the OTHER pre-existing route tests (auth/404/flag-off) keep
// exercising exactly what they say they exercise; the gate's own blocking behavior is tested
// separately below by NOT stubbing it to pass.
vi.mock('@/lib/network-path-gate', async () => {
  const actual = await vi.importActual<typeof import('@/lib/network-path-gate')>('@/lib/network-path-gate');
  return { ...actual, networkPathLiveTopologyCapabilityGate: (...a: unknown[]) => networkPathLiveTopologyCapabilityGate(...a) };
});

const params = { id: 'chk-1' };
const req = () =>
  new Request('http://x/api/network-paths/chk-1/runs', { method: 'POST', headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  verifyUser.mockReset();
  createRun.mockReset();
  getCheck.mockReset();
  listRunsForCheck.mockReset();
  networkPathLiveTopologyCapabilityGate.mockReset();
  networkPathLiveTopologyCapabilityGate.mockReturnValue(null); // unblocked by default in this suite
  process.env.NETWORK_PATH_CHECK_ENABLED = 'true';
});

describe('POST /api/network-paths/[id]/runs', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req() as any, { params });
    expect(res.status).toBe(401);
    expect(createRun).not.toHaveBeenCalled();
  });

  it('503 unconfigured when the feature flag is off (fail closed)', async () => {
    delete process.env.NETWORK_PATH_CHECK_ENABLED;
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { POST } = await import('./route');
    const res = await POST(req() as any, { params });
    expect(res.status).toBe(503);
    expect(createRun).not.toHaveBeenCalled();
  });

  it('404 when the check does not exist or is deleted', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { NotFoundError } = await import('@/lib/network-path');
    createRun.mockRejectedValue(new NotFoundError());
    const { POST } = await import('./route');
    const res = await POST(req() as any, { params });
    expect(res.status).toBe(404);
  });

  it('202 with the run when a viewer (not the creator) triggers it — any authorized viewer may run', async () => {
    verifyUser.mockResolvedValue({ sub: 'viewer-not-creator' });
    createRun.mockResolvedValue({ id: 'run-1', status: 'queued' });
    const { POST } = await import('./route');
    const res = await POST(req() as any, { params });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.run.id).toBe('run-1');
  });

  it('503 unimplemented when the live-topology capability gate blocks (L2 finding #3)', async () => {
    // Capability probe: creating a NEW run is refused while the worker's fetch_live_topology()
    // is a guaranteed-fail stub — every such run would deterministically end `failed`, so this
    // route must not enqueue one.
    verifyUser.mockResolvedValue({ sub: 'viewer-not-creator' });
    networkPathLiveTopologyCapabilityGate.mockReturnValue(
      new Response(JSON.stringify({ status: 'unimplemented' }), { status: 503 }) as any,
    );
    const { POST } = await import('./route');
    const res = await POST(req() as any, { params });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unimplemented');
    expect(createRun).not.toHaveBeenCalled();
  });

  it('the REAL (unmocked) capability gate is 503 today — fetch_live_topology is unimplemented', async () => {
    vi.doUnmock('@/lib/network-path-gate');
    vi.resetModules();
    verifyUser.mockReset();
    process.env.NETWORK_PATH_CHECK_ENABLED = 'true';
    vi.doMock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { POST } = await import('./route');
    const res = await POST(req() as any, { params });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unimplemented');
  });
});

describe('GET /api/network-paths/[id]/runs', () => {
  const getReq = () => new Request('http://x/api/network-paths/chk-1/runs', { headers: { cookie: 'awsops_token=t' } });

  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(getReq() as any, { params });
    expect(res.status).toBe(401);
  });

  it('404 when the check does not exist', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    getCheck.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(getReq() as any, { params });
    expect(res.status).toBe(404);
    expect(listRunsForCheck).not.toHaveBeenCalled();
  });

  it('200 with run history — visible even for a soft-deleted check', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    getCheck.mockResolvedValue({ id: 'chk-1', deleted_at: '2026-08-01T00:00:00Z' });
    listRunsForCheck.mockResolvedValue([{ id: 'run-1' }, { id: 'run-2' }]);
    const { GET } = await import('./route');
    const res = await GET(getReq() as any, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(2);
  });
});
