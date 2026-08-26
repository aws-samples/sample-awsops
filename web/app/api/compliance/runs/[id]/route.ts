import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!(await verifyUser(req.headers.get('cookie')))) {
    return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: 'invalid run id' }, { status: 400 });
  }
  try {
    const pool = getPool();
    const runR = await pool.query(
      `SELECT id, worker_job_id, benchmark, status, requested_by, pass_rate,
              total_controls, ok, alarm, info, skip, error, error_message, started_at, finished_at
       FROM compliance_runs WHERE id = $1`,
      [id],
    );
    if (runR.rows.length === 0) {
      return NextResponse.json({ message: 'run not found' }, { status: 404 });
    }
    const resR = await pool.query(
      `SELECT control_id, title, section, status, reason, resource, region, severity
       FROM compliance_results WHERE run_id = $1
       ORDER BY section, control_id, status`,
      [id],
    );
    return NextResponse.json({ run: runR.rows[0], results: resR.rows });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
