export const dynamic = 'force-dynamic';

import { initiateAuth, sessionCookie, safeNext } from '@/lib/login';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

// Thin BFF adapter over lib/login.ts for the v2 in-app /login form. All auth logic lives in
// the lib (unsigned Cognito InitiateAuth + cookie/redirect helpers); this route only parses
// the request, maps the discriminated LoginResult to HTTP, and sets the awsops_token cookie.
//
// Status mapping: invalid input → 400 invalid_request, bad credentials → 401 invalid_credentials,
// account challenge → 403 challenge, transport/5xx → 502 unavailable. Error bodies carry the code
// (not a message string) — the client resolves the i18n copy.

const MAX_EMAIL = 254;
const MAX_PASSWORD = 256;

function jsonError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonBounded(req); // bound BEFORE parse (OOM guard); credentials are tiny
  } catch (e) {
    if (e instanceof BodyTooLargeError) return jsonError('invalid_request', 413);
    return jsonError('invalid_request', 400);
  }

  const { email, password, remember, next } = (body ?? {}) as {
    email?: unknown;
    password?: unknown;
    remember?: unknown;
    next?: unknown;
  };

  if (
    typeof email !== 'string' ||
    email.length === 0 ||
    email.length > MAX_EMAIL ||
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > MAX_PASSWORD
  ) {
    return jsonError('invalid_request', 400);
  }

  const result = await initiateAuth(email, password);

  if (!result.ok) {
    const status = result.code === 'invalid_credentials' ? 401 : result.code === 'challenge' ? 403 : 502;
    return jsonError(result.code, status);
  }

  const redirect = safeNext(typeof next === 'string' ? next : '/');
  return new Response(JSON.stringify({ ok: true, redirect }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': sessionCookie(result.idToken, remember === true, result.expiresIn),
    },
  });
}
