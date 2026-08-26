import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Global request-body ceiling for /api/* (defense-in-depth). App-Router route handlers impose NO
// default body cap, so this rejects honest oversized bodies BEFORE a handler buffers them. It is a
// belt over the per-route `readJsonBounded` stream-caps (which also catch chunked / absent-Content-Length
// bodies that this header check cannot). Body-less methods are passed straight through.
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB — larger than any legit body (chat caps at 512KB); per-route caps are tighter

export function middleware(request: NextRequest) {
  const m = request.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return NextResponse.next();
  const len = request.headers.get('content-length');
  if (len && Number.isFinite(Number(len)) && Number(len) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'request body too large' }, { status: 413 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
