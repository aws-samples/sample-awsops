import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { listRules, rulesToCsv, ACCOUNT_ID_RE, REGION_RE, type RuleFilter, type RuleStatus } from '@/lib/sg-rules';

export const dynamic = 'force-dynamic';

const STATUSES: RuleStatus[] = ['observed_compatible', 'overlapping', 'no_observed_evidence', 'unassessable', 'not_configured'];

// GET /api/sg/rules — filters + paginates the Aurora SG-rule inventory/activity. Read-auth only
// (no admin gate — this is a read, per the spec's APIs section). Never accepts a raw SQL fragment:
// all filters are bound parameters in web/lib/sg-rules.ts, never concatenated.
export async function GET(req: Request) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const filter: RuleFilter = {};
  const accountId = sp.get('accountId');
  if (accountId) {
    if (!ACCOUNT_ID_RE.test(accountId)) return NextResponse.json({ message: 'invalid accountId' }, { status: 400 });
    filter.accountId = accountId;
  }
  const region = sp.get('region');
  if (region) {
    if (!REGION_RE.test(region)) return NextResponse.json({ message: 'invalid region' }, { status: 400 });
    filter.region = region;
  }
  const vpcId = sp.get('vpcId');
  if (vpcId) filter.vpcId = vpcId.slice(0, 64);
  const sgId = sp.get('sgId');
  if (sgId) filter.sgId = sgId.slice(0, 64);
  const direction = sp.get('direction');
  if (direction === 'ingress' || direction === 'egress') filter.direction = direction;
  const status = sp.get('status');
  if (status && (STATUSES as string[]).includes(status)) filter.status = status as RuleStatus;
  const text = sp.get('q');
  if (text) filter.text = text.slice(0, 128);
  const days = Number(sp.get('days') || '90');
  if (days === 30 || days === 90 || days === 180) filter.days = days;
  const page = Number(sp.get('page') || '1');
  if (Number.isFinite(page)) filter.page = page;
  const pageSize = Number(sp.get('pageSize') || '50');
  if (Number.isFinite(pageSize)) filter.pageSize = pageSize;

  try {
    const { rows, total } = await listRules(filter);
    if (sp.get('format') === 'csv') {
      return new NextResponse(rulesToCsv(rows), {
        status: 200,
        headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="sg-rules.csv"' },
      });
    }
    return NextResponse.json({ rows, total, page: filter.page ?? 1, pageSize: filter.pageSize ?? 50 });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
