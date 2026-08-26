import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ message: 'invalid job id' }, { status: 400 });
  }
  try {
    const r = await getPool().query(
      `SELECT job_id, type, runtime, status, result, artifact_uri, error, dry_run, attempt, created_at, updated_at
       FROM worker_jobs WHERE job_id = $1`,
      [id],
    );
    if (r.rows.length === 0) {
      return NextResponse.json({ message: 'job not found' }, { status: 404 });
    }
    return NextResponse.json(r.rows[0]);
  } catch (e) {
    return NextResponse.json(
      { status: 'error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
