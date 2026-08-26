import { verifyUser } from '@/lib/auth';
import { dxAnalysis } from '@/lib/dx';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RANGE_ALLOWED = [3600, 21600, 86400, 604800];

// Direct Connect 리스트+분석: 커넥션/VIF 리전 fan-out + 글로벌 DX Gateway +
// AWS/DX 메트릭 기반 다운 감지·피크 사용률·로케이션 이중화 분석.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const rangeRaw = Number(new URL(request.url).searchParams.get('range') ?? 86400);
  const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 86400;
  try {
    return Response.json(await dxAnalysis(range));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
