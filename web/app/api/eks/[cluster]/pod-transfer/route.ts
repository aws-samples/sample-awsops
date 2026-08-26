import { verifyUser } from '@/lib/auth';
import { isAllowed } from '@/lib/eks-registry';
import { nfmPodTransfer } from '@/lib/nfm';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 카테고리별 NFM 쿼리 병렬 폴링

// NFM 모니터 쿼리는 최대 1시간 윈도우 (API ValidationException) — 프리셋도 1h 이하만.
const RANGE_ALLOWED = [900, 1800, 3600];

// EKS 비용 메뉴의 "Pod 전송량 (NFM)" 데이터: 클러스터 모니터의 DATA_TRANSFERRED를
// 카테고리 전체에 대해 질의해 파드별로 합산 + billable(INTER_AZ/VPC/REGION) 추정 비용.
// 모니터 미온보딩 클러스터는 available:false (페이지가 안내로 degrade).
export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  if (!(await isAllowed(params.cluster))) {
    return Response.json({ status: 'error', message: 'unknown cluster' }, { status: 404 });
  }
  const rangeRaw = Number(new URL(request.url).searchParams.get('range') ?? 3600);
  const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 3600;
  try {
    return Response.json(await nfmPodTransfer(params.cluster, range));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
