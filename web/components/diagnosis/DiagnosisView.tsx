'use client';
import { useEffect, useState, useCallback } from 'react';
import SchedulePanel from './SchedulePanel';
import SubscribersPanel from './SubscribersPanel';
import ReportSections from './ReportSections';
import IntentPanel from './IntentPanel';
import { useI18n } from '@/components/shell/LanguageProvider';
import { localeOf } from '@/lib/i18n';
import { sectionsForTier, titleMatches, localizedTitle } from '@/lib/diagnosis-sections';
import { CheckCircle } from 'lucide-react';

interface DiagnosisProgress {
  current?: number;
  total?: number;
  section?: string;
  phase?: 'collect' | 'render' | 'assemble';
  // L177: finished-section titles in COMPLETION order (concurrent render ≠ catalog order).
  completed?: string[];
}

interface ReportRow {
  id: number;
  tier: string;
  status: string;
  created_at: string;
  finished_at?: string | null;  // L176: drives the completed-report elapsed stat
  model?: string | null;        // deep-tier model (sonnet|opus); shown in the list for deep reports
  account?: string | null;      // diagnosed account id (from the job payload; null on legacy rows)
  title?: string | null;        // LLM auto key-insight title (editable)
  tags?: string[];              // auto-suggested + manual
  can_edit?: boolean;           // owner or admin (BFF-computed) → show edit/delete controls
  error?: string | null;       // A6: surface failed reports (was hidden → looked stuck)
  progress?: DiagnosisProgress; // A3/A6: live per-section progress
}

// Plan-2: intended-vs-actual verdict surfaced in summary.drift; regression diff in summary.diff.
interface DriftVerdict {
  id?: number | string;
  kind?: string;
  target?: string | null;
  severity?: string;
  observed?: string;
}
interface ReportSummary {
  drift?: DriftVerdict[];
  diff?: { regressions?: DriftVerdict[]; improvements?: (number | string)[] };
  [k: string]: unknown;
}

const SEV_CLASS: Record<string, string> = {
  critical: 'border-red-200 bg-red-50 text-red-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  info: 'border-ink-200 bg-ink-100 text-ink-600',
};

// Safe date formatting — tests (and legacy rows) may carry an unparseable value; fall back to raw.
function fmtDate(ds: string | undefined, locale: string) {
  if (!ds) return '';
  const d = new Date(ds);
  return isNaN(d.getTime()) ? ds : d.toLocaleString(locale);
}
function fmtDay(ds: string | undefined, locale: string) {
  if (!ds) return '';
  const d = new Date(ds);
  return isNaN(d.getTime()) ? ds : d.toLocaleDateString(locale);
}

export default function DiagnosisView() {
  const { tt, lang } = useI18n();
  const locale = localeOf(lang);
  const [tier, setTier] = useState<'light' | 'mid' | 'deep'>('mid');
  const [model, setModel] = useState<'sonnet' | 'opus'>('sonnet'); // deep-tier model choice
  // Report output language (gap L50) — defaults to the current UI language (all 4 are supported).
  // The provider hydrates `lang` from localStorage AFTER mount, so keep syncing until the user
  // explicitly picks a language (their choice then wins).
  const [reportLang, setReportLang] = useState<'ko' | 'en' | 'zh' | 'ja'>('ko');
  const [reportLangTouched, setReportLangTouched] = useState(false);
  useEffect(() => {
    if (reportLangTouched) return;
    setReportLang((['ko', 'en', 'zh', 'ja'] as const).includes(lang as 'ko') ? (lang as 'ko') : 'ko');
  }, [lang, reportLangTouched]);

  const [reports, setReports] = useState<ReportRow[]>([]);
  const [active, setActive] = useState<{ id: number; markdown: string | null; summary: ReportSummary | null; status?: string; error?: string | null; progress?: DiagnosisProgress; title?: string | null; tags?: string[]; can_edit?: boolean; tier?: string; created_at?: string; finished_at?: string | null } | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null); // non-null while editing the title
  const [tagDraft, setTagDraft] = useState('');
  const [submitting, setSubmitting] = useState(false); // brief: the POST round-trip only
  const [pollTicks, setPollTicks] = useState(0);        // # of 3s polls a running report has survived
  const [notice, setNotice] = useState<string | null>(null); // [PR#37 review] surface deduped reports
  const [deepLinkId, setDeepLinkId] = useState<number | null>(null); // honoring an emailed ?report= link

  const POLL_MS = 3000;
  const LONG_AFTER = 40; // ~2min → show a "taking longer than usual" hint (reaper fails truly-stale rows)

  const loadList = useCallback(async () => {
    const r = await fetch('/api/diagnosis');
    if (r.ok) setReports((await r.json()).reports);
  }, []);

  const open = useCallback(async (id: number) => {
    const r = await fetch(`/api/diagnosis/${id}`);
    if (r.ok) {
      const j = await r.json();
      setActive({
        id, markdown: j.markdown, summary: (j.report?.summary as ReportSummary) ?? null,
        status: j.report?.status, error: j.report?.error ?? null, progress: j.report?.progress,
        title: j.report?.title ?? null, tags: j.report?.tags ?? [], can_edit: j.report?.can_edit ?? false,
        // carried from the report row so the stats bar/grid work for reports outside the
        // 50-row list (deep links) — the list row is only a fallback.
        tier: j.report?.tier, created_at: j.report?.created_at, finished_at: j.report?.finished_at ?? null,
      });
    }
  }, []);

  // Soft-delete a report (owner/admin). Confirm → DELETE → reload; clear the pane if it was open.
  const del = useCallback(async (id: number) => {
    if (!window.confirm(tt('이 리포트를 삭제할까요? (목록에서 숨겨집니다)'))) return;
    const r = await fetch(`/api/diagnosis/${id}`, { method: 'DELETE' });
    if (r.ok) {
      setActive((a) => (a?.id === id ? null : a));
      await loadList();
    }
  }, [loadList]);

  // Persist title/tags (owner/admin) and reflect locally + in the list.
  const patchMeta = useCallback(async (id: number, meta: { title?: string | null; tags?: string[] }) => {
    const r = await fetch(`/api/diagnosis/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta),
    });
    if (r.ok) {
      setActive((a) => (a && a.id === id ? { ...a, ...meta } : a));
      await loadList();
    }
  }, [loadList]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Deep link: /ai-diagnosis?report=ID (scheduled-report emails link here) auto-opens that report.
  // open(id) is async, so we set deepLinkId synchronously to suppress the newest-report auto-open below
  // until this resolves — otherwise loadList() could populate `top` and hijack the emailed target. On
  // failure (bad/deleted id), deepLinkId clears → the newest-report fallback resumes. Runs once on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = new URLSearchParams(window.location.search).get('report');
    if (raw && /^\d+$/.test(raw)) {
      const id = Number(raw);
      setDeepLinkId(id);
      Promise.resolve(open(id)).finally(() => setDeepLinkId(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const top = reports[0];
  const topRunning = top?.status === 'running';

  // Single poll loop: while the newest report is running, refresh the list every 3s. update_progress
  // advances it; the reaper fails it if the worker dies → it ALWAYS reaches a terminal state, so this
  // never loops forever (replaces the old inline 3s×100 loop that gave up silently).
  useEffect(() => {
    if (!topRunning) return;
    const t = setTimeout(() => { loadList(); setPollTicks((c) => c + 1); }, POLL_MS);
    return () => clearTimeout(t);
  }, [topRunning, reports, loadList]);

  // Auto-open the newest report once it finishes (or on first load) when the user isn't already
  // viewing something — mirrors V1 showing the latest report. Failed rows render the failed panel
  // from `view` (no markdown to open).
  useEffect(() => {
    // Suppress the newest-report auto-open while an emailed deep link is still being honored.
    const deepLinkPending = deepLinkId !== null && !active;
    if (!deepLinkPending && top && (top.status === 'succeeded' || top.status === 'partial') && active?.id !== top.id && !active) {
      open(top.id);
    }
    if (top && top.status !== 'running') setPollTicks(0);
  }, [top, active, open, deepLinkId]);

  const run = async () => {
    setSubmitting(true);
    setNotice(null);
    try {
      const r = await fetch('/api/diagnosis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tier === 'deep'
          ? { tier, model, lang: reportLang } : { tier, lang: reportLang }),
      });
      if (!r.ok) return;
      const posted = await r.json();
      // [PR#37 review MAJOR] a same-hour re-run is deduped server-side → open the existing report
      // and tell the user (it can be up to ~60min old) instead of silently showing a stale view.
      if (posted?.deduped && posted?.report_id) {
        setNotice(tt('최근 1시간 내 동일 조건 리포트를 표시합니다 (중복 실행 방지 — 최대 60분 이전 결과일 수 있음).'));
        await loadList();
        await open(posted.report_id);
        return;
      }
      setActive(null);  // clear any opened report so the new running one shows its progress
      await loadList(); // the poll effect takes over while the new report is 'running'
    } finally {
      setSubmitting(false);
    }
  };

  // What the main pane shows: an opened report, else the newest report's live state.
  const view = active ?? (top
    ? { id: top.id, markdown: null as string | null, summary: null as ReportSummary | null,
        status: top.status, error: top.error, progress: top.progress,
        title: top.title ?? null, tags: top.tags ?? [], can_edit: top.can_edit ?? false }
    : null);
  const running = submitting || topRunning;

  // Generation date of the opened report (the view object omits created_at → look it up on the row).
  const createdAt = reports.find((r) => r.id === view?.id)?.created_at;

  return (
    <div className="flex gap-6">
      <aside className="w-64 shrink-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={tt('진단 티어')}
            value={tier}
            onChange={(e) => setTier(e.target.value as 'light' | 'mid' | 'deep')}
            className="rounded-md border border-ink-200 bg-card px-2 py-1 text-sm text-ink-700"
          >
            <option value="light">Light</option>
            <option value="mid">Mid</option>
            <option value="deep">{tt('Deep (15+1섹션)')}</option>
          </select>
          <select
            aria-label={tt('리포트 언어')}
            value={reportLang}
            onChange={(e) => { setReportLangTouched(true); setReportLang(e.target.value as typeof reportLang); }}
            className="rounded-md border border-ink-200 bg-card px-2 py-1 text-sm text-ink-700"
          >
            <option value="ko">한국어</option>
            <option value="en">EN</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
          </select>
          <button
            onClick={run}
            disabled={running}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {running ? tt('진단 중…') : tt('진단 실행')}
          </button>
        </div>
        {tier === 'deep' && (
          <fieldset className="rounded-md border border-ink-200 px-2 py-1.5 text-[13px]">
            <legend className="px-1 text-ink-400">{tt('모델')}</legend>
            <div className="flex items-center gap-3">
              {(['sonnet', 'opus'] as const).map((m) => (
                <label key={m} className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="diag-model"
                    value={m}
                    checked={model === m}
                    onChange={() => setModel(m)}
                  />
                  <span className="capitalize">{m}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-ink-400">{tt('Opus: 더 깊은 분석, 비용↑')}</p>
          </fieldset>
        )}
        <SchedulePanel />
        <SubscribersPanel />
        <ul className="space-y-1">
          {reports.map((r) => (
            <li key={r.id} className="flex items-center gap-1">
              <button
                onClick={() => open(r.id)}
                className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-ink-100"
              >
                {/* title leads (auto key-insight); falls back to id·tier when absent */}
                <div className="truncate text-[13px] font-medium text-ink-800">
                  {r.title || `#${r.id} · ${r.tier}`}
                </div>
                <div className="text-[11px] text-ink-400">
                  #{r.id} · {r.tier}
                  {r.tier === 'deep' && r.model ? ` · ${r.model}` : ''}
                  {r.account ? ` · ${r.account}` : ''} ·{' '}
                  <span className={r.status === 'failed' ? 'text-negative' : ''}>
                    {r.status === 'running' && r.progress?.total
                      ? `running ${r.progress.current ?? 0}/${r.progress.total}`
                      : r.status}
                  </span>
                  {r.created_at ? ` · ${fmtDay(r.created_at, locale)}` : ''}
                </div>
              </button>
              {/* L181 (v1 parity): inline MD/DOCX without opening the report — completed rows only. */}
              {(r.status === 'succeeded' || r.status === 'partial') && (
                <span className="flex shrink-0 gap-1">
                  {(['md', 'docx'] as const).map((f) => (
                    <a
                      key={f}
                      href={`/api/diagnosis/${r.id}/download?format=${f}`}
                      download={`awsops-diagnosis-${r.id}.${f}`}
                      onClick={(e) => e.stopPropagation()}
                      title={f.toUpperCase()}
                      className="rounded border border-ink-200 px-1 text-[10px] uppercase text-ink-400 hover:bg-ink-100"
                    >
                      {f}
                    </a>
                  ))}
                </span>
              )}
              {r.can_edit ? (
                <button
                  onClick={() => del(r.id)}
                  aria-label={tt('리포트 삭제')}
                  title={tt('삭제')}
                  className="shrink-0 rounded-md px-2 py-1 text-ink-300 hover:bg-red-50 hover:text-red-600"
                >
                  🗑
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </aside>
      <main className="min-w-0 flex-1">
        {notice && (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            {notice}
          </div>
        )}
        <div className="mb-4">
          <IntentPanel />
        </div>
        {view?.markdown ? (
          <>
            {/* Title — editable inline by owner/admin; read-only otherwise. Plain text (React-escaped). */}
            {view.can_edit ? (
              titleDraft !== null ? (
                <div className="mb-2 flex items-center gap-2">
                  <input
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    maxLength={200}
                    aria-label={tt('제목')}
                    className="min-w-0 flex-1 rounded-md border border-ink-200 bg-card px-2 py-1 text-base text-ink-800"
                  />
                  <button
                    onClick={async () => { await patchMeta(view!.id, { title: titleDraft!.trim() || null }); setTitleDraft(null); }}
                    className="rounded-md bg-brand-500 px-3 py-1 text-sm font-medium text-white"
                  >{tt('저장')}</button>
                  <button onClick={() => setTitleDraft(null)} className="rounded-md border border-ink-200 px-3 py-1 text-sm">{tt('취소')}</button>
                </div>
              ) : (
                <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-ink-800">
                  <span className="min-w-0 break-words">{view.title || tt('(제목 없음)')}</span>
                  <button onClick={() => setTitleDraft(view!.title ?? '')} aria-label={tt('제목 수정')} title={tt('제목 수정')} className="shrink-0 text-ink-300 hover:text-brand-600">✏️</button>
                </h2>
              )
            ) : view.title ? (
              <h2 className="mb-2 text-lg font-semibold text-ink-800">{view.title}</h2>
            ) : null}
            {/* Tags — chips; owner/admin can add (Enter) / remove (×). */}
            <div className="mb-3 flex flex-wrap items-center gap-1">
              {(view.tags ?? []).map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[12px] text-ink-700">
                  {t}
                  {view.can_edit ? (
                    <button onClick={() => patchMeta(view!.id, { tags: (view!.tags ?? []).filter((x) => x !== t) })} aria-label={`${tt('태그')} ${t} ${tt('삭제')}`} className="text-ink-400 hover:text-red-600">×</button>
                  ) : null}
                </span>
              ))}
              {view.can_edit ? (
                <input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && tagDraft.trim()) {
                      const next = Array.from(new Set([...(view!.tags ?? []), tagDraft.trim()]));
                      patchMeta(view!.id, { tags: next });
                      setTagDraft('');
                    }
                  }}
                  placeholder={tt('태그 추가')}
                  aria-label={tt('태그 추가')}
                  className="w-24 rounded-md border border-ink-200 bg-card px-2 py-0.5 text-[12px] text-ink-800"
                />
              ) : null}
            </div>
            <div className="mb-3 flex items-center justify-between gap-2">
              {createdAt ? (
                <span className="text-[12px] text-ink-400">{tt('생성 일시:')} {fmtDate(createdAt, locale)}</span>
              ) : <span />}
              <div className="flex gap-2">
                {/* Gap L179: browser print-preview view (new tab) — the PDF stays the primary export. */}
                <a
                  href={`/ai-diagnosis/report?id=${view!.id}`}
                  target="_blank"
                  rel="noopener"
                  className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-100"
                >
                  {tt('인쇄용 보기')}
                </a>
                {(['md', 'docx', 'pdf'] as const).map((f) => (
                  <a
                    key={f}
                    href={`/api/diagnosis/${view!.id}/download?format=${f}`}
                    download={`awsops-diagnosis-${view!.id}.${f}`}
                    className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-100"
                  >
                    {f.toUpperCase()}
                  </a>
                ))}
              </div>
            </div>
            {/* L176 (v1 parity): 섹션 수 · 소요 · 리포트 ID stats bar. 소요 is omitted when
                finished_at is unavailable (legacy rows) — never a fabricated duration. */}
            {(() => {
              const row = reports.find((r) => r.id === view!.id);
              const startAt = active?.created_at ?? row?.created_at;
              const endAt = active?.finished_at ?? row?.finished_at;
              const secs = typeof view.summary?.sections === 'number' ? (view.summary.sections as number) : null;
              const endMs = endAt ? new Date(endAt).getTime() : NaN;
              const dur = startAt && !isNaN(endMs) ? elapsedLabel(startAt, endMs) : null;
              const parts = [
                secs !== null ? tt(`섹션 ${secs}개`) : null,
                dur ? tt(`소요 ${dur}`) : null,
                `${tt('리포트')} #${view!.id}`,
              ].filter(Boolean);
              return (
                <div className="mb-3 rounded-md border border-ink-100 bg-paper px-3 py-1.5 text-[12px] text-ink-500">
                  {parts.join(' · ')}
                </div>
              );
            })()}
            {view.summary && <ReportInsights summary={view.summary} />}
            <ReportSections markdown={view.markdown} />
          </>
        ) : view?.status === 'running' ? (
          <ProgressPanel progress={view.progress} stalled={pollTicks >= LONG_AFTER} createdAt={createdAt} tier={active?.tier ?? reports.find((r) => r.id === view?.id)?.tier} />
        ) : view?.status === 'failed' ? (
          <FailedPanel error={view.error} onRetry={run} disabled={running} />
        ) : (
          <div>
            <p className="text-sm text-ink-400">{tt('리포트를 선택하거나 “진단 실행”을 누르세요.')}</p>
            {/* L180 (v1 parity): what a diagnosis covers, before running one. */}
            <p className="mt-4 text-[13px] text-ink-600">{tt('진단은 계정 전반을 아래 섹션으로 분석합니다 (Deep 표시는 Deep 티어 전용):')}</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {sectionsForTier('deep').map((sec) => (
                <li key={sec.key} className="flex items-center gap-1 rounded-full border border-ink-200 bg-paper px-2.5 py-1 text-[12px] text-ink-600">
                  <span>{localizedTitle(sec, lang)}</span>
                  {sec.deep && <span className="rounded-sm bg-brand-50 px-1 text-[10px] text-brand-700">Deep</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}

// mm:ss from an ISO start time (L176); negative skew clamps to 0. NaN start → null (no timer).
function elapsedLabel(fromISO: string | undefined, nowMs: number): string | null {
  if (!fromISO || isNaN(nowMs)) return null;
  const start = new Date(fromISO).getTime();
  if (isNaN(start)) return null;
  const sec = Math.max(0, Math.floor((nowMs - start) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

// A6 (V1 parity): live per-section progress while a report is running — never a bare spinner, so a
// stalled run is visible. The reaper (B2) turns a dead worker into a 'failed' row within minutes.
// L176: a 1s mm:ss elapsed timer from the row's created_at. L177: a section checklist grid
// (completed check / current spinner / pending dim) when the worker streams `progress.completed`;
// old in-flight rows without it keep the bar-only view.
function ProgressPanel({ progress, stalled, createdAt, tier }: {
  progress?: DiagnosisProgress; stalled?: boolean; createdAt?: string; tier?: string;
}) {
  const { tt, lang: uiLang } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = elapsedLabel(createdAt, now);
  const completed = progress?.completed;
  // Grid only when the mirror still matches the worker's catalog size — a sections.py change
  // without a mirror update falls back to the bar-only view instead of drifting silently.
  const catalog = tier ? sectionsForTier(tier) : null;
  const grid = completed && catalog && catalog.length === (progress?.total ?? catalog.length)
    ? catalog : null;
  const cur = progress?.current ?? 0;
  const total = progress?.total ?? 0;
  const pct = total > 0 ? Math.round((cur / total) * 100) : 0;
  const phaseLabel =
    progress?.phase === 'collect' ? tt('데이터 수집')
    : progress?.phase === 'assemble' ? tt('리포트 조립')
    : tt('섹션 분석');
  return (
    <div className="rounded-md border border-ink-200 bg-paper p-4">
      <div className="mb-2 flex items-center justify-between text-[13px] text-ink-700">
        <span className="font-medium">{tt('AI 진단 진행 중…')} {phaseLabel}</span>
        <span className="flex items-center gap-2 tabular-nums text-ink-500">
          {elapsed && <span aria-label={tt('경과 시간')}>{elapsed}</span>}
          {total > 0 && <span>{cur} / {total}</span>}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-ink-100"
        role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${Math.max(pct, 4)}%` }} />
      </div>
      {progress?.section && (
        <div className="mt-2 text-[12px] text-ink-600">
          {progress.phase === 'render' ? tt('최근 완료 섹션:') : tt('현재 섹션:')}{' '}
          <span className="font-medium text-ink-800">{progress.section}</span>
        </div>
      )}
      {grid && (
        // 완료/대기 two-state grid — deliberately NO per-section spinner: render is concurrent
        // (RENDER_CONCURRENCY=4) and the persisted payload can't tell in-flight from untouched,
        // so a spinner would be invented telemetry. progress.section (above) names the most
        // recently COMPLETED section during the render phase.
        <ul className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {grid.map((sec) => {
            const isDone = completed!.some((tName) => titleMatches(sec, tName));
            return (
              <li key={sec.key} className={`flex items-center gap-1.5 text-[12px] ${isDone ? 'text-ink-700' : 'text-ink-300'}`}>
                {isDone ? <CheckCircle size={13} className="shrink-0 text-emerald-500" />
                  : <span className="inline-block h-[13px] w-[13px] shrink-0 rounded-full border border-ink-200" />}
                <span className="truncate">{localizedTitle(sec, uiLang)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {stalled && (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          {tt('예상보다 오래 걸리고 있습니다. 계속 확인 중이며, 워커 장애 시 자동으로 ‘실패’로 정리됩니다.')}
        </div>
      )}
    </div>
  );
}

// A6: surface a failed report (was hidden → the row sat in 'running' and looked stuck) + a retry.
function FailedPanel({ error, onRetry, disabled }: { error?: string | null; onRetry: () => void; disabled?: boolean }) {
  const { tt } = useI18n();
  return (
    <div className="rounded-md border border-red-300 bg-red-50 p-4">
      <div className="mb-1 text-[13px] font-semibold text-red-800">{tt('AI 진단 실패')}</div>
      <p className="mb-3 break-words text-[12px] text-red-700">
        {error || tt('워커가 진단을 완료하지 못했습니다.')}
      </p>
      <button
        onClick={onRetry}
        disabled={disabled}
        className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
      >
        {tt('재시도')}
      </button>
    </div>
  );
}

// Plan-2: intended-vs-actual drift + regression-vs-previous diff, surfaced as small badge sections.
function ReportInsights({ summary }: { summary: ReportSummary }) {
  const { tt } = useI18n();
  const drift = summary.drift ?? [];
  const regressions = summary.diff?.regressions ?? [];
  const improvements = summary.diff?.improvements ?? [];
  if (drift.length === 0 && regressions.length === 0 && improvements.length === 0) return null;
  return (
    <div className="mb-4 space-y-3">
      {drift.length > 0 && (
        <div className="rounded-md border border-ink-200 bg-paper p-3">
          <div className="mb-2 text-[12px] font-semibold text-ink-700">{tt(`의도 대비 실제 (intended vs actual) — 위반 ${drift.length}건`)}</div>
          <div className="flex flex-wrap gap-1.5">
            {drift.map((v, idx) => (
              <span
                key={`${v.id}-${idx}`}
                title={v.observed}
                className={`rounded border px-1.5 py-0.5 text-[11px] ${SEV_CLASS[v.severity ?? 'info'] ?? SEV_CLASS.info}`}
              >
                {v.kind}{v.target ? ` → ${v.target}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}
      {(regressions.length > 0 || improvements.length > 0) && (
        <div className="rounded-md border border-ink-200 bg-paper p-3">
          <div className="mb-2 text-[12px] font-semibold text-ink-700">{tt('이전 리포트 대비 변화 (diff)')}</div>
          <div className="flex flex-wrap gap-1.5">
            {regressions.map((v, idx) => (
              <span key={`reg-${idx}`} title={v.observed} className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700">
                {tt('▲ 악화:')} {v.kind ?? 'posture'}{v.target ? ` → ${v.target}` : ''}
              </span>
            ))}
            {improvements.map((id, idx) => (
              <span key={`imp-${idx}`} className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">
                {tt('▼ 해소:')} #{String(id)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
