import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import {
  ForbiddenError, NotFoundError, ValidationError, getCheck, softDeleteCheck, updateCheck,
} from '@/lib/network-path';
import { networkPathCheckGate } from '@/lib/network-path-gate';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  const blocked = networkPathCheckGate();
  if (blocked) return blocked;
  const check = await getCheck(params.id);
  if (!check || check.deleted_at) return NextResponse.json({ message: 'not found' }, { status: 404 });
  return NextResponse.json({ check });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
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
    const check = await updateCheck(user, params.id, body ?? {});
    return NextResponse.json({ check });
  } catch (e) {
    if (e instanceof NotFoundError) return NextResponse.json({ message: 'not found' }, { status: 404 });
    if (e instanceof ForbiddenError) return NextResponse.json({ message: 'forbidden' }, { status: 403 });
    if (e instanceof ValidationError) return NextResponse.json({ message: e.message }, { status: 400 });
    return NextResponse.json({ message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  const blocked = networkPathCheckGate();
  if (blocked) return blocked;

  try {
    await softDeleteCheck(user, params.id);
    return NextResponse.json({ status: 'deleted' });
  } catch (e) {
    if (e instanceof NotFoundError) return NextResponse.json({ message: 'not found' }, { status: 404 });
    if (e instanceof ForbiddenError) return NextResponse.json({ message: 'forbidden' }, { status: 403 });
    return NextResponse.json({ message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
