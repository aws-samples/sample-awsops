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
      public_tables: r.rows[0].public_tables,
    });
  } catch (e) {
    // CloudFront authenticates this route; it is not in the edge public-path allowlist.
    // The BFF intentionally skips verifyUser() here under ADR-002 §2-4.
    // Keep connection/schema details in server logs and return only a generic client error.
    console.warn(
      JSON.stringify({ evt: 'db_ping_failed', err: e instanceof Error ? e.message : String(e) }),
    );
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}
