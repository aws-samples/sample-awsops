'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useActiveAccount, ALL_ACCOUNTS } from '@/lib/account-context';

// ADR-020 FinOps baseline-recommendations engine — self-fetching card (mirrors InsightCard's
// enabled/loaded/empty-state shape). Read-only: no action button here, ever — the ADR's own
// invariant is that this domain adds zero AWS-mutation paths (a card showing an IaC-change EXAMPLE
// as text would be allowed by the ADR, but this version doesn't even do that).
interface Finding {
  id: number; ruleId: string; accountId: string; region: string; resourceId: string; title: string;
  category: string;
  status: 'active' | 'needs_review' | 'resolved';
  monthlySavingsUsd: number | null;
  evidence: Record<string, unknown>;
  guardHits: string[];
  explanationKo: string | null;
  firstSeenAt: string; lastSeenAt: string;
}
interface LastRun {
  id: number; startedAt: string; finishedAt: string | null; status: string;
  rulesEvaluated: number | null; findingsCount: number | null; ceApiCalls: number; error: string | null;
}
interface CoRightsizingScope { accountId: string; region: string }
interface Findings {
  enabled: boolean; findings: Finding[]; lastRun: LastRun | null; accountFilter: string | null;
  coRightsizingScope: CoRightsizingScope;
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  needs_review: 'bg-amber-100 text-amber-700 border-amber-200',
};

function ago(ts: string | null, tt: (s: string) => string): string {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 90) return tt('방금 전');
  if (s < 3600) return tt(`${Math.round(s / 60)}분 전`);
  if (s < 86400) return tt(`${Math.round(s / 3600)}시간 전`);
  return tt(`${Math.round(s / 86400)}일 전`);
}

export default function FinopsBaselineCard() {
  const { tt } = useI18n();
  const [active] = useActiveAccount();
  const [data, setData] = useState<Findings | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Distinct from "no batch has run yet" (data === null with no error) — a failed/non-200 fetch
  // must not silently render as if the feature simply hasn't started, per the repo's honest-
  // degradation convention (the same class of fix the Direct Connect page's degradedRegions work
  // in this same release applies elsewhere).
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    // A stop-time review caught a race here: switching the active account fires a new fetch, but
    // nothing stopped an OLDER, slower request from resolving after the newer one and overwriting
    // the just-selected account's data with a previous (now stale) account's findings. `cancelled`
    // is scoped to THIS effect run — the cleanup flips it before the next run's fetch starts, so a
    // late-arriving response for an account the user has since navigated away from is dropped
    // instead of clobbering the current view.
    let cancelled = false;
    // A stop-time review caught a SEPARATE bug from the stale-response race above: dropping the
    // late response stopped it from being wrongly APPLIED, but did nothing about the previous
    // account's already-applied `data` staying on screen, unlabeled as stale, for the entire
    // window between an account switch and the new fetch resolving — the user could sit looking
    // at account A's findings while account B was selected. Reset to the loading state up front,
    // on every account change (not just mount), so a switch never renders with stale data.
    setLoaded(false);
    setData(null);
    setFetchError(false);
    async function load() {
      try {
        // ebs_unattached spans every synced account/region in one pass, so unlike single-account
        // routes this scoping is a genuine filter, not a fan-out trigger — '전체 계정' omits the
        // account param entirely for the fleet-wide view (each finding still labeled below).
        // NOTE: unlike accountParam()'s '' -> host-defaults-server-side convention used by other
        // routes, the DEFAULT active account here is 'self' and must be sent EXPLICITLY as
        // `account=self` — omitting it would (and, before this fix, did) fall through to the
        // route's "no account param -> fleet-wide" branch, silently showing every account's
        // findings on the default/never-touched-the-selector view instead of just the host's.
        const qs = active === ALL_ACCOUNTS ? '' : `?account=${encodeURIComponent(active || 'self')}`;
        const r = await fetch(`/api/finops/findings${qs}`);
        if (cancelled) return;
        if (r.ok) {
          const body = await r.json();
          if (cancelled) return;
          setData(body);
          setFetchError(false);
        } else {
          setFetchError(true);
        }
      } catch {
        if (!cancelled) setFetchError(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [active]);

  if (loaded && data?.enabled === false) return null; // feature off -> render nothing (no-op)
  const findings = data?.findings ?? [];
  // The headline total is a CONFIDENT number — only 'active' findings count toward it.
  // 'needs_review' items (stale inventory data, a protected tag, insufficient Compute Optimizer
  // observation window) carry a guard hit specifically because their amount/applicability isn't
  // trustworthy yet; summing them into "월간 절감 가능" would inflate a number the guard system
  // itself just flagged as not-yet-actionable. They're still shown in the list below, just not
  // rolled into this total.
  const confident = findings.filter((f) => f.status === 'active');
  // `reduce` with `?? 0` silently coalesces "every confident item happens to have unknown
  // savings" into a total of exactly 0 — indistinguishable from "confirmed zero savings" once
  // rendered as $0.00. Sum only the known amounts, and track unknown separately, so the render
  // below can say "산출 불가" instead of fabricating a $0.00 headline (the same null-not-zero
  // invariant the per-finding amounts already honor, now also at the aggregate level).
  const knownConfident = confident.filter((f) => f.monthlySavingsUsd !== null);
  const total = knownConfident.reduce((s, f) => s + (f.monthlySavingsUsd as number), 0);
  const unknownCount = confident.length - knownConfident.length;

  // ec2_rightsizing/rds_rightsizing only ever evaluate the host account's own Compute-Optimizer
  // region. A review round caught that a cross-account filter rendered "no waste found" as if
  // rightsizing had been checked there; a stop-time review then caught the REMAINING half of the
  // same false-clean path — even the host-account view never disclosed that only ONE region was
  // queried, so a host account with resources in other regions still read as fully clean. The
  // coverage scope is therefore stated unconditionally (the page has no region selector to
  // compare against, so the honest move is to name what was actually evaluated), with a stronger
  // wording when the selected account isn't the evaluated one at all.
  const coScope = data?.coRightsizingScope;
  const rightsizingUnevaluatedForThisScope =
    !!data?.accountFilter && !!coScope && data.accountFilter !== coScope.accountId;

  return (
    <section className="rounded-xl border border-ink-200 bg-card p-4" data-testid="finops-baseline-card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold text-ink-800">{tt('FinOps 기본 권장')}</h2>
          {data?.lastRun?.finishedAt && (
            <span className="text-[12px] text-ink-400">
              {tt('배치 기준')} {ago(data.lastRun.finishedAt, tt)}
            </span>
          )}
        </div>
        {confident.length > 0 && (
          <span className="text-[13px] font-medium text-ink-700" data-testid="finops-baseline-total">
            {knownConfident.length > 0 ? (
              <>
                {tt('월간 절감 가능')} {usd(total)}
                {unknownCount > 0 && (
                  <span className="text-ink-400"> {tt(`(+${unknownCount}건 금액 산출 불가)`)}</span>
                )}
              </>
            ) : (
              // Every confident finding has an unknown amount — no known total to show at all.
              // Saying "산출 불가" (not $0.00) keeps the null-not-zero invariant at this level too.
              <>{tt('월간 절감 가능')}: {tt('금액 산출 불가')}</>
            )}
          </span>
        )}
      </div>
      {rightsizingUnevaluatedForThisScope ? (
        <p className="text-[11px] text-amber-600 mb-2" data-testid="finops-baseline-rightsizing-unevaluated">
          {tt('EC2/RDS 리사이징은 호스트 계정의 Compute Optimizer 리전만 평가합니다 — 이 계정에서는 평가되지 않았습니다.')}
        </p>
      ) : coScope ? (
        <p className="text-[11px] text-ink-400 mb-2" data-testid="finops-baseline-rightsizing-scope">
          {tt('EC2/RDS 리사이징 평가 범위')}: {coScope.accountId === 'self' ? tt('호스트 계정') : coScope.accountId} · {coScope.region}
          {' '}({tt('다른 리전은 평가되지 않았습니다')})
        </p>
      ) : null}
      {!loaded ? (
        <p className="text-[13px] text-ink-400">{tt('로딩 중…')}</p>
      ) : fetchError ? (
        <p className="text-[13px] text-rose-600" data-testid="finops-baseline-fetch-error">
          {tt('데이터를 불러올 수 없습니다 — 잠시 후 다시 시도해주세요.')}
        </p>
      ) : data?.lastRun?.status === 'failed' ? (
        <p className="text-[13px] text-rose-600" data-testid="finops-baseline-error">
          {tt('최근 배치 실행이 실패했습니다')}{data.lastRun.error ? `: ${data.lastRun.error}` : ''}
        </p>
      ) : data?.lastRun?.status === 'running' && findings.length === 0 ? (
        // A review round caught that a `running` last-run (the row engine.run() inserts BEFORE
        // evaluating anything) with no prior findings fell through to the "no waste found" clean
        // empty-state below — a batch that's still executing (or, if Fargate was OOM-killed
        // mid-run, one that died stuck in `running` forever, since the reaper reconciles
        // worker_jobs, not finops_runs) must never look like a confirmed-clean result.
        <p className="text-[13px] text-ink-400" data-testid="finops-baseline-running">
          {tt('배치가 실행 중입니다 — 잠시 후 다시 확인해주세요.')}
        </p>
      ) : findings.length === 0 ? (
        <p className="text-[13px] text-ink-400" data-testid="finops-baseline-empty">
          {!data?.lastRun
            ? tt('아직 배치가 실행되지 않았습니다 — 다음 일일 배치를 기다려주세요.')
            : data.lastRun.status === 'partial'
            ? tt('일부 룰이 실패해 결과가 불완전합니다 — 표시된 항목 외에 추가 낭비가 있을 수 있습니다.')
            : tt('현재 발견된 상시 낭비 항목이 없습니다.')}
        </p>
      ) : (
        <>
          {data?.lastRun?.status === 'partial' && (
            // Findings DO exist, but the run didn't evaluate the full catalog — a rule failed
            // (e.g. a Compute Optimizer permission error, or ebs_unattached itself raising when
            // steampipe_enabled=false) and engine.py correctly left that rule's PRIOR findings
            // untouched rather than resolving them. What's shown below is real, just incomplete.
            <p className="text-[12px] text-amber-600 mb-2" data-testid="finops-baseline-partial">
              {tt('일부 룰이 이번 배치에서 실패했습니다 — 아래 목록은 불완전할 수 있습니다.')}
            </p>
          )}
          <ul className="flex flex-col gap-2">
          {findings.map((f) => (
            <li key={f.id} className="flex items-start gap-2" data-testid="finops-baseline-item">
              <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${STATUS_BADGE[f.status] || STATUS_BADGE.active}`}>
                {tt(f.status === 'needs_review' ? '확인 필요' : '활성')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13px] font-medium text-ink-800">{f.title}</p>
                  <p className="text-[13px] font-medium text-ink-700 shrink-0">
                    {f.monthlySavingsUsd === null ? tt('금액 산출 불가') : `${usd(f.monthlySavingsUsd)}/mo`}
                  </p>
                </div>
                {!data?.accountFilter && (
                  // Fleet-wide view (no account selected, or '전체 계정') — label the scope per
                  // finding so a cross-account/region total is never mistaken for a single-account
                  // one (a review round caught the card summing accounts B/C into a total shown
                  // while account A was selected, with no way to tell).
                  <p className="text-[11px] text-ink-400">
                    {f.accountId === 'self' ? tt('호스트 계정') : f.accountId} · {f.region || tt('알 수 없음')}
                  </p>
                )}
                {f.explanationKo && <p className="text-[12px] text-ink-500">{f.explanationKo}</p>}
                {f.guardHits.length > 0 && (
                  <p className="text-[11px] text-amber-600">{tt('주의')}: {f.guardHits.join(', ')}</p>
                )}
              </div>
            </li>
          ))}
          </ul>
        </>
      )}
    </section>
  );
}
