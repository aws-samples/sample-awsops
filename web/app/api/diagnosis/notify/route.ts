import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getPool } from '@/lib/db';
import { readJsonBounded } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

// Diagnosis email-notification pause toggle (gap L178, v1 parity): lets an admin pause the
// SNS report/digest emails WITHOUT a deploy (the feature itself stays Terraform-gated by the
// topic's existence). One Aurora row in app_settings — no AWS mutation, not ADR-005 surface.
// Absent key = not paused (today's behavior). The digest worker reads the same key.

const KEY = 'diagnosis_notify_paused';

async function readPaused(): Promise<boolean> {
  const r = await getPool().query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = $1`, [KEY],
  );
  // Same normalization as the digest worker (strip/lower) — an out-of-band 'TRUE ' row must
  // never show 'active' in the UI while the worker suppresses email.
  return (r.rows[0]?.value ?? '').trim().toLowerCase() === 'true';
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  try {
    return NextResponse.json({ paused: await readPaused(), canManage: await isAdmin(user) });
  } catch (e) {
    console.error('diagnosis notify GET failed:', e); // raw DB errors stay server-side
    return NextResponse.json({ message: 'internal error' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  if (!(await isAdmin(user))) return NextResponse.json({ message: 'forbidden: admin only' }, { status: 403 });
  let paused: boolean;
  try {
    const body = (await readJsonBounded(request)) as { paused?: unknown };
    if (typeof body?.paused !== 'boolean') throw new Error('paused must be boolean');
    paused = body.paused;
  } catch {
    return NextResponse.json({ message: 'invalid body' }, { status: 400 });
  }
  try {
    await getPool().query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [KEY, paused ? 'true' : 'false', String(user.sub ?? '')],
    );
    // Pausing silences the sole LIVE external write channel — leave an actor trail in the
    // structured logs too (the row keeps only the latest actor).
    console.log(`[diagnosis-notify] ${paused ? 'PAUSED' : 'RESUMED'} by sub=${String(user.sub ?? '')}`);
    return NextResponse.json({ paused });
  } catch (e) {
    console.error('diagnosis notify PUT failed:', e);
    return NextResponse.json({ message: 'internal error' }, { status: 500 });
  }
}
