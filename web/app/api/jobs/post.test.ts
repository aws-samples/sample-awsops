import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const enqueueJob = vi.fn();
// The mock factory REPLACES the module, so it must export every symbol route.ts imports —
// after merging #199 into #195 the POST handler also calls identity() to bind requestedBy
// server-side, and omitting it here made the call throw and surface as a 500.
vi.mock('@/lib/auth', () => ({
  verifyUser: (...a: unknown[]) => verifyUser(...a),
  identity: (u: any) => u.email || u.sub,
}));
vi.mock('@/lib/jobs', async () => {
  const actual = await vi.importActual<typeof import('@/lib/jobs')>('@/lib/jobs');
  return { ...actual, enqueueJob: (...a: unknown[]) => enqueueJob(...a) };
});
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: vi.fn() }) }));

const req = (body: unknown, cookie = 'awsops_token=t') =>
  new Request('http://x/api/jobs', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  verifyUser.mockReset();
  enqueueJob.mockReset();
  process.env.JOBS_QUEUE_URL = 'https://sqs.example/queue';
});

// pentest-remediation P2-review (MAJOR-2): this handler enqueues real Fargate/Lambda work but had
// no auth check at all — a revoked-but-unexpired token (Lambda@Edge is JWT-only, knows nothing of
// session_revocations) could keep enqueuing billable jobs for its full remaining lifetime.
describe('POST /api/jobs', () => {
  it('401 unauth (revoked or missing token) — never reaches enqueueJob', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req({ type: 'noop' }) as any);
    expect(res.status).toBe(401);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
  // The diagnosis lineage join treats `worker_jobs.type = 'report'` as provenance for a payload-supplied
  // report_id, which only holds while this allowlist excludes it. If someone ever adds 'report' here, a
  // client could name any report_id and account (PR #203 codex stop-gate).
  it('rejects report/compliance/sg_rule_scan: they trust payload-supplied ids or must only be '
    + 'enqueued from the trusted daily/admin-refresh path, so only their own routes may enqueue them',
    async () => {
      verifyUser.mockResolvedValue({ sub: 'u-1' });
      const { POST } = await import('./route');
      // sg_rule_scan (SG Rules & Usage daily/manual pipeline, ADR-019 + the design spec's Daily
      // pipeline section) must be rejected here too — it is enqueued only via the internal
      // schedule dispatcher or POST /api/sg/rules/refresh (admin-only), never generically.
      // network_path (Network Path Check, design spec 2026-08-13) must be rejected too — it is
      // enqueued only via POST /api/network-paths/[id]/runs, which validates ownership/access and
      // snapshots the definition server-side before enqueueing.
      for (const type of ['report', 'compliance', 'sg_rule_scan', 'network_path']) {
        const res = await POST(req({ type }) as any);
        expect(res.status).toBe(400);
      }
      expect(enqueueJob).not.toHaveBeenCalled();
    });

  it('202 with job_id when authenticated', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    enqueueJob.mockResolvedValue({ job_id: 'j1', status: 'queued' });
    const { POST } = await import('./route');
    const res = await POST(req({ type: 'noop' }) as any);
    expect(res.status).toBe(202);
    expect((await res.json()).job_id).toBe('j1');
  });
});
