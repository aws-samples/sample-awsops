'use client';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';

// Overview "AI 인사이트" panel — latest cached operational observations (K8s events / CloudWatch /
// cost) synthesized by the worker. Read-only; the refresh button enqueues a regeneration (admin-only
// server-side; non-admins get a 403 surfaced as a toast). Empty state prompts a first refresh.
interface Insight { severity: 'critical' | 'warning' | 'info'; title: string; detail: string; source: string }
interface Latest { status: string; insights: Insight[]; sourcesUsed: Record<string, number>; generatedAt: string | null }

const BADGE: Record<string, string> = {
  critical: 'bg-rose-100 text-rose-700 border-rose-200',
  warning: 'bg-amber-100 text-amber-700 border-amber-200',
  info: 'bg-ink-100 text-ink-600 border-ink-200',
};

function ago(ts: string | null, tt: (s: string) => string): string {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 90) return tt('방금 전');
  if (s < 3600) return tt(`${Math.round(s / 60)}분 전`);
  if (s < 86400) return tt(`${Math.round(s / 3600)}시간 전`);
  return tt(`${Math.round(s / 86400)}일 전`);
}

export default function InsightCard() {
  const { tt } = useI18n();
  const [data, setData] = useState<Latest | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(true);   // hide entirely when the feature flag is off (M3)
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/insights');
      if (r.ok) {
        const body = await r.json();
        setEnabled(body.enabled !== false);
        setData(body.insight);
      }
    } catch { /* best-effort */ } finally { setLoaded(true); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/insights/refresh', { method: 'POST' });
      if (r.status === 403) setMsg(tt('관리자만 새로고침할 수 있습니다'));
      else if (r.status === 503) setMsg(tt('AI 인사이트가 비활성화되어 있습니다'));
      else if (r.ok) setMsg(tt('인사이트 생성을 요청했습니다 — 잠시 후 갱신됩니다'));
      else setMsg(tt('새로고침 실패'));
    } catch { setMsg(tt('새로고침 실패')); } finally { setBusy(false); }
  }, [tt]);

  if (loaded && !enabled) return null;   // feature off → render nothing (no-op on the dashboard)
  const insights = data?.insights ?? [];
  return (
    <section className="rounded-xl border border-ink-200 bg-card p-4" data-testid="ai-insight-card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold text-ink-800">{tt('AI 인사이트')}</h2>
          {data?.generatedAt && <span className="text-[12px] text-ink-400">{ago(data.generatedAt, tt)}</span>}
        </div>
        <button type="button" onClick={refresh} disabled={busy}
          className="text-[12px] rounded-md border border-ink-200 px-2.5 py-1 text-ink-600 hover:bg-ink-50 disabled:opacity-50">
          {busy ? tt('요청 중…') : tt('새로고침')}
        </button>
      </div>
      {msg && <p className="text-[12px] text-ink-500 mb-2">{msg}</p>}
      {!loaded ? (
        <p className="text-[13px] text-ink-400">{tt('로딩 중…')}</p>
      ) : insights.length === 0 ? (
        <p className="text-[13px] text-ink-400" data-testid="ai-insight-empty">
          {tt('아직 생성된 인사이트가 없습니다. 새로고침으로 첫 분석을 요청하세요.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {insights.map((it, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${BADGE[it.severity] || BADGE.info}`}>
                {it.severity}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink-800">{it.title}</p>
                {it.detail && <p className="text-[12px] text-ink-500">{it.detail}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
