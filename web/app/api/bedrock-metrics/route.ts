import { verifyUser } from '@/lib/auth';
import { bedrockModelMetrics } from '@/lib/metrics';
import { RANGE_CONFIGS } from '@/lib/bedrock';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const range = url.searchParams.get('range') || '24h';
  const safeRange = RANGE_CONFIGS[range] ? range : '24h';
  // SINGLE-account route: the client fans out + aggregates for "All accounts" (thin-BFF — no
  // server-side N×AssumeRole fan-out). '__all__' here is a client bug → 400.
  const account = url.searchParams.get('account') || undefined;
  if (account === '__all__') {
    return Response.json({ status: 'error', message: 'aggregate across accounts client-side, not via __all__' }, { status: 400 });
  }
  try {
    const data = await bedrockModelMetrics(safeRange, account);
    return Response.json({ range: safeRange, account: account ?? 'self', ...data });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
