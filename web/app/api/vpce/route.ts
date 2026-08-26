import { verifyUser } from '@/lib/auth';
import { vpceAnalysis } from '@/lib/vpce';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RANGE_ALLOWED = [3600, 21600, 86400, 604800];

// VPC Endpoint 리스트+분석: 인벤토리 VPC 리전 fan-out + PrivateLink 메트릭 기반 미사용 감지.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const rangeRaw = Number(new URL(request.url).searchParams.get('range') ?? 86400);
  const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 86400;
  try {
    return Response.json(await vpceAnalysis(range));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
