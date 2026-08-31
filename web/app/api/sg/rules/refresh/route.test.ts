import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const getFlowSource = vi.fn();
const listEnabledFlowSources = vi.fn();
const enqueueJob = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/sg-rules', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sg-rules')>('@/lib/sg-rules');
  return {
    ...actual,
    getFlowSource: (...a: unknown[]) => getFlowSource(...a),
    listEnabledFlowSources: (...a: unknown[]) => listEnabledFlowSources(...a),
  };
});
vi.mock('@/lib/jobs', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jobs')>('@/lib/jobs');
  return { ...actual, enqueueJob: (...a: unknown[]) => enqueueJob(...a) };
});

const req = (body?: unknown, cookie = 'awsops_token=t') =>
  new Request('http://x/api/sg/rules/refresh', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset(); getFlowSource.mockReset();
  listEnabledFlowSources.mockReset(); enqueueJob.mockReset();
  process.env.JOBS_QUEUE_URL = 'https://sqs.example/queue';
});

describe('POST /api/sg/rules/refresh', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req({}) as any);
    expect(res.status).toBe(401);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('403 authenticated but not admin', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    const res = await POST(req({}) as any);
    expect(res.status).toBe(403);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues sg_rule_scan for every enabled source when no account/region is given', async () => {
    verifyUser.mockResolvedValue({ sub: 'admin-1' });
    isAdmin.mockResolvedValue(true);
    listEnabledFlowSources.mockResolvedValue([
      { account_id: '123456789012', region: 'ap-northeast-2' },
      { account_id: '210987654321', region: 'us-east-1' },
    ]);
    enqueueJob.mockResolvedValue({ job_id: 'j1' });
    const { POST } = await import('./route');
    const res = await POST(req({}) as any);
    expect(res.status).toBe(202);
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(enqueueJob).toHaveBeenCalledWith('sg_rule_scan', expect.objectContaining({ account_id: '123456789012' }), expect.any(Object));
  });

  it('404 when a specific account/region has no configured source', async () => {
    verifyUser.mockResolvedValue({ sub: 'admin-1' });
    isAdmin.mockResolvedValue(true);
    getFlowSource.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req({ accountId: '123456789012', region: 'ap-northeast-2' }) as any);
    expect(res.status).toBe(404);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
