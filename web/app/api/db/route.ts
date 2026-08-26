import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!process.env.AURORA_ENDPOINT) {
    return NextResponse.json({ status: 'unconfigured', message: 'AURORA_ENDPOINT not set' }, { status: 503 });
  }
  try {
    const r = await getPool().query(
      "SELECT count(*)::int AS public_tables FROM pg_tables WHERE schemaname = 'public'",
    );
    return NextResponse.json({
      status: 'ok',
      database: process.env.AURORA_DATABASE || 'awsops',
      public_tables: r.rows[0].public_tables,
    });
  } catch (e) {
    return NextResponse.json(
      { status: 'error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
