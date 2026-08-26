import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { readJsonBounded } from '@/lib/http-body';
import {
  topicArn,
  listSubscribers,
  subscribeEmail,
  unsubscribe,
  isValidEmail,
  belongsToTopic,
} from '@/lib/diagnosis-notify';

// Mailing list for diagnosis-completion email (v1 parity — manual + scheduled). thin-BFF: quick SNS control-plane calls only,
// no heavy work. Read (list) = any authed user; mutate (subscribe/unsubscribe) = admin only.
export const dynamic = 'force-dynamic';

function err(message: string, status: number) {
  return NextResponse.json({ message }, { status });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  const arn = topicArn();
  if (!arn) return NextResponse.json({ enabled: false, canManage: false, subscribers: [] });
  try {
    return NextResponse.json({
      enabled: true,
      canManage: await isAdmin(user),
      subscribers: await listSubscribers(arn),
    });
  } catch {
    return err('failed to list subscribers', 502);
  }
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);
  const arn = topicArn();
  if (!arn) return err('notifications not enabled', 409);
  const body = (await readJsonBounded(request).catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) return err('invalid email', 400);
  try {
    await subscribeEmail(arn, email);
    // Not on the list until the recipient confirms via the SNS email.
    return NextResponse.json({ ok: true, email, status: 'PendingConfirmation' });
  } catch {
    return err('failed to subscribe', 502);
  }
}

export async function DELETE(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);
  const arn = topicArn();
  if (!arn) return err('notifications not enabled', 409);
  const body = (await readJsonBounded(request).catch(() => null)) as { subscriptionArn?: unknown } | null;
  const subArn = typeof body?.subscriptionArn === 'string' ? body.subscriptionArn.trim() : '';
  if (!subArn || !belongsToTopic(subArn, arn)) return err('invalid subscriptionArn', 400);
  try {
    await unsubscribe(subArn);
    return NextResponse.json({ ok: true });
  } catch {
    return err('failed to unsubscribe', 502);
  }
}
