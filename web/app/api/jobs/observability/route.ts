import { NextRequest } from 'next/server';
import { verifyUser, ownerKeysForRead } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getPool } from '@/lib/db';
import { jobTiming, summarizeJobs, type ObservedJob } from '@/lib/job-observability';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return Response.json({ message: 'unauthenticated' }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const windowHours = Number(params.get('windowHours') ?? 24);
  const targetMs = params.has('targetMs') ? Number(params.get('targetMs')) : undefined;
  const type = params.get('type') || null;
  if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168
    || (targetMs !== undefined && (!Number.isSafeInteger(targetMs) || targetMs <= 0 || targetMs > 86_400_000))
    || (type !== null && !/^[a-z0-9_-]{1,64}$/.test(type))) {
    return Response.json({ message: 'invalid workload query' }, { status: 400 });
  }
  const nowMs = Date.now();
  const start = new Date(nowMs - windowHours * 3_600_000).toISOString();
  const end = new Date(nowMs).toISOString();
  try {
    const admin = await isAdmin(user);
    // The count and sampled rows come from the same query snapshot. Large windows are marked
    // partial, never reported as a passing objective based only on the latest 2,000 jobs.
    const result = await getPool().query<ObservedJob & { total_count: string | number }>(
      `SELECT job_id, type, status, runtime, error, attempt, created_at,
              to_jsonb(j)->>'started_at' AS started_at, to_jsonb(j)->>'finished_at' AS finished_at,
              count(*) OVER() AS total_count
         FROM worker_jobs j
        WHERE ($2::boolean OR requested_by = ANY($1))
          AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz
          AND ($5::text IS NULL OR type = $5)
        ORDER BY created_at DESC, job_id DESC LIMIT 2000`,
      [[...ownerKeysForRead(user)], admin, start, end, type],
    );
    const totalCount = Number(result.rows[0]?.total_count ?? 0);
    return Response.json({
      window: { start, end, basis: 'accepted_in_window' },
      scope: admin ? 'all_jobs' : 'own_jobs',
      summary: summarizeJobs(result.rows, { nowMs, targetMs, totalCount }),
      jobs: result.rows.slice(0, 50).map(({ total_count: _total, ...job }) => ({
        ...job, timing: jobTiming(job, nowMs),
      })),
    });
  } catch {
    return Response.json({ message: 'workload observations unavailable' }, { status: 500 });
  }
}
