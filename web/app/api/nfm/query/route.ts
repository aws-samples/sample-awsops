import { verifyUser } from '@/lib/auth';
import { nfmStatus, nfmTopContributors, NFM_METRICS, NFM_CATEGORIES, type NfmMetric, type NfmCategory } from '@/lib/nfm';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // NFM 비동기 쿼리 폴링 (수 초~수십 초)

// NFM 모니터 쿼리는 최대 1시간 윈도우 (API ValidationException) — 프리셋도 1h 이하만.
const RANGE_ALLOWED = [900, 1800, 3600];

// Top contributors 쿼리 프록시. 모든 입력을 allow-list로 검증:
// monitor는 라이브 ListMonitors 결과에 실존해야 하고, metric/category/range는 enum.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const monitor = url.searchParams.get('monitor') ?? '';
  const metric = url.searchParams.get('metric') ?? 'DATA_TRANSFERRED';
  const category = url.searchParams.get('category') ?? 'INTER_AZ';
  const rangeRaw = Number(url.searchParams.get('range') ?? 3600);
  const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 3600;

  if (!(NFM_METRICS as readonly string[]).includes(metric) || !(NFM_CATEGORIES as readonly string[]).includes(category)) {
    return Response.json({ status: 'error', message: 'unknown metric/category' }, { status: 400 });
  }
  const status = await nfmStatus().catch(() => ({ monitors: [], scopeCount: 0 }));
  if (!status.monitors.some((m) => m.name === monitor)) {
    return Response.json({ status: 'error', message: 'unknown monitor' }, { status: 404 });
  }
  try {
    const result = await nfmTopContributors(monitor, metric as NfmMetric, category as NfmCategory, range);
    return Response.json({ monitor, metric, category, range, ...result });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
