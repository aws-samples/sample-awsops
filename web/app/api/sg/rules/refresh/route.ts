import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getFlowSource, listEnabledFlowSources, ACCOUNT_ID_RE, REGION_RE } from '@/lib/sg-rules';
import { enqueueJob, EnqueueDeliveryError, IdempotencyKeyCollisionError } from '@/lib/jobs';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

// POST /api/sg/rules/refresh — admin-only manual refresh. Enqueues the SAME internal job type
// ('sg_rule_scan') the daily dispatcher uses, via lib/jobs.ts's enqueueJob directly — never through
// the generic POST /api/jobs, whose fixed allowlist excludes this type entirely (mirrors
// /api/compliance/run and /api/diagnosis, ADR-009).
export async function POST(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  if (!(await isAdmin(user))) return NextResponse.json({ status: 'error', message: 'admin only' }, { status: 403 });
  if (!process.env.JOBS_QUEUE_URL) {
    return NextResponse.json({ status: 'unconfigured', message: 'workers disabled' }, { status: 503 });
  }

  let body: any = {};
  try {
    body = await readJsonBounded(req, 4_096);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ message: 'request body too large' }, { status: 413 });
    // empty body is fine — refresh all enabled sources
  }

  const accountId = typeof body?.accountId === 'string' ? body.accountId : null;
  const region = typeof body?.region === 'string' ? body.region : null;

  let targets: { account_id: string; region: string }[];
  if (accountId || region) {
    if (!accountId || !ACCOUNT_ID_RE.test(accountId) || !region || !REGION_RE.test(region)) {
      return NextResponse.json({ message: 'accountId and region must both be provided and valid' }, { status: 400 });
    }
    const src = await getFlowSource(accountId, region);
    if (!src) return NextResponse.json({ message: 'no flow source configured for that account/region' }, { status: 404 });
    targets = [{ account_id: src.account_id, region: src.region }];
  } else {
    targets = (await listEnabledFlowSources()).map((s) => ({ account_id: s.account_id, region: s.region }));
  }

  const jobs: { account_id: string; region: string; job_id?: string; error?: string }[] = [];
  for (const t of targets) {
    try {
      const { job_id } = await enqueueJob('sg_rule_scan', {
        account_id: t.account_id, region: t.region, trigger: 'manual_refresh', requested_by: user.sub,
      }, { requestedBy: user.sub });
      jobs.push({ ...t, job_id });
    } catch (e) {
      if (e instanceof EnqueueDeliveryError) jobs.push({ ...t, job_id: e.job_id, error: 'enqueue delivery failed (queued in ledger)' });
      else if (e instanceof IdempotencyKeyCollisionError) jobs.push({ ...t, error: 'idempotency key collision' });
      else jobs.push({ ...t, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ jobs }, { status: 202 });
}
