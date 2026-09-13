import { verifyUser } from '@/lib/auth';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { deploymentReadiness, validReadinessInput } from '@/lib/deployment-readiness';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', reason: 'unauthenticated' }, { status: 401, headers });
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
  const result = await deploymentReadiness(input);
  return Response.json(result, { status: result.status === 'ready' ? 200 : 503, headers });
}
