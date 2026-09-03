import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { topicArn, publishTest } from '@/lib/diagnosis-notify';

// Test-notification send (gap-audit L53, v1 parity). Admin-only, no body: publishes one SNS test
// message to the diagnosis topic so a freshly confirmed subscriber can verify delivery. Same
// gates as the sibling subscribe/unsubscribe mutations; a publish failure surfaces as 502 —
// never a silent success. This is a notification to the app's own topic — a governed
// external-comms write per ADR-013 (ADR-040/041 lineage), not an AWS-resource mutation.
export const dynamic = 'force-dynamic';

// Server-side cooldown (per pod): the client `busy` flag alone can't stop an admin session from
// flooding every confirmed subscriber. In-memory is enough — the goal is rate-bounding a human
// button, not a distributed lock; a pod restart resetting it is acceptable.
const COOLDOWN_MS = 60_000;
let lastSentAt = 0;

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  if (!(await isAdmin(user))) return NextResponse.json({ message: 'admin only' }, { status: 403 });
  const arn = topicArn();
  if (!arn) return NextResponse.json({ message: 'notifications disabled' }, { status: 404 });
  if (Date.now() - lastSentAt < COOLDOWN_MS) {
    return NextResponse.json({ message: 'cooldown — try again shortly' }, { status: 429 });
  }
  try {
    // Audit trail stays server-side (sub only — repo precedent avoids emails in logs); the
    // message body deliberately omits the admin's identity.
    console.info(`diagnosis test publish triggered by sub=${user.sub}`);
    lastSentAt = Date.now();
    const messageId = await publishTest(arn);
    return NextResponse.json({ messageId: messageId ?? null });
  } catch (e) {
    // Log the detail server-side only — SNS auth errors embed role/topic ARNs (sibling routes
    // return generic messages for the same reason).
    console.error('diagnosis test publish failed:', e);
    return NextResponse.json({ message: 'publish failed' }, { status: 502 });
  }
}
