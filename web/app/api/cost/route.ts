import { saveCostSnapshot, getCostSnapshot } from '@/lib/cost-availability';
import { verifyUser } from '@/lib/auth';
import { getMonthlyCostByService, getDailyCostByService, getCostForecast } from '@/lib/aws';

export const dynamic = 'force-dynamic';

// v1-parity period filter ('1m'|'3m'|'6m'|'12m' → trailing calendar months). Unknown/absent → 6
// (the pre-filter default), so old clients / a bad query value degrade to prior behavior.
const ALLOWED_MONTHS = new Set([1, 3, 6, 12]);

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  // SINGLE-account route: the client fans out + aggregates for "All accounts" (thin-BFF).
  const account = params.get('account') || undefined;
  if (account === '__all__') {
    return Response.json({ status: 'error', message: 'aggregate across accounts client-side, not via __all__' }, { status: 400 });
  }
  const monthsRaw = Number(params.get('months'));
  const months = ALLOWED_MONTHS.has(monthsRaw) ? monthsRaw : 6;

  try {
    // monthlyByService is primary (byService/monthly/total all derive from it — matches the old
    // getMtdCost-is-primary contract: a failure here still 500s instead of rendering an empty page).
    const monthlyByService = await getMonthlyCostByService(months, account);
    // dailyByService / forecast are secondary — degrade so the monthly breakdown still renders.
    const dailyByService = await getDailyCostByService(account).catch(() => []);
    const forecast = await getCostForecast(account).catch(() => null);

    const lastMonth = monthlyByService[monthlyByService.length - 1]?.byService ?? [];
    const byService = lastMonth; // already sorted desc, uncapped (v1 parity — the filter panel needs every service, not just top 10)
    const currency = 'USD';
    const total = byService.reduce((s, x) => s + x.amount, 0);
    const monthly = monthlyByService.map((m) => ({ month: m.month, total: m.byService.reduce((s, x) => s + x.amount, 0) }));
    const trend = dailyByService.map((d) => ({ date: d.date, amount: d.byService.reduce((s, x) => s + x.amount, 0) }));

    const body = {
      total, currency, byService, trend, monthly, forecast,
      monthlyByService, dailyByService, account: account ?? 'self',
    };
    // v1 parity: keep the last-good response so a CE outage serves cached data, not a blank page.
    saveCostSnapshot(`${account ?? 'self'}:${months}`, body);
    return Response.json(body);
  } catch (e) {
    // Snapshot fallback: serve the last-good body with an explicit cached marker.
    const snap = getCostSnapshot(`${account ?? 'self'}:${months}`);
    if (snap) {
      return Response.json({ ...(snap.body as Record<string, unknown>), cached: true, cachedAt: snap.at });
    }
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
