import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { verifyUser } from '@/lib/auth';
import { enqueueJob, EnqueueDeliveryError } from '@/lib/jobs';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

// Mirror scripts/v2/workers/handlers.py REGISTRY. The dispatcher Lambda re-validates server-side.
const ALLOWED = new Set(['noop', 'noop-heavy', 'report', 'compliance']);

export async function POST(req: NextRequest) {
  const queueUrl = process.env.JOBS_QUEUE_URL;
  if (!queueUrl) {
    return NextResponse.json(
      { status: 'unconfigured', message: 'JOBS_QUEUE_URL not set (workers disabled)' },
      { status: 503 },
    );
  }

  let body: any;
  try {
    body = await readJsonBounded(req); // bound BEFORE parse (OOM guard)
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ message: 'request body too large' }, { status: 413 });
    return NextResponse.json({ message: 'invalid JSON body' }, { status: 400 });
  }

  const type = body?.type;
  if (typeof type !== 'string' || !ALLOWED.has(type)) {
    return NextResponse.json(
      { message: `unknown job type; allowed: ${[...ALLOWED].join(', ')}` },
      { status: 400 },
    );
  }
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {};
  const dryRun = Boolean(body?.dry_run);
  const idempotencyKey =
    typeof body?.idempotency_key === 'string' && body.idempotency_key ? body.idempotency_key : null;

  // M3: bound the payload well under the SQS 256 KB message cap (the body also wraps
  // job_id/type/dry_run), and keep the JSONB column sane. Reject early, before any write.
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 200_000) {
    return NextResponse.json({ message: 'payload too large (max ~200KB)' }, { status: 413 });
  }

  // enqueueJob (lib/jobs.ts) owns the durable ledger write + SQS send. Status-code contract:
  // ledger-write failure → 500; SQS delivery failure after the row is durably 'queued' → 202 with
  // enqueue:'failed' (the client can poll; a redrive/reaper recovers).
  try {
    const { job_id, status } = await enqueueJob(type, payload, { idempotencyKey, dryRun });
    return NextResponse.json({ job_id, status }, { status: 202 });
  } catch (e) {
    if (e instanceof EnqueueDeliveryError) {
      return NextResponse.json(
        { job_id: e.job_id, status: e.status, enqueue: 'failed', message: e.message },
        { status: 202 },
      );
    }
    return NextResponse.json(
      { status: 'error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  if (!(await verifyUser(req.headers.get('cookie')))) {
    return NextResponse.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const r = await getPool().query(
      `SELECT job_id, type, status, runtime, error, created_at, updated_at
       FROM worker_jobs ORDER BY created_at DESC LIMIT 50`,
    );
    return NextResponse.json({ jobs: r.rows });
  } catch (e) {
    return NextResponse.json(
      { status: 'error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
