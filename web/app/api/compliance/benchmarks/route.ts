import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Static allowlist for the UI selector — mirrors compliance.ALLOWED (worker) + run/route ALLOWED.
const BENCHMARKS = [
  { id: 'cis_v400', name: 'CIS AWS v4.0.0', description: 'CIS Amazon Web Services Foundations Benchmark v4.0.0' },
  { id: 'cis_v300', name: 'CIS AWS v3.0.0', description: 'CIS Amazon Web Services Foundations Benchmark v3.0.0' },
  { id: 'cis_v200', name: 'CIS AWS v2.0.0', description: 'CIS Amazon Web Services Foundations Benchmark v2.0.0' },
  { id: 'cis_v150', name: 'CIS AWS v1.5.0', description: 'CIS Amazon Web Services Foundations Benchmark v1.5.0' },
];

export async function GET(req: Request) {
  if (!(await verifyUser(req.headers.get('cookie')))) {
    return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  }
  return NextResponse.json({ benchmarks: BENCHMARKS });
}
