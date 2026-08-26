import { verifyUser } from '@/lib/auth';
import { sgAnalysis, sgHits, resolveScopeRegions } from '@/lib/sg-analysis';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RANGE_ALLOWED = [3600, 21600, 86400, 604800];

// AWS 리전 형식만 허용(예: ap-northeast-2) — DB 쿼리 파라미터로 그대로 들어가므로 형식 검증.
// 리뷰 MAJOR(확정, 라운드5): 세그먼트 3개 고정이라 us-gov-west-1/us-iso-east-1 같은 4세그먼트
// 리전이 형식 검사에서 통과 못 해 스코프에서 조용히 빠졌다(다른 세그먼트 수 리전도 동일 위험).
// 세그먼트 개수를 고정하지 않고 "2자 시작 + 하이픈-단어 반복 + 끝 숫자" 형태로 완화.
// 리뷰 MINOR(확정, 라운드9): 첫 세그먼트를 2자로 고정해 eusc-de-east-1(유럽 소버린
// 클라우드)처럼 4자 접두사인 리전이 여전히 거부됐다 — 2~4자로 완화.
const REGION_RE = /^[a-z]{2,4}(-[a-z]+)+-\d$/;

// 리뷰 MAJOR(확정): 스코프 파라미터가 없으면 /api/sg는 항상 호스트 계정 전 리전을 스캔해
// 페이지 상단의 계정/리전 선택과 무관하게 보였다(형제 TgwSection은 scope-filtered rows의
// ids를 서버에 넘겨 스코핑) — ?regions=로 현재 뷰의 SG 인벤토리 행이 속한 리전만 스캔하도록
// SgAnalysisSection이 넘긴다.
// 리뷰 MAJOR(확정): scopeCacheKey는 정렬된 리전 목록 그대로를 캐시 키로 쓰므로, 길이
// 제한이 없으면 실제 리전의 부분집합을 계속 바꿔 요청하는 것만으로 매번 새 캐시 키가
// 생겨 4분 TTL을 무한히 우회하고(계정 공유 쿼터에 매 요청 풀 스캔) sg-analysis.ts의
// detailCacheByScope/ipLabelCacheByScope에 스코프별 Map을 계속 새로 쌓는다(OOM
// 민감한 Fargate web 티어에서 무제한 증가). 실사용(페이지의 계정/리전 선택)은 한
// 화면에 표시되는 리전 몇 개를 넘지 않으므로 넉넉한 상한으로 그 외의 조합 폭증을 막는다.
// 리뷰 MAJOR(라운드11, 오탐 — 파일 truncation): 이 상한은 "한 요청의 스코프 크기"만
// 막고 "가능한 서로 다른 스코프 키의 개수"는 안 막는다는 지적 — 맞지만 그건 이미 두
// 겹으로 막혀 있다: (1) 아래 resolveScopeRegions()가 요청 리전을 인벤토리 실존 리전과
// 교집합해 키 공간을 실제 리전 수로 좁히고, (2) sg-analysis.ts의 detailCacheByScope/
// ipLabelCacheByScope 자체가 MAX_SCOPE_ENTRIES=32 FIFO eviction으로 상한이 걸려 있다
// (`evictOldest`, sg-analysis.ts:25-30/44-51/495-497 — 라운드6에서 이미 추가). 리뷰가
// 3000줄 truncation으로 그 파일을 못 보고 route.ts만으로 판단해 생긴 오탐.
const MAX_SCOPE_REGIONS = 20;
// 리뷰 MAJOR(확정, 라운드5): 페이지는 "위 표와 같은 리전만 스캔한다"고 명시하는데,
// 20개 초과 시 나머지를 이 함수가 조용히 잘라버리면(형식 불일치로 걸러진 리전도 마찬가지)
// SG 총계·미사용 SG 판정·"이상 없음" 배너가 실제로는 불완전한데 확정처럼 보인다 —
// degradedRegions와 같은 계약 위반. truncated를 반환해 호출자가 응답에 신호를 얹게 한다.
function parseRegions(url: URL): { regions: string[] | undefined; truncated: boolean; invalid: boolean } {
  // 리뷰 MINOR(확정, 라운드9): `?regions=`(빈 값)은 `url.searchParams.get`이 ''를 반환해
  // `!raw` 분기를 타고 "파라미터 없음"(정당한 전체 스캔)과 똑같이 처리됐다 — 파라미터가
  // "명시적으로 존재하는데 비어 있음"과 "아예 없음"을 `has()`로 구분해야, 빈 값도
  // 아래 유효-리전-0건 거부 로직을 똑같이 타게 된다(라운드6 결정과 일관).
  if (!url.searchParams.has('regions')) return { regions: undefined, truncated: false, invalid: false };
  const raw = url.searchParams.get('regions') ?? '';
  const requested = new Set(raw.split(',').map((r) => r.trim()).filter(Boolean));
  const valid = [...requested].filter((r) => REGION_RE.test(r));
  const capped = valid.slice(0, MAX_SCOPE_REGIONS);
  // requested는 이미 중복 제거됐으므로, 여기서 줄어들었다면 형식 불일치로 걸러졌거나
  // 상한에 잘린 것 — 단순 중복 제거로는 truncated가 되지 않는다.
  const truncated = capped.length < requested.size;
  // 리뷰 MINOR(확정, 라운드6): ?regions=가 있는데 하나도 유효하지 않으면 이전엔
  // regions:undefined를 반환해 "스코프 없음"(전 리전 스캔)으로 조용히 넓어졌다 —
  // 사용자가 명시적으로 스코프를 요청했는데 정반대로 넓혀버리는 게 오히려 위험하다.
  // regions param이 아예 없는 경우(정당한 전체 스캔 요청)와는 구분해 거부한다.
  const invalid = capped.length === 0;
  return { regions: capped.length > 0 ? capped : undefined, truncated, invalid };
}

// Security Group 분석: 사용 유무(ENI 부착+상호참조) + 룰 소스/목적지 식별.
// ?regions=a,b → 해당 리전만 스캔(페이지 스코프와 동일 범위). 안 주면 인벤토리 전 리전.
// ?view=hits&id=sg-... → 선택 SG 히트 매칭 (Flow Logs 우선, NFM 폴백).
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const { regions: formatRegions, truncated: formatTruncated, invalid } = parseRegions(url);
  if (invalid) {
    return Response.json({ status: 'error', message: 'no valid region in regions param' }, { status: 400 });
  }
  // 리뷰 MAJOR(확정, 라운드7): sg-analysis.ts의 resolveScopeRegions()는 인벤토리와
  // 교집합해 실제 없는 리전을 걸러내지만(캐시 오염 방지), 그 사실이 route까지 안
  // 올라와 scopeTruncated에 반영되지 않았다 — 인벤토리에 없는 리전만 요청되면
  // 조용히 "스코프 없음"(전 리전 스캔)으로 넓어졌다. 여기서 직접 호출해 dropped를
  // truncated에 합치고, 형식은 유효했지만 인벤토리에 전혀 없는 경우는 형식-무효와
  // 동일하게 거부한다(넓히지 않음).
  const { regions, dropped } = await resolveScopeRegions(formatRegions);
  if (formatRegions && formatRegions.length > 0 && !regions) {
    return Response.json({ status: 'error', message: 'no valid region in regions param' }, { status: 400 });
  }
  const scopeTruncated = formatTruncated || dropped;
  try {
    if (url.searchParams.get('view') === 'hits') {
      const id = url.searchParams.get('id') ?? '';
      if (!/^sg-[0-9a-f]{8,17}$/.test(id)) {
        return Response.json({ status: 'error', message: 'invalid sg id' }, { status: 400 });
      }
      const rangeRaw = Number(url.searchParams.get('range') ?? 86400);
      const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 86400;
      return Response.json({ ...(await sgHits(id, range, regions)), scopeTruncated });
    }
    return Response.json({ ...(await sgAnalysis(regions)), scopeTruncated });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
