'use client';
import { useEffect, useState } from 'react';
import Meter from '@/components/ui/Meter';

// Shared plumbing for the per-service diagnostic metric tables (owner 가이드 시리즈):
// fetch hook, value formatters, table cell classes, health pill. Each service table lives in
// its own file; the collapsible explainers are data-driven (see DiagnosisGuide + guides.tsx).

export type Row = Record<string, unknown>;
export type Fleet = Record<string, Record<string, number | null>>;

export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const dash = <span className="text-ink-300">—</span>;
export const gb = (v: number | null) => (v == null ? dash : `${(v / 1024 ** 3).toFixed(2)} GB`);
export const mb = (v: number | null) => (v == null ? dash : `${(v / 1024 / 1024).toFixed(1)} MB`);
export const kbps = (v: number | null) => (v == null ? dash : `${(v / 1024).toFixed(1)} KB/s`);
export const cnt = (v: number | null) => (v == null ? dash : Math.round(v).toLocaleString());
export const ms = (v: number | null) => (v == null ? dash : `${v.toFixed(1)} ms`);
export const meter = (v: number | null) => (v == null ? dash : <Meter value={v} />);

export const TH = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400 whitespace-nowrap';
export const TD = 'px-3 py-1.5 text-[12px] text-ink-600 whitespace-nowrap';
export const MONO = `${TD} font-mono text-[11.5px]`;
export const DANGER = 'text-rose-700 font-semibold';

// 진단 테이블 기간 프리셋 — 값은 선택 기간 전체에 대한 단일 집계(Sum=기간 누적, Avg=기간 평균, Max=기간 최대).
export const RANGES: ReadonlyArray<readonly [string, number]> = [['1h', 3600], ['6h', 21600], ['24h', 86400], ['7d', 604800]];

/** 기간 선택 토글 — 각 진단 카드 헤더(right)에 배치. ranges로 프리셋 교체 가능 (예: NFM 1h 한도). */
export function RangePicker({ value, onChange, ranges = RANGES }: {
  value: number; onChange: (sec: number) => void;
  ranges?: ReadonlyArray<readonly [string, number]>;
}) {
  return (
    <div className="flex items-center gap-1">
      {ranges.map(([label, sec]) => (
        <button
          key={sec}
          type="button"
          onClick={() => onChange(sec)}
          className={`rounded-md px-2 py-1 text-[11.5px] ${value === sec ? 'bg-brand-500/10 font-medium text-brand-700' : 'text-ink-400 hover:bg-ink-50'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Bulk fleet metrics for a type's `?ids=` endpoint. Fire-and-forget: errors surface as a line, never fail the page. */
export function useFleet(type: string, ids: string[], range = 3600): { fleet: Fleet; err: string } {
  const [fleet, setFleet] = useState<Fleet>({});
  const [err, setErr] = useState('');
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetch(`/api/inventory/${type}/metrics?ids=${encodeURIComponent(key)}&range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setFleet(d.fleet ?? {}); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [type, key, range]);
  return { fleet, err };
}

/** 진단 우선순위 필: 정상 기대값과 비교해 ok(초록)/위험(빨강)을 색으로, hover에 진단 설명. */
export function HealthPill({ label, value, ok, hint }: { label: string; value: string; ok: boolean | null; hint: string }) {
  return (
    <span
      title={hint}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${
        ok == null ? 'border-ink-100 text-ink-400' : ok ? 'border-emerald-200 bg-emerald-500/5 text-emerald-700' : 'border-rose-300 bg-rose-500/10 text-rose-700 font-semibold'
      }`}
    >
      <span className="text-ink-400">{label}</span>
      <span className="tabular">{value}</span>
    </span>
  );
}
