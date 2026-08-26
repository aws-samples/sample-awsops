// web/app/api/incidents/[id]/route.ts
// ADR-032 incident detail (admin-gated, READ-ONLY). Mirrors the admin-gate + UUID guard +
// `dynamic = 'force-dynamic'` idiom from web/app/api/actions/[id]/route.ts.
//
// SAFETY (autonomous incident lifecycle shipped OFF):
//   - GET only. There is NO POST here — the detail view triggers/mutates nothing.
//   - The `mitigation_plan` surfaced here is recommendation-only: catalog action NAMES/refs,
//     NEVER an execution. Executing an action is a SEPARATE, human-gated, 4-eyes flow at
//     POST /api/actions/[id] {op:'execute'}; this route emits no such directive.
import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getIncident } from '@/lib/incident';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ message: 'invalid incident id' }, { status: 400 });
  const incident = await getIncident(params.id);
  if (!incident) return NextResponse.json({ message: 'incident not found' }, { status: 404 });
  // Pass through the durable record: stages, findings, rca, and recommendation-only
  // mitigation_plan (action names/refs). No execution directive is ever added here.
  return NextResponse.json({ incident });
}
