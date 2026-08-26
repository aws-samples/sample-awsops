import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
const enqueueJob = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
vi.mock('@/lib/jobs', () => ({
  enqueueJob: (...a: unknown[]) => enqueueJob(...a),
  EnqueueDeliveryError: class extends Error {},
}));
const req = (body: unknown) =>
  new Request('http://x/api/compliance/run', {
    method: 'POST',
    headers: { cookie: 'awsops_token=t', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  verifyUser.mockReset();
  query.mockReset();
  enqueueJob.mockReset();
  process.env.JOBS_QUEUE_URL = 'https://sqs/x';
});

describe('POST /api/compliance/run', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ benchmark: 'cis_v300' }))).status).toBe(401);
  });
  it('400 on disallowed benchmark (argv-injection guard)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@b' });
    const { POST } = await import('./route');
    expect((await POST(req({ benchmark: 'evil; rm -rf' }))).status).toBe(400);
  });
  it('202 pre-creates run row then enqueues', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@b' });
    query.mockResolvedValueOnce({ rows: [{ id: 42 }] }); // INSERT ... RETURNING id
    enqueueJob.mockResolvedValue({ job_id: 'j1', status: 'queued' });
    const { POST } = await import('./route');
    const res = await POST(req({ benchmark: 'cis_v300' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ run_id: 42, job_id: 'j1' });
    expect(enqueueJob).toHaveBeenCalledWith(
      'compliance',
      expect.objectContaining({ benchmark: 'cis_v300', run_id: 42 }),
      expect.anything(),
    );
    // links the run 1:1 to its worker job
    expect(query.mock.calls.some((c) => /UPDATE compliance_runs SET worker_job_id/.test(String(c[0])))).toBe(true);
  });
  it('503 when workers unconfigured', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    delete process.env.JOBS_QUEUE_URL;
    const { POST } = await import('./route');
    expect((await POST(req({ benchmark: 'cis_v300' }))).status).toBe(503);
  });
});
