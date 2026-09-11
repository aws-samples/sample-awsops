'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import SectionLabel from '@/components/ui/SectionLabel';
import StatTile from '@/components/ui/StatTile';
import Card from '@/components/ui/Card';
import StatePill from '@/components/ui/StatePill';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useActiveScope, scopeParams } from '@/lib/account-context';

// ECS unified overview (gap L216, v1 parity): summary KPI + clusters table + services table on
// ONE screen. Read-only glance layer — search/facets/detail stay on the per-type pages (linked
// from each table header); this page deliberately does not wire DetailPanel.
// Honesty contract (repo conventions):
// - a >=500-row page is a SAMPLE: tables carry `(표본 기준)` and the service-task rollup tiles
//   are suppressed (a sample sum must not read as a fleet-wide truth);
// - each type's last sync-run status rides the existing {rows, run} API contract — a
//   non-succeeded run renders a stale-data caption on that table;
// - pre-sync (no rows AND no run) reads "미수집", never a fabricated empty fleet.

const ROW_CAP = 500;

type Run = { status?: string; finished_at?: string | null; last_success_at?: string | null } | null;
type Row = { resource_id: string; region: string; account_id: string; data?: Record<string, unknown> };
interface TypeState { rows: Row[]; run: Run; err: boolean; loaded: boolean }

const EMPTY: TypeState = { rows: [], run: null, err: false, loaded: false };

function d(r: Row, key: string): unknown { return r.data?.[key]; }
function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0; }
/** Cluster display name from an ECS cluster ARN ("arn:...:cluster/name" → "name"). */
export function clusterLeaf(arn: unknown): string {
  const s = String(arn ?? '');
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s || '—';
}

export default function EcsOverview() {
  const { tt } = useI18n();
  const [clusters, setClusters] = useState<TypeState>(EMPTY);
  const [services, setServices] = useState<TypeState>(EMPTY);
  const [taskCount, setTaskCount] = useState<number | null>(null);
  const [taskRun, setTaskRun] = useState<Run>(null);
  const [taskLoaded, setTaskLoaded] = useState(false);
  const [taskErr, setTaskErr] = useState(false);
  const [busy, setBusy] = useState(false);
  // Global account/region scope (round-1 review): the type pages scope BOTH the rows and the
  // summary fetches — this page must describe the same fleet its '전체 보기' links open, and
  // must reload on scope change.
  const [scope] = useActiveScope();

  // A scope change re-fires load; the seq guard drops a slower earlier response so it can't
  // overwrite the newer scope's data (round-2 review — the base page's alive-flag pattern).
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const fresh = () => seq === loadSeq.current;
    setBusy(true);
    // Reset to the loading state so a scope change never shows the PREVIOUS scope's fleet
    // (or a briefly mixed-scope view while the three fetches commit independently) (round-3).
    setClusters(EMPTY);
    setServices(EMPTY);
    setTaskCount(null);
    setTaskRun(null);
    setTaskLoaded(false);
    setTaskErr(false);
    const fetchType = async (type: string, set: (s: TypeState) => void) => {
      try {
        // cost=0: the overview never renders mtd_cost_usd — skip the billable CE merge
        const costParam = type === 'ecs_cluster' ? '&cost=0' : '';
        const r = await fetch(`/api/inventory/${type}?limit=${ROW_CAP}${costParam}&${scopeParams(scope)}`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (fresh()) set({ rows: j.rows ?? [], run: j.run ?? null, err: false, loaded: true });
      } catch {
        if (fresh()) set({ ...EMPTY, err: true, loaded: true });
      }
    };
    await Promise.allSettled([
      fetchType('ecs_cluster', setClusters),
      fetchType('ecs_service', setServices),
      // Task COUNT from the shared summary + the ecs_task RUN ledger (limit=1 — the count
      // comes from the summary, the run gates freshness). byType absence is ambiguous
      // (never-synced AND a genuinely empty fleet are both absent from a GROUP BY), so the
      // run status disambiguates: succeeded + absent = a TRUE 0; anything else = '—'.
      Promise.all([
        fetch(`/api/inventory/summary?${scopeParams(scope)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
        fetch(`/api/inventory/ecs_task?limit=1&${scopeParams(scope)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
      ])
        .then(([sum, task]) => {
          if (!fresh()) return;
          const hit = (sum.byType ?? []).find((x: { type: string }) => x.type === 'ecs_task');
          setTaskCount(hit ? Number(hit.count) : null);
          setTaskRun(task.run ?? null);
          setTaskLoaded(true);
        })
        .catch(() => {
          if (!fresh()) return;
          setTaskCount(null);
          setTaskRun(null);
          setTaskLoaded(true);
          setTaskErr(true); // an unexplained '—' is not honest — the tile says load failed
        }),
    ]);
    if (fresh()) setBusy(false);
  }, [scope]);
  useEffect(() => { load(); }, [load]);

  const cTrunc = clusters.rows.length >= ROW_CAP;
  const sTrunc = services.rows.length >= ROW_CAP;
  // Service-health rollup: only from a LOADED, UNTRUNCATED page whose last run SUCCEEDED —
  // a 500-row sample sum must not present itself as the fleet total, and mid-refresh/stale
  // rows under a running/partial/failed run must not emit a confident deficit (round-2).
  // A succeeded run with zero services is a TRUE zero (the fleet genuinely has none).
  // The deficit is PER-SERVICE Σ max(0, desired − running): running can legitimately exceed
  // desired mid-deployment (maximumPercent 200), and a surplus must never cancel another
  // service's shortfall (round-1). Rows whose desired/running fields are absent are skipped
  // from the deficit (their cells honestly render '—' — an unknown must not inflate the number).
  const rollup = services.loaded && !services.err && !sTrunc && services.run?.status === 'succeeded'
    ? services.rows.reduce(
        (a, r) => {
          const desired = d(r, 'desired_count');
          const running = d(r, 'running_count');
          if (typeof desired === 'number' && typeof running === 'number') {
            a.desired += desired;
            a.running += running;
            a.deficit += Math.max(0, desired - running);
          }
          return a;
        },
        { desired: 0, running: 0, deficit: 0 },
      )
    : null;
  const lagging = rollup ? rollup.deficit : null;

  // Header freshness = the DATA time per the S3IamAccessSection convention:
  // last_success_at ?? (succeeded ? finished_at : null) — finished_at alone is merely the
  // last ATTEMPT (failed/partial runs stamp it too, sync_lambda's finalizer). The header
  // takes the OLDER of the two tables' data times so a fresh cluster sync can't mask stale
  // service data; no data time on either → 미수집 (round-2 review).
  const dataTime = (run: Run): number | null => {
    const t = run?.last_success_at ?? (run?.status === 'succeeded' ? run?.finished_at : null);
    return t ? new Date(t).getTime() : null;
  };
  // The task run's data time joins the min whenever the Tasks KPI actually shows a count —
  // a stale-but-succeeded task sync must not ride under a fresher header time (round-3).
  const shownTimes: (number | null)[] = [dataTime(clusters.run), dataTime(services.run)];
  const taskShown = taskLoaded && taskRun?.status === 'succeeded';
  if (taskShown) shownTimes.push(dataTime(taskRun));
  const capturedAt = shownTimes.every((x): x is number => x != null)
    ? new Date(Math.min(...(shownTimes as number[]))).toISOString()
    : null;

  const preSync = (t: TypeState) => t.loaded && !t.err && t.rows.length === 0 && t.run == null;
  // Non-succeeded runs are distinguished (round-1): 'failed' asserts failure, 'running'/'partial'
  // say what they are, and a MISSING ledger row with rows present says freshness is unverifiable.
  const runCaption = (t: TypeState): { text: string; tone: 'warn' | 'muted' } | null => {
    if (!t.loaded || t.err) return null;
    if (t.run == null) {
      return t.rows.length > 0
        ? { text: 'sync 이력 정보가 없어 아래 목록의 최신 여부를 확인할 수 없습니다.', tone: 'warn' }
        : null; // rows empty + no run = the preSync caption below
    }
    if (t.run.status === 'succeeded') return null;
    if (t.run.status === 'running') return { text: 'sync 실행 중 — 목록이 곧 갱신됩니다.', tone: 'muted' };
    if (t.run.status === 'partial') return { text: '부분 수집 — 일부 계정의 데이터가 오래되었을 수 있습니다.', tone: 'warn' };
    return { text: '마지막 sync가 성공하지 못했습니다 — 마지막 성공 시점 데이터일 수 있습니다.', tone: 'warn' };
  };
  const caption = (t: TypeState, trunc: boolean) => {
    const rc = runCaption(t);
    return (
      <>
        {t.err && <span className="text-amber-700">{tt('목록을 불러오지 못했습니다.')}</span>}
        {rc && <span className={rc.tone === 'warn' ? 'text-amber-700' : undefined}>{tt(rc.text)}</span>}
        {!t.err && preSync(t) && <span>{tt('미수집 — sync 후 표시됩니다.')}</span>}
        {trunc && <span> ({tt('표본 기준')})</span>}
      </>
    );
  };

  const th = 'px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-400';
  const td = 'px-3 py-1.5 text-[12px] text-ink-700';

  return (
    <>
      <PageHeader
        title={tt('ECS 개요')}
        subtitle={tt('클러스터·서비스·태스크 통합 현황')}
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {/* KPI band */}
        <section className="flex flex-col gap-3">
          <SectionLabel>{tt('요약')}</SectionLabel>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* pre-sync (empty rows + no ledger row) reads '—', never a confident 0 (round-2) */}
            <StatTile label={tt('클러스터')} value={clusters.loaded && !clusters.err && !preSync(clusters) ? clusters.rows.length + (cTrunc ? '+' : '') : '—'} href="/inventory/ecs_cluster" />
            <StatTile label={tt('서비스')} value={services.loaded && !services.err && !preSync(services) ? services.rows.length + (sTrunc ? '+' : '') : '—'} href="/inventory/ecs_service" />
            {/* the count rides the summary; the ecs_task RUN gates its trustworthiness —
                succeeded + byType-absent is a TRUE 0, anything non-succeeded reads '—' */}
            <StatTile
              label={tt('태스크')}
              value={taskLoaded && taskRun?.status === 'succeeded' ? (taskCount ?? 0) : '—'}
              href="/inventory/ecs_task"
              hint={taskErr
                ? tt('불러오기 실패')
                : taskLoaded && taskRun != null && taskRun.status !== 'succeeded'
                  ? tt(taskRun.status === 'running' ? 'sync 실행 중' : '마지막 sync 미성공 — 확정 수치 아님')
                  : undefined}
            />
            <StatTile
              label={tt('Desired 대비 미달 태스크')}
              value={lagging == null ? '—' : lagging}
              variant={lagging != null && lagging > 0 ? 'danger' : 'default'}
              hint={rollup
                ? `${rollup.running}/${rollup.desired} running`
                : sTrunc
                  ? tt('표본에서는 집계하지 않음')
                  : services.loaded && !services.err && services.run != null && services.run.status !== 'succeeded'
                    ? tt('동기화 상태 미확정 — 집계 보류')
                    : undefined}
            />
          </div>
        </section>

        {/* Clusters table */}
        <section className="flex flex-col gap-3">
          <SectionLabel right={<Link href="/inventory/ecs_cluster" className="text-[11.5px] text-brand-700 hover:underline">{tt('전체 보기')} →</Link>}>
            {tt('클러스터')}
          </SectionLabel>
          <Card padded={false}>
            <p className="px-3 pt-2 text-[11px] text-ink-400">{caption(clusters, cTrunc)}</p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr className="border-b border-ink-100">
                  <th className={th}>Name</th><th className={th}>Status</th><th className={th}>Running</th>
                  <th className={th}>Pending</th><th className={th}>Services</th><th className={th}>Region</th>
                </tr></thead>
                <tbody>
                  {clusters.rows.map((r) => (
                    <tr key={`${r.account_id}/${r.region}/${r.resource_id}`} className="border-b border-ink-50 last:border-0">
                      <td className={`${td} font-mono`}>{r.resource_id}</td>
                      <td className={td}><StatePill value={String(d(r, 'status') ?? '—')} /></td>
                      <td className={`${td} tabular`}>{String(d(r, 'running_tasks_count') ?? '—')}</td>
                      <td className={`${td} tabular`}>{String(d(r, 'pending_tasks_count') ?? '—')}</td>
                      <td className={`${td} tabular`}>{String(d(r, 'active_services_count') ?? '—')}</td>
                      <td className={td}>{r.region}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>

        {/* Services table */}
        <section className="flex flex-col gap-3">
          <SectionLabel right={<Link href="/inventory/ecs_service" className="text-[11.5px] text-brand-700 hover:underline">{tt('전체 보기')} →</Link>}>
            {tt('서비스')}
          </SectionLabel>
          <Card padded={false}>
            <p className="px-3 pt-2 text-[11px] text-ink-400">{caption(services, sTrunc)}</p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr className="border-b border-ink-100">
                  <th className={th}>Service</th><th className={th}>Cluster</th><th className={th}>Status</th>
                  <th className={th}>Desired</th><th className={th}>Running</th><th className={th}>Launch</th><th className={th}>Region</th>
                </tr></thead>
                <tbody>
                  {services.rows.map((r) => {
                    const desired = num(d(r, 'desired_count'));
                    const running = num(d(r, 'running_count'));
                    return (
                      <tr key={`${r.account_id}/${r.region}/${r.resource_id}`} className="border-b border-ink-50 last:border-0">
                        <td className={`${td} font-mono`}>{String(d(r, 'service_name') ?? r.resource_id)}</td>
                        <td className={td}>{clusterLeaf(d(r, 'cluster_arn'))}</td>
                        <td className={td}><StatePill value={String(d(r, 'status') ?? '—')} /></td>
                        <td className={`${td} tabular`}>{String(d(r, 'desired_count') ?? '—')}</td>
                        <td className={`${td} tabular ${running < desired ? 'text-rose-600 font-semibold' : ''}`}>{String(d(r, 'running_count') ?? '—')}</td>
                        <td className={td}>{String(d(r, 'launch_type') ?? '—')}</td>
                        <td className={td}>{r.region}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      </div>
    </>
  );
}
