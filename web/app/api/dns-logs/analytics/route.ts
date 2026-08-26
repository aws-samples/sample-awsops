import { verifyUser } from '@/lib/auth';
import { dnsLogStatus, dnsAnalytics, coreDnsGroups, coreDnsAnalytics } from '@/lib/dns-logs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Logs Insights 병렬 쿼리 폴링

const RANGE_ALLOWED = [3600, 21600, 86400, 604800];

// Resolver 쿼리 로그 집계 분석 프록시 — group은 라이브 status의 로그 그룹 allow-list로 검증.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const group = url.searchParams.get('group') ?? '';
  const rangeRaw = Number(url.searchParams.get('range') ?? 3600);
  const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 3600;
  const source = url.searchParams.get('source') ?? 'resolver';
  try {
    if (source === 'coredns') {
      const groups = await coreDnsGroups().catch(() => []);
      if (!groups.some((g) => g.group === group)) {
        return Response.json({ status: 'error', message: 'unknown log group' }, { status: 404 });
      }
      return Response.json({ source, group, range, ...(await coreDnsAnalytics(group, range)) });
    }
    const status = await dnsLogStatus().catch(() => ({ configs: [], groups: [] as string[] }));
    if (!status.groups.includes(group)) {
      return Response.json({ status: 'error', message: 'unknown log group' }, { status: 404 });
    }
    return Response.json({ source, group, range, ...(await dnsAnalytics(group, range)) });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
