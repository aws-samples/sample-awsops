import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { createCheck, ValidationError, listChecks } from '@/lib/network-path';
import { networkPathCheckGate } from '@/lib/network-path-gate';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  const blocked = networkPathCheckGate();
  if (blocked) return blocked;
  const checks = await listChecks(user);
  return NextResponse.json({ checks });
}

export async function POST(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  const blocked = networkPathCheckGate();
  if (blocked) return blocked;

  let body: any;
  try {
    body = await readJsonBounded(req, 65_536);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ message: 'request body too large' }, { status: 413 });
    return NextResponse.json({ message: 'invalid JSON body' }, { status: 400 });
  }

  try {
    const check = await createCheck(user, body ?? {});
    return NextResponse.json({ check }, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ message: e.message }, { status: 400 });
    return NextResponse.json({ message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
