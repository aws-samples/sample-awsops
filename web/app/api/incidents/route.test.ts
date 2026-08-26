import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const listIncidents = vi.fn();
const triageAndCreateOrLink = vi.fn();
const enqueueInitialStage = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/incident', () => ({
  listIncidents: (...a: unknown[]) => listIncidents(...a),
  triageAndCreateOrLink: (...a: unknown[]) => triageAndCreateOrLink(...a),
  enqueueInitialStage: (...a: unknown[]) => enqueueInitialStage(...a),
}));

function get(cookie = 'awsops_token=t') {
  return new Request('http://x/api/incidents', { headers: { cookie } }) as any;
}
function post(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/incidents', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }) as any;
}

beforeEach(() => {
  vi.resetModules();
  verifyUser.mockReset(); isAdmin.mockReset(); listIncidents.mockReset();
  triageAndCreateOrLink.mockReset(); enqueueInitialStage.mockReset();
  verifyUser.mockResolvedValue({ sub: 'a', email: 'admin@x', groups: ['admins'] });
  isAdmin.mockResolvedValue(true);
  listIncidents.mockResolvedValue([]);
  process.env.INCIDENT_LIFECYCLE_ENABLED = 'true';
});

describe('GET /api/incidents (list, admin-gated, read-only)', () => {
  it('403 for non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { GET } = await import('./route');
    expect((await GET(get())).status).toBe(403);
  });
  it('403 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(get())).status).toBe(403);
  });
  it('200 incidents for admin (does NOT trigger anything)', async () => {
    listIncidents.mockResolvedValue([{ id: 'inc-1', status: 'triaged' }]);
    const { GET } = await import('./route');
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect((await res.json()).incidents[0].id).toBe('inc-1');
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
    expect(enqueueInitialStage).not.toHaveBeenCalled();
  });
});

describe('POST /api/incidents (manual trigger, admin-gated, flag-gated)', () => {
  it('403 for non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(post({ title: 'manual incident' }))).status).toBe(403);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });

  it('503 when flag off (no accept) even for an admin', async () => {
    process.env.INCIDENT_LIFECYCLE_ENABLED = 'false';
    const { POST } = await import('./route');
    const res = await POST(post({ title: 'manual incident', severity: 'critical' }));
    expect(res.status).toBe(503);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
    expect(enqueueInitialStage).not.toHaveBeenCalled();
  });

  it('400 on empty free-text', async () => {
    const { POST } = await import('./route');
    expect((await POST(post({ text: '   ' }))).status).toBe(400);
    expect(triageAndCreateOrLink).not.toHaveBeenCalled();
  });

  it('202 admin + flag on: free-text → synthetic event → triage (source=manual); enqueues on New', async () => {
    triageAndCreateOrLink.mockResolvedValue({ decision: 'New', incidentId: 'inc-9' });
    enqueueInitialStage.mockResolvedValue({ jobId: 'job-9' });
    const { POST } = await import('./route');
    const res = await POST(post({ text: 'DB latency spike on orders', severity: 'critical', services: ['orders'] }));
    expect(res.status).toBe(202);
    expect(triageAndCreateOrLink).toHaveBeenCalledTimes(1);
    const ev = triageAndCreateOrLink.mock.calls[0][0];
    expect(ev.source).toBe('manual');
    expect(ev.severity).toBe('critical');
    expect(enqueueInitialStage).toHaveBeenCalledWith('inc-9');
  });

  it('Skipped/Linked decision still 202 but no enqueue', async () => {
    triageAndCreateOrLink.mockResolvedValue({ decision: 'Skipped' });
    const { POST } = await import('./route');
    const res = await POST(post({ text: 'minor blip', severity: 'info' }));
    expect(res.status).toBe(202);
    expect(enqueueInitialStage).not.toHaveBeenCalled();
  });
});
