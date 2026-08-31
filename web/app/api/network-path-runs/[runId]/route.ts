import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { getRunDetail } from '@/lib/network-path';
import { networkPathCheckGate } from '@/lib/network-path-gate';

export const dynamic = 'force-dynamic';

/**
 * Run status + progress (status/phase) and, once concluded, overall_status + candidates + steps +
 * validation_bundle — spec: "GET /api/network-path-runs/[runId]". Any authenticated viewer may read
 * run history (spec "UI and ownership": "Any authorized viewer may run the check and view its
 * history").
 */
export async function GET(req: NextRequest, { params }: { params: { runId: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  const blocked = networkPathCheckGate();
  if (blocked) return blocked;

  const run = await getRunDetail(params.runId);
  if (!run) return NextResponse.json({ message: 'not found' }, { status: 404 });
  return NextResponse.json({ run });
}
