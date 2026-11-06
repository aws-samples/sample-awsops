import { verifyUser } from '@/lib/auth';
import { isTransientRead } from '@/lib/bounded-cache';
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
  // A saturated/throttled allow-list lookup is not proof the group is unknown: retryable 503.
  // A permanent lookup failure (e.g. AccessDenied) is a non-retryable error with a generic message.
  const unavailable = () => Response.json(
    { status: 'error', message: 'log group lookup temporarily unavailable', retryable: true },
    { status: 503, headers: { 'Retry-After': '5' } });
  const lookupFailed = (e: unknown) => (isTransientRead(e) ? unavailable()
    : Response.json({ status: 'error', message: 'log group lookup failed', retryable: false }, { status: 502 }));
  try {
    if (source === 'coredns') {
      let groups;
      try { groups = await coreDnsGroups(); } catch (e) { return lookupFailed(e); }
      if (!groups.some((g) => g.group === group)) {
        return Response.json({ status: 'error', message: 'unknown log group' }, { status: 404 });
      }
      return Response.json({ source, group, range, ...(await coreDnsAnalytics(group, range)) });
    }
    let status;
    try { status = await dnsLogStatus(); } catch (e) { return lookupFailed(e); }
    if (!status.groups.includes(group)) {
      return Response.json({ status: 'error', message: 'unknown log group' }, { status: 404 });
    }
    return Response.json({ source, group, range, ...(await dnsAnalytics(group, range)) });
  } catch (e) {
    if (isTransientRead(e)) return unavailable();
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
