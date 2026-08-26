'use client';
import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '@/components/shell/LanguageProvider';

// Data-driven collapsible diagnosis explainer (owner: "설명 내용을 화면에서 펼쳐 보기로").
// One component renders every service's guide — the per-service CONTENT lives as a GuideSpec
// in guides.tsx, so adding a service is data-only (no new component). Static content, no fetch.
// i18n: callers pass the Korean spec; EN/ZH/JA variants live in guides.en/zh/ja.tsx keyed by
// GuideSpec.service and are resolved here from the active language (missing key → Korean).

export interface GuideSection {
  title: string;
  items: ReactNode[];
}

export interface GuideSpec {
  /** Button label prefix — e.g. 'MSK' → "MSK 진단 가이드 — 지표 읽는 법 (펼쳐 보기)". */
  service: string;
  intro: ReactNode;
  sections: GuideSection[];
  /** Priority-table column headers (services differ: '정상값' vs '주의 기준'). */
  priorityHeader: [string, string, string];
  /** [metric, threshold, meaning] rows. */
  priority: [string, string, string][];
}

import { GUIDES_EN } from './guides.en';
import { GUIDES_ZH } from './guides.zh';
import { GUIDES_JA } from './guides.ja';

const GUIDES: Partial<Record<string, Record<string, GuideSpec>>> = { en: GUIDES_EN, zh: GUIDES_ZH, ja: GUIDES_JA };

const TH = 'px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400';
const TDC = 'px-2.5 py-1.5 text-[12px] text-ink-600';
const H4 = 'mt-3 mb-1 text-[12.5px] font-semibold text-ink-700';

export default function DiagnosisGuide({ spec: koSpec }: { spec: GuideSpec }) {
  const [open, setOpen] = useState(false);
  const { lang, tt } = useI18n();
  const spec = GUIDES[lang]?.[koSpec.service] ?? koSpec;
  return (
    <div className="border-t border-ink-100">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[12.5px] font-medium text-brand-700 hover:bg-ink-50"
      >
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {spec.service} {tt('진단 가이드 — 지표 읽는 법 (펼쳐 보기)')}
      </button>
      {open && (
        <div className="px-5 pb-4 text-[12.5px] leading-relaxed text-ink-600">
          <p className="mt-1">{spec.intro}</p>
          {spec.sections.map((sec) => (
            <div key={sec.title}>
              <div className={H4}>{sec.title}</div>
              <ul className="list-disc pl-5 space-y-0.5">
                {sec.items.map((it, i) => <li key={i}>{it}</li>)}
              </ul>
            </div>
          ))}
          <div className={H4}>{tt('경보 우선순위 요약')}</div>
          <div className="overflow-x-auto rounded-lg border border-ink-100">
            <table className="w-full">
              <thead><tr className="border-b border-ink-100 bg-paper-muted/60">
                {spec.priorityHeader.map((h) => <th key={h} className={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {spec.priority.map(([m, v, d]) => (
                  <tr key={m} className="border-b border-ink-50 last:border-0">
                    <td className={`${TDC} font-mono text-[11.5px]`}>{m}</td>
                    <td className={`${TDC} tabular`}>{v}</td>
                    <td className={TDC}>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
