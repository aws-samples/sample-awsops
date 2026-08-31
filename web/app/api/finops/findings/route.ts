// ADR-020 FinOps baseline-recommendations engine — read-only surface for /cost. Thin-BFF: reads
// finops_findings + the latest finops_runs row (the daily worker owns all the writes; the request
// path never calls a live AWS API). Gated on FINOPS_BASELINE_ENABLED (omitted from the web task def
// when the feature flag is off — see workload.tf), matching the /api/insights pattern.
import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return Response.json(obj, { status });
}

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return json({ status: 'error', message: 'unauthenticated' }, 401);
  }
  if (process.env.FINOPS_BASELINE_ENABLED !== 'true') {
    return json({ enabled: false, findings: [], lastRun: null }, 200);
  }
  // `/cost` is account-scoped (useActiveAccount) but ebs_unattached deliberately spans every
  // synced account/region in one pass, so unlike single-account routes this filter is optional:
  // omitted or '__all__' -> fleet-wide (every finding still carries its own accountId/region so
  // the UI can label it), 'self' or a specific id -> scoped to that account only. A review round
  // caught that the card ignored the page's account selection entirely.
  const account = new URL(request.url).searchParams.get('account');
  const scoped = account && account !== '__all__';
  try {
    const [findingsRes, runRes] = await Promise.all([
      getPool().query(
        scoped
          ? `SELECT id, rule_id, account_id, region, resource_id, title, category, status, monthly_savings_usd,
                    evidence, guard_hits, explanation_ko, first_seen_at, last_seen_at
               FROM finops_findings
              WHERE status != 'resolved' AND account_id = $1
              ORDER BY (monthly_savings_usd IS NULL), monthly_savings_usd DESC NULLS LAST, first_seen_at DESC`
          : `SELECT id, rule_id, account_id, region, resource_id, title, category, status, monthly_savings_usd,
                    evidence, guard_hits, explanation_ko, first_seen_at, last_seen_at
               FROM finops_findings
              WHERE status != 'resolved'
              ORDER BY (monthly_savings_usd IS NULL), monthly_savings_usd DESC NULLS LAST, first_seen_at DESC`,
        scoped ? [account] : [],
      ),
      getPool().query(
        `SELECT id, started_at, finished_at, status, rules_evaluated, findings_count, ce_api_calls, error
           FROM finops_runs
          ORDER BY started_at DESC
          LIMIT 1`,
      ),
    ]);
    const findings = findingsRes.rows.map((r) => ({
      id: r.id,
      ruleId: r.rule_id,
      accountId: r.account_id,
      region: r.region,
      resourceId: r.resource_id,
      title: r.title,
      category: r.category,
      status: r.status,
      monthlySavingsUsd: r.monthly_savings_usd === null ? null : Number(r.monthly_savings_usd),
      evidence: r.evidence,
      guardHits: r.guard_hits ?? [],
      explanationKo: r.explanation_ko,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    }));
    const lastRun = runRes.rows[0]
      ? {
          id: runRes.rows[0].id,
          startedAt: runRes.rows[0].started_at,
          finishedAt: runRes.rows[0].finished_at,
          status: runRes.rows[0].status,
          rulesEvaluated: runRes.rows[0].rules_evaluated,
          findingsCount: runRes.rows[0].findings_count,
          ceApiCalls: runRes.rows[0].ce_api_calls,
          error: runRes.rows[0].error,
        }
      : null;
    return json({
      enabled: true, findings, lastRun, accountFilter: scoped ? account : null,
      // ec2_rightsizing/rds_rightsizing call Compute Optimizer bound to the host account's own
      // region only (rules.py's `_co_client()` — CO has no cross-account/cross-region query mode
      // this worker uses) — a review round caught that filtering to a DIFFERENT account, or the
      // host account's OTHER regions, silently renders "no waste found" as if rightsizing had
      // been evaluated there, when it was never queried at all. Echo the actually-evaluated scope
      // so the client can tell "confirmed clean" apart from "not evaluated for this view".
      coRightsizingScope: { accountId: 'self', region: process.env.AWS_REGION || 'ap-northeast-2' },
    }, 200);
  } catch (e) {
    return json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, 500);
  }
}
