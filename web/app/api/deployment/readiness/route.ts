import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { deploymentReadiness, validReadinessInput } from '@/lib/deployment-readiness';

export const dynamic = 'force-dynamic';
let inFlight = false;
let lastStartedAt: number | null = null;
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) {
    return Response.json({ status: 'error', reason: 'unauthenticated' }, { status: 401, headers });
  }
  if (!user.groups?.includes('deployment-verifiers') && !(await isAdmin(user))) {
    return Response.json({ status: 'error', reason: 'forbidden' }, { status: 403, headers });
  }
  let input: unknown;
  try { input = await readJsonBounded(request, 1024); }
  catch (error) {
    return Response.json({ status: 'error', reason: 'invalid_request' }, {
      status: error instanceof BodyTooLargeError ? 413 : 400, headers,
    });
  }
  if (!validReadinessInput(input)) {
    return Response.json({ status: 'error', reason: 'invalid_request' }, { status: 400, headers });
  }
  const now = Date.now();
  if (inFlight || (lastStartedAt !== null && now - lastStartedAt < 60_000)) {
    const retry = Math.max(1, Math.min(60, Math.ceil((60_000 - (now - (lastStartedAt ?? now))) / 1000)));
    return Response.json({ status: 'error', reason: 'rate_limited' }, {
      status: 429, headers: { ...headers, 'Retry-After': String(retry) },
    });
  }
  inFlight = true;
  lastStartedAt = now;
  try {
    const result = await deploymentReadiness(input);
    return Response.json(result, { status: result.status === 'ready' ? 200 : 503, headers });
  } finally {
    inFlight = false;
  }
}
