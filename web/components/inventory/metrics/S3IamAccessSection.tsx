'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';

// 'IAM Roles with S3 Access' (gap L242, v1 parity): roles whose SYNCED attached AWS-managed
// policies MATCH the checked set (AmazonS3*/AdministratorAccess/PowerUserAccess/
// ReadOnlyAccess, incl. job-function paths; partition-tolerant anchor), max 30 (v1's cap).
// The empty state uses MATCHED-SET framing — other managed policies can also grant S3, so
// 'no role has S3 access' is never claimed. Reads the EXISTING /api/inventory/iam_role route — an
// ADMIN-ONLY type: non-admins get a distinct permission note. Honest bounds:
// - the LAST SYNC RUN's status gates every conclusion — a failed/partial run renders a
//   stale-data banner, a MISSING ledger row renders an unverifiable-freshness note, and the
//   empty state is never conclusive. A failed hydrate no longer fails the whole run: the sync
//   retries hydrate-free (the base inventory stays live) and this section sees the absent
//   column as "not synced yet" — the ADR-010 2026-09-02 amendment's disclosed degrade;
//   whole-type last-good freeze remains only when the base query also fails;
// - a full page (fetched cap+1) is labeled sampled and its empty state is non-conclusive;
// - pre-sync rows (column absent) render "not synced yet"; a succeeded run with zero rows
//   renders "no roles exist" (a different truth). Named export per the metrics convention.

const MAX_ROLES = 30;
const ROW_CAP = 500; // the route's hard limit; we request cap and treat rows.length >= cap as sampled
// AWS-managed policies only (anchored — a customer policy NAMED AmazonS3Deny... could be
// deny-only). Covers the plain and job-function paths.
const S3_POLICY_RE = /^arn:aws[a-z-]*:iam::aws:policy\/(job-function\/)?(AmazonS3[A-Za-z]*|AdministratorAccess|PowerUserAccess|ReadOnlyAccess)$/;

type RoleHit = { name: string; policies: string[] };
type Run = { status?: string; finished_at?: string | null; last_success_at?: string | null } | null;

export function s3AccessRoles(rows: Record<string, unknown>[]): { hits: RoleHit[]; anySynced: boolean } {
  const hits: RoleHit[] = [];
  let anySynced = false;
  for (const r of rows) {
    const arns = Array.isArray(r.attached_policy_arns) ? r.attached_policy_arns.map(String) : null;
    if (arns === null) continue; // column not synced on this row
    anySynced = true;
    const matched = arns.filter((a) => S3_POLICY_RE.test(a));
    if (matched.length) hits.push({ name: String(r.resource_id ?? r.name ?? ''), policies: matched.map((a) => a.split('/').pop() ?? a) });
  }
  return { hits: hits.slice(0, MAX_ROLES), anySynced };
}

export function S3IamAccessSection({ accountId }: { accountId?: string }) {
  const { tt } = useI18n();
  const [state, setState] = useState<{
    loading: boolean; err: boolean; forbidden: boolean; truncated: boolean;
    hits: RoleHit[]; anySynced: boolean; empty: boolean; run: Run;
  }>({ loading: true, err: false, forbidden: false, truncated: false, hits: [], anySynced: false, empty: false, run: null });

  useEffect(() => {
    let alive = true;
    // s3 rows are host-collected (SDK collector) and carry no account_id today, so accountId
    // is normally absent (→ the route's 'self' default = exactly where host iam_role rows
    // live). CAUTION for a future s3 sync that stamps the raw host 12-digit id: the generic
    // inventory route has NO host-id→'self' normalization (only security_group/inbound and
    // ebs_volume/related do), so map it to 'self' here before threading.
    const scope = accountId ? `&accounts=${encodeURIComponent(accountId)}` : '';
    fetch(`/api/inventory/iam_role?limit=${ROW_CAP}${scope}`)
      .then((r) => {
        if (r.status === 403) return Promise.reject(new Error('forbidden'));
        return r.ok ? r.json() : Promise.reject(new Error(String(r.status)));
      })
      .then((d) => {
        if (!alive) return;
        const raw = (d.rows ?? []) as { resource_id: string; data?: Record<string, unknown> }[];
        const rows = raw.map((x) => ({ resource_id: x.resource_id, ...(x.data ?? {}) }));
        const run = (d.run ?? null) as Run;
        setState({
          loading: false, err: false, forbidden: false,
          truncated: raw.length >= ROW_CAP,
          empty: raw.length === 0,
          run,
          ...s3AccessRoles(rows),
        });
      })
      .catch((e) => {
        if (!alive) return;
        setState({ loading: false, err: true, forbidden: e instanceof Error && e.message === 'forbidden', truncated: false, hits: [], anySynced: false, empty: false, run: null });
      });
    return () => { alive = false; };
  }, [accountId]);

  const degraded = state.run != null && state.run.status !== 'succeeded';
  // freshness bound (round-5 gate) on the DATA time: last_success_at is when the listed
  // rows were actually captured (finished_at is merely the last ATTEMPT — a failed run
  // stamps it too). Conclusive requires succeeded + data within 24h.
  const FRESH_MS = 24 * 3600_000;
  const dataAsOf = state.run?.last_success_at ?? (state.run?.status === 'succeeded' ? state.run?.finished_at : null);
  const fresh = state.run?.status === 'succeeded' && !!dataAsOf
    && Date.now() - new Date(dataAsOf).getTime() < FRESH_MS;
  const heading = (
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
      {tt('S3 접근 권한 보유 IAM Role')}{state.truncated ? ` (${tt('표본 기준')})` : ''}
    </div>
  );
  const staleBanner = degraded ? (
    <p className="mb-1.5 text-[11.5px] text-amber-700">
      {tt('마지막 iam_role sync가 성공하지 못했습니다 — 아래 목록은 마지막 성공 시점의 데이터일 수 있습니다.')}
      {dataAsOf ? ` (${tt('기준:')} ${new Date(dataAsOf).toLocaleString()})` : ''}
    </p>
  ) : null;
  // run:null with matches (a missing ledger row, e.g. pre-ADR-021 data): the list must not
  // render as implicitly current — freshness is unverifiable, say so
  const noLedgerNote = !state.loading && !state.err && state.run == null ? (
    <p className="mb-1.5 text-[11.5px] text-amber-700">
      {tt('sync 이력 정보가 없어 아래 목록의 최신 여부를 확인할 수 없습니다.')}
    </p>
  ) : null;

  if (state.loading) return <>{heading}<p className="text-[12px] text-ink-400">{tt('로딩 중…')}</p></>;
  if (state.forbidden) {
    return <>{heading}<p className="text-[12px] text-ink-400">{tt('관리자 전용 데이터입니다 (iam_role 인벤토리 조회 권한 필요).')}</p></>;
  }
  if (state.err) return <>{heading}<p className="text-[12px] text-amber-700">{tt('IAM Role 목록을 불러오지 못했습니다.')}</p></>;
  if (state.empty) {
    // rows: [] — conclusive 'no roles exist' needs the SAME fresh-succeeded gate as the
    // zero-hits branch (a months-old succeeded run must not render a current-tense all-clear)
    return <>{heading}{staleBanner}<p className="text-[12px] text-ink-400">{fresh ? tt('동기화된 IAM role이 없습니다.') : tt('IAM role 데이터가 아직 없습니다 — sync 상태를 확인하세요.')}</p></>;
  }
  if (!state.anySynced) {
    return <>{heading}{staleBanner}<p className="text-[12px] text-ink-400">{tt('연결 정책 목록이 아직 동기화되지 않았습니다 — 다음 sync 이후 표시됩니다.')}</p></>;
  }
  if (state.hits.length === 0) {
    // conclusive requires a SUCCEEDED, untruncated run — run:null (no ledger row, e.g.
    // pre-ADR-021 data) is NOT healthy enough for an all-clear
    const conclusive = !state.truncated && fresh;
    // the conclusive all-clear carries its data-as-of time too (the CHANGELOG-promised
    // footer must not exist only on the hits path)
    return <>{heading}{staleBanner}<p className="text-[12px] text-ink-400">{conclusive ? tt('검사 대상 관리형 정책(AmazonS3*/Admin/PowerUser/ReadOnly)에 일치하는 role이 없습니다 — 다른 정책 경유 S3 접근은 별도 확인 필요.') : tt('표본/마지막 성공 데이터 내 일치하는 role이 없습니다 — 확정 아님.')}{dataAsOf ? ` (${tt('기준:')} ${new Date(dataAsOf).toLocaleString()})` : ''}</p></>;
  }
  return (
    <>
      {heading}
      {staleBanner}
      {noLedgerNote}
      <ul className="flex flex-col gap-1">
        {state.hits.map((h) => (
          <li key={h.name} className="flex items-center justify-between gap-2 text-[12px]">
            <span className="min-w-0 truncate font-mono text-ink-700">{h.name}</span>
            <span className="shrink-0 text-[10.5px] text-ink-400">{h.policies.join(' · ')}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[10.5px] text-ink-400">{tt('AWS 관리형 정책 기준 (인라인 정책·버킷 정책 경유 접근은 미포함) · 최대 30개')}{dataAsOf ? ` · ${tt('기준:')} ${new Date(dataAsOf).toLocaleString()}` : ''}</p>
    </>
  );
}

export default S3IamAccessSection;
