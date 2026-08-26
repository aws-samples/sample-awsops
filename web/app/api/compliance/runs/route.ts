import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await verifyUser(req.headers.get('cookie')))) {
    return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const r = await getPool().query(
      `SELECT id, worker_job_id, benchmark, status, requested_by, account, pass_rate,
              total_controls, ok, alarm, info, skip, error, error_message, started_at, finished_at
       FROM compliance_runs ORDER BY started_at DESC LIMIT 50`,
    );
    return NextResponse.json({ runs: r.rows });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
