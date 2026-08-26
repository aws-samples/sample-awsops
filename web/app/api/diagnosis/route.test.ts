import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ verifyUser: vi.fn() }));
vi.mock('@/lib/diagnosis', () => ({
  listReports: vi.fn(async () => [
    { id: 1, requested_by: 'u@x.io' },
    { id: 2, requested_by: 'other@x.io' },
  ]),
  createReport: vi.fn(async () => 42),
  linkReportJob: vi.fn(async () => undefined),
  reportForIdempotencyKey: vi.fn(async () => null),
  markReportFailed: vi.fn(async () => undefined),
}));
vi.mock('@/lib/admin', () => ({ isAdmin: vi.fn(async () => false) }));
vi.mock('@/lib/jobs', () => ({ enqueueJob: vi.fn(async () => ({ job_id: 'j1', status: 'queued' })) }));

import { verifyUser } from '@/lib/auth';
import {
  createReport,
  linkReportJob,
  reportForIdempotencyKey,
  markReportFailed,
} from '@/lib/diagnosis';
import { enqueueJob } from '@/lib/jobs';
import { GET, POST } from './route';

const req = (body?: unknown) =>
  new Request('http://x/api/diagnosis', {
    method: 'POST',
    headers: { cookie: 'awsops_token=t', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AWS_ACCOUNT_ID = '123456789012'; // POST fails fast (503) without it — set the default
  // Re-establish default implementations (clearAllMocks wipes call history, not implementations,
  // so a per-test override like mockRejectedValue would otherwise leak into the next test).
  (createReport as any).mockResolvedValue(42);
  (linkReportJob as any).mockResolvedValue(undefined);
  (reportForIdempotencyKey as any).mockResolvedValue(null);
  (markReportFailed as any).mockResolvedValue(undefined);
  (enqueueJob as any).mockResolvedValue({ job_id: 'j1', status: 'queued' });
});

describe('GET /api/diagnosis', () => {
  it('401 when unauthenticated', async () => {
    (verifyUser as any).mockResolvedValue(null);
    const r = await GET(req());
    expect(r.status).toBe(401);
  });
  it('lists when authed', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect((await r.json()).reports[0].id).toBe(1);
  });
  it('attaches can_edit per report (owner true, others false for a non-admin)', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    const reports = (await (await GET(req())).json()).reports;
    expect(reports.find((r: any) => r.id === 1).can_edit).toBe(true);   // owner
    expect(reports.find((r: any) => r.id === 2).can_edit).toBe(false);  // someone else's
  });
});

describe('POST /api/diagnosis', () => {
  it('401 when unauthenticated', async () => {
    (verifyUser as any).mockResolvedValue(null);
    const r = await POST(req({ tier: 'mid' }));
    expect(r.status).toBe(401);
  });

  it('enqueues a mid report (FK-safe order: create → enqueue → link)', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    const r = await POST(req({ tier: 'mid' }));
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.job_id).toBe('j1');
    expect(j.report_id).toBe(42);
    expect(j.tier).toBe('mid');
    // create BEFORE enqueue (FK-safe), with NULL fk; link AFTER enqueue with the canonical job_id.
    expect(createReport).toHaveBeenCalledWith('mid', 'u@x.io', 'sonnet');
    expect(enqueueJob).toHaveBeenCalledWith(
      'report',
      expect.objectContaining({ tier: 'mid', model: 'sonnet', requested_by: 'u@x.io', report_id: 42 }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('report:u@x.io:mid:sonnet:') }),
    );
    expect(linkReportJob).toHaveBeenCalledWith(42, 'j1');
  });

  it('accepts a deep tier (no longer coerced) and defaults to sonnet', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    const r = await POST(req({ tier: 'deep' }));
    const j = await r.json();
    expect(j.tier).toBe('deep');
    expect(j.model).toBe('sonnet');
    expect(createReport).toHaveBeenCalledWith('deep', 'u@x.io', 'sonnet');
  });

  it('honors model=opus only on the deep tier', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    await POST(req({ tier: 'deep', model: 'opus' }));
    expect(createReport).toHaveBeenCalledWith('deep', 'u@x.io', 'opus');
  });

  it('pins model to sonnet when opus is requested on a non-deep tier', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    await POST(req({ tier: 'mid', model: 'opus' }));
    expect(createReport).toHaveBeenCalledWith('mid', 'u@x.io', 'sonnet');
  });

  it('returns the existing report on idempotency hit (deduped)', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    (reportForIdempotencyKey as any).mockResolvedValue(7);
    const r = await POST(req({ tier: 'mid' }));
    expect(r.status).toBe(202);
    expect((await r.json())).toMatchObject({ report_id: 7, deduped: true });
    expect(createReport).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('fails the orphan report row when enqueue throws', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    (enqueueJob as any).mockRejectedValue(new Error('boom'));
    await expect(POST(req({ tier: 'mid' }))).rejects.toThrow('boom');
    expect(markReportFailed).toHaveBeenCalledWith(42, 'enqueue failed');
  });

  it('coerces an unknown tier to mid', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    await POST(req({ tier: 'bogus' }));
    expect(createReport).toHaveBeenCalledWith('mid', 'u@x.io', 'sonnet');
  });

  it('503 + no work when AWS_ACCOUNT_ID is unset (fails fast, no empty account to the LLM)', async () => {
    (verifyUser as any).mockResolvedValue({ sub: 'u', email: 'u@x.io' });
    delete process.env.AWS_ACCOUNT_ID;
    const r = await POST(req({ tier: 'mid' }));
    expect(r.status).toBe(503);
    expect(createReport).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
