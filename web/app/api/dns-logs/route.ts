import { verifyUser } from '@/lib/auth';
import { dnsLogStatus, coreDnsGroups } from '@/lib/dns-logs';

export const dynamic = 'force-dynamic';

// DNS 쿼리 로그 상태 (메뉴 게이트): Resolver query-log config + CW 로그 그룹 대상.
// 설정이 없거나 권한이 없어도 200 + 빈 configs로 응답 — 페이지가 온보딩 안내를 그린다.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    // CoreDNS(CI application 로그)는 별개 소스 — 한쪽 실패가 다른 쪽을 가리지 않게 개별 degrade.
    const [status, coredns] = await Promise.all([
      dnsLogStatus(),
      coreDnsGroups().catch(() => []),
    ]);
    return Response.json({ ...status, coredns });
  } catch (e) {
    return Response.json({ configs: [], groups: [], coredns: [], error: e instanceof Error ? e.message : String(e) });
  }
}
