import { verifyUser } from '@/lib/auth';
import { getVpcConnectivity, validVpcConnectivityInput, VpcConnectivityError } from '@/lib/vpc-connectivity';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function GET(request: Request) {
  const reply = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { 'Cache-Control': 'private, no-store' },
  });
  const fail = (code: string, status: number) => reply({ status: 'error', code }, status);
  if (!(await verifyUser(request.headers.get('cookie')))) return fail('unauthenticated', 401);
  const params = new URL(request.url).searchParams;
  const input = { account: params.get('account') ?? '', region: params.get('region') ?? '', vpcId: params.get('vpcId') ?? '' };
  if (['account', 'region', 'vpcId'].some(key => params.getAll(key).length !== 1) || !validVpcConnectivityInput(input)) {
    return fail('invalid_request', 400);
  }
  try {
    return reply(await getVpcConnectivity(input));
  } catch (error) {
    const code = error instanceof VpcConnectivityError ? error.code : 'lookup_failed';
    return fail(code, { invalid_request: 400, not_found: 404, account_unavailable: 403, lookup_failed: 502 }[code]);
  }
}
