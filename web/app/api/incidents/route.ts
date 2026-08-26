// web/app/api/incidents/route.ts
// ADR-032 incident reads + manual trigger (admin-gated). Mirrors the admin-gate +
// `dynamic = 'force-dynamic'` idiom from web/app/api/actions/route.ts.
//
// SAFETY (autonomous incident lifecycle shipped OFF):
//   - GET (list) is READ-ONLY: it triggers nothing. Admin-gated.
//   - POST (manual trigger) is admin-gated AND flag-gated: when
//     INCIDENT_LIFECYCLE_ENABLED !== 'true' it returns 503 and does NOT accept (no triage,
//     no enqueue). Even an admin cannot start a lifecycle while the flag is off.
//   - Manual free-text becomes a synthetic, source='manual' AlertEvent. It NEVER influences
//     tool perms / sub-agent roster / approval; it is just descriptive incident data. This
//     route NEVER executes a mutation — on accept it does Triage + first-stage enqueue only.
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { listIncidents, triageAndCreateOrLink, enqueueInitialStage } from '@/lib/incident';
import type { AlertEvent, AlertSeverity } from '@/lib/incident-normalize';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });
  return NextResponse.json({ incidents: await listIncidents() });
}

function coerceSeverity(raw: unknown): AlertSeverity {
  return raw === 'critical' ? 'critical' : raw === 'info' ? 'info' : 'warning';
}

export async function POST(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });

  // BINDING — flag check: no manual accept when off (no triage / no enqueue).
  if (process.env.INCIDENT_LIFECYCLE_ENABLED !== 'true') {
    return NextResponse.json({ message: 'incident lifecycle disabled (flag off)' }, { status: 503 });
  }

  let body: any;
  try { body = await readJsonBounded(req); }
  catch (e) { if (e instanceof BodyTooLargeError) return NextResponse.json({ message: 'request body too large' }, { status: 413 }); return NextResponse.json({ message: 'invalid JSON' }, { status: 400 }); }

  const text = String(body?.text ?? body?.title ?? body?.message ?? '').trim();
  if (!text) return NextResponse.json({ message: 'free-text (text|title|message) required' }, { status: 400 });

  const severity = coerceSeverity(body?.severity);
  const services: string[] = Array.isArray(body?.services) ? body.services.map(String).slice(0, 20) : [];
  const resources: string[] = Array.isArray(body?.resources) ? body.resources.map(String).slice(0, 20) : [];
  const alertName = String(body?.title ?? text).slice(0, 256);
  const now = new Date().toISOString();
  const id = createHash('sha256')
    .update(`manual:${alertName}:${[...services].sort().join(',')}:${[...resources].sort().join(',')}`)
    .digest('hex').slice(0, 16);

  // Synthetic, source='manual' event. Descriptive only; carries no control surface.
  const event: AlertEvent = {
    id,
    source: 'manual' as unknown as AlertEvent['source'],
    alertName,
    severity,
    status: 'firing',
    message: text.slice(0, 4096),
    timestamp: now,
    labels: {},
    annotations: { manual_trigger_by: user.email ?? user.sub },
    services,
    resources,
    rawPayload: { manual: true, text: text.slice(0, 4096) },
  };

  const decision = await triageAndCreateOrLink(event);
  if (decision.decision === 'New' && decision.incidentId) {
    await enqueueInitialStage(decision.incidentId);
  }
  return NextResponse.json({ status: 'accepted', decision: decision.decision, incidentId: decision.incidentId }, { status: 202 });
}
