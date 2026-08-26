import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import {
  listReports,
  createReport,
  linkReportJob,
  reportForIdempotencyKey,
  markReportFailed,
  type DiagnosisModel,
} from '@/lib/diagnosis';
import { isAdmin } from '@/lib/admin';
import { enqueueJob } from '@/lib/jobs';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  const reports = await listReports(50);
  // can_edit per report: compute isAdmin ONCE (async + SSM-backed), then compare requested_by.
  const admin = await isAdmin(user);
  const me = user.email ?? user.sub;
  return NextResponse.json({
    reports: reports.map((r) => ({ ...r, can_edit: admin || r.requested_by === me })),
  });
}

export async function POST(req: Request) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });

  let body: any = {};
  try {
    body = await readJsonBounded(req); // bound BEFORE parse (OOM guard)
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ message: 'request body too large' }, { status: 413 });
    /* empty/invalid body OK — defaults apply */
  }
  const tier = ['light', 'mid', 'deep'].includes(body?.tier) ? body.tier : 'mid';
  // Only the deep tier may select Opus; every other tier is pinned to Sonnet (cost guard).
  const model: DiagnosisModel = tier === 'deep' && body?.model === 'opus' ? 'opus' : 'sonnet';
  const hostAccount = process.env.AWS_ACCOUNT_ID || '';
  // [PR#37 review MAJOR] fail fast — an empty account would silently reach the LLM context.
  if (!hostAccount) {
    return NextResponse.json(
      { message: 'AWS_ACCOUNT_ID not configured on the web task' },
      { status: 503 },
    );
  }
  // v1 parity: diagnose a selected member account. Validated against the registered accounts
  // table (12-digit + enabled member) — anything else falls back to the host. The worker's
  // Aurora collectors filter by `scope`; host-credentialed live collectors degrade honestly.
  let account = hostAccount;
  let scope = 'self';
  const requested = typeof body?.account === 'string' ? body.account.trim() : '';
  if (requested && requested !== hostAccount && /^[0-9]{12}$/.test(requested)) {
    try {
      const { rows } = await (await import('@/lib/db')).getPool().query(
        `SELECT 1 FROM accounts WHERE account_id = $1 AND enabled AND NOT is_host`,
        [requested],
      );
      if (rows.length > 0) { account = requested; scope = requested; }
    } catch { /* fall back to host */ }
  }
  const email = user.email || user.sub;

  // [GATE-FIX R2 CRITICAL] Idempotency-FIRST → create the report with NULL fk → enqueue (inserts
  // worker_jobs) → LINK. The FK is only set once worker_jobs(job_id) exists.
  const hour = new Date().toISOString().slice(0, 13);
  const key = `report:${email}:${tier}:${model}:${scope}:${hour}`;

  const existing = await reportForIdempotencyKey(key);
  if (existing) {
    return NextResponse.json({ report_id: existing, tier, model, deduped: true }, { status: 202 });
  }

  const reportId = await createReport(tier, email, model); // worker_job_id = NULL (FK-safe)
  let job: { job_id: string; status: string };
  try {
    job = await enqueueJob(
      'report',
      { account, scope, tier, model, requested_by: email, report_id: reportId },
      { idempotencyKey: key },
    );
  } catch (e) {
    await markReportFailed(reportId, 'enqueue failed'); // no orphan running row
    throw e;
  }
  await linkReportJob(reportId, job.job_id); // FK now satisfiable
  return NextResponse.json({ job_id: job.job_id, report_id: reportId, tier, model }, { status: 202 });
}
