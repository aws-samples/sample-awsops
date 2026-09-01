'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';
import { localeOf } from '@/lib/i18n';

// Per-user scheduled auto-diagnosis (v1 report-scheduler parity). Reads/writes /api/diagnosis/schedule;
// the EventBridge dispatcher (worker tier) does the actual enqueueing — this panel only edits the row.
// Detail fields (gap L51): dayOfWeek 0-6 (0=Sun, KST) for weekly/biweekly, dayOfMonth 1-28 (KST)
// for monthly, hour 0-23 (KST); lang (gap L50) picks the report output language.
interface Schedule {
  scheduleType: 'weekly' | 'biweekly' | 'monthly';
  enabled: boolean;
  tier: string;
  model: string | null;
  lang?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  hour?: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

function fmtKst(iso: string | null, locale: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(locale, { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const REPORT_LANGS: { value: string; label: string }[] = [
  { value: 'ko', label: '한국어' }, { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' }, { value: 'ja', label: '日本語' },
];

export default function SchedulePanel() {
  const { tt, lang } = useI18n();
  const locale = localeOf(lang);
  const [sched, setSched] = useState<Schedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/diagnosis/schedule')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.schedule) setSched(d.schedule as Schedule); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // A schedule without a stored lang defaults to the CURRENT UI language (matches the manual-run
  // default) — resolved at render/save time, not at load, so the provider's post-mount
  // localStorage hydration is reflected. A stored lang always wins.
  const uiLang = (['ko', 'en', 'zh', 'ja'] as const).includes(lang as 'ko') ? lang : 'ko';

  if (!sched) return null;

  const patch = (p: Partial<Schedule>) => { setSched({ ...sched, ...p }); setSaved(false); };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      // Send only the detail field the cadence uses (the API 400s a cadence-mismatched field).
      const detail = sched.scheduleType === 'monthly'
        ? { ...(typeof sched.dayOfMonth === 'number' ? { dayOfMonth: sched.dayOfMonth } : {}) }
        : { ...(typeof sched.dayOfWeek === 'number' ? { dayOfWeek: sched.dayOfWeek } : {}) };
      const r = await fetch('/api/diagnosis/schedule', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scheduleType: sched.scheduleType, enabled: sched.enabled, tier: sched.tier, model: sched.model,
          lang: sched.lang ?? uiLang, // persist exactly what the select displays
          ...(typeof sched.hour === 'number' ? { hour: sched.hour } : {}),
          ...detail,
        }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d?.schedule) setSched(d.schedule as Schedule);
        setSaved(true);
      }
    } finally {
      setSaving(false);
    }
  };

  const selectCls = 'rounded-md border border-ink-200 bg-card px-2 py-1 text-[13px] text-ink-700';
  return (
    <fieldset className="rounded-md border border-ink-200 px-2 py-1.5 text-[13px]">
      <legend className="px-1 text-ink-400">{tt('자동 진단 예약')}</legend>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={sched.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        <span>{tt('주기적으로 진단 실행')}</span>
      </label>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <select
          aria-label={tt('진단 주기')}
          value={sched.scheduleType}
          onChange={(e) => patch({ scheduleType: e.target.value as Schedule['scheduleType'] })}
          className={selectCls}
        >
          <option value="weekly">{tt('매주')}</option>
          <option value="biweekly">{tt('격주')}</option>
          <option value="monthly">{tt('매월')}</option>
        </select>
        {sched.scheduleType === 'monthly' ? (
          <select
            aria-label={tt('실행 날짜')}
            value={sched.dayOfMonth ?? ''}
            onChange={(e) => patch({ dayOfMonth: e.target.value === '' ? undefined : Number(e.target.value) })}
            className={selectCls}
          >
            <option value="">{tt('날짜 무관')}</option>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>{tt(`${d}일`)}</option>
            ))}
          </select>
        ) : (
          <select
            aria-label={tt('실행 요일')}
            value={sched.dayOfWeek ?? ''}
            onChange={(e) => patch({ dayOfWeek: e.target.value === '' ? undefined : Number(e.target.value) })}
            className={selectCls}
          >
            <option value="">{tt('요일 무관')}</option>
            {DOW_LABELS.map((d, i) => <option key={i} value={i}>{tt(d)}</option>)}
          </select>
        )}
        <select
          aria-label={tt('실행 시각')}
          value={sched.hour ?? ''}
          onChange={(e) => patch({ hour: e.target.value === '' ? undefined : Number(e.target.value) })}
          className={selectCls}
        >
          <option value="">{tt('시각 무관')}</option>
          {Array.from({ length: 24 }, (_, i) => i).map((h) => (
            <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
          ))}
        </select>
        <select
          aria-label={tt('리포트 언어')}
          value={sched.lang ?? uiLang}
          onChange={(e) => patch({ lang: e.target.value })}
          className={selectCls}
        >
          {REPORT_LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md bg-brand-500 px-2.5 py-1 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {saving ? tt('저장 중…') : tt('저장')}
        </button>
      </div>
      {sched.enabled && <p className="mt-1 text-[11px] text-ink-400">{tt('다음 실행:')} {fmtKst(sched.nextRunAt, locale)} (KST)</p>}
      {sched.lastRunAt && <p className="mt-1 text-[11px] text-ink-400">{tt('최근 실행:')} {fmtKst(sched.lastRunAt, locale)} (KST)</p>}
      {saved && <p className="mt-1 text-[11px] text-green-600">{tt('저장됨')}</p>}
    </fieldset>
  );
}
