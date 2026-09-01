'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, AlertTriangle, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import ReportMarkdown from './ReportMarkdown';
import { useI18n } from '@/components/shell/LanguageProvider';

// Sectioned report view (gap-audit L49, v1 parity): splits the completed report's markdown on its
// `## ` section headings into collapsible cards, with a sticky TOC sidebar (click → smooth scroll)
// and a per-section severity icon from body keyword counts. Client-side only — the stored markdown
// is unchanged; each section body renders through the existing ReportMarkdown. A report with no
// `## ` heading (legacy/degraded shapes) falls back to the single continuous document.

export interface ReportSection { title: string; body: string }

/** Split a report into its preamble and `## `-delimited sections. The preamble's `**목차**`
 *  link list is stripped — its `#{key}` anchors never matched a DOM id (dead links); the UI TOC
 *  replaces it. The raw .md download keeps the original. */
export function splitSections(markdown: string): { preamble: string; sections: ReportSection[] } {
  const lines = markdown.split('\n');
  const sections: ReportSection[] = [];
  const preambleLines: string[] = [];
  let current: ReportSection | null = null;
  // Fence-aware: a `## ` line inside an open ``` or ~~~ block is code, not a heading —
  // splitting there would re-break what the worker's _balance_code_fences protected.
  let fenceOpen = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenceOpen = !fenceOpen;
    const m = fenceOpen ? null : /^## (.+)$/.exec(line);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1].trim(), body: '' };
    } else if (current) {
      current.body += line + '\n';
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);
  // Strip the markdown TOC block (bold 목차/TOC label + its immediate `- [..](#..)` list).
  const preamble = preambleLines
    .filter((l) => !/^\*\*(목차|Table of Contents|目录|目次)\*\*$/.test(l.trim()) && !/^- \[.+\]\(#.+\)$/.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { preamble, sections };
}

// Severity from the VERBATIM [Critical]/[Warning] markers only — the prompts prescribe them in
// every language (LANG_RULES keeps them verbatim), so they are the language-stable signal. Prose
// keywords false-positived on the prompt-mandated '심각도' table column header (every well-formed
// Korean section read red). A degraded/failed section must never read green. Still a DISPLAY
// heuristic, not a scored verdict — the icon tooltip says so.
export type Severity = 'critical' | 'warning' | 'ok';
export function sectionSeverity(body: string): Severity {
  if (/\[critical\]/i.test(body)) return 'critical';
  if (/\[warning\]/i.test(body) || /degraded|섹션 생성에 실패/i.test(body)) return 'warning';
  return 'ok';
}

function SeverityIcon({ severity, title }: { severity: Severity; title: string }) {
  if (severity === 'critical') return <XCircle size={15} className="shrink-0 text-red-500" aria-label={title} />;
  if (severity === 'warning') return <AlertTriangle size={15} className="shrink-0 text-amber-500" aria-label={title} />;
  return <CheckCircle size={15} className="shrink-0 text-emerald-500" aria-label={title} />;
}

export default function ReportSections({ markdown }: { markdown: string }) {
  const { tt } = useI18n();
  const { preamble, sections } = useMemo(() => splitSections(markdown), [markdown]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const refs = useRef<(HTMLElement | null)[]>([]);
  // Switching to another report must not carry report A's collapsed indexes onto report B.
  useEffect(() => { setCollapsed(new Set()); }, [markdown]);

  // No sections (legacy/degraded markdown) → the original continuous document, unchanged.
  if (sections.length === 0) return <ReportMarkdown markdown={markdown} />;

  const toggle = (i: number) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  const jump = (i: number) => {
    setCollapsed((prev) => { const next = new Set(prev); next.delete(i); return next; });
    refs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const severityTitle = tt('본문 키워드 기반 표시 (점수 아님)');

  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        {preamble.trim() && <ReportMarkdown markdown={preamble} />}
        <div className="mb-2 flex justify-end gap-2 text-[12px]">
          <button onClick={() => setCollapsed(new Set())} className="text-ink-400 hover:text-ink-700">
            {tt('모두 펼치기')}
          </button>
          <button
            onClick={() => setCollapsed(new Set(sections.map((_, i) => i)))}
            className="text-ink-400 hover:text-ink-700"
          >
            {tt('모두 접기')}
          </button>
        </div>
        <div className="space-y-3">
          {sections.map((s, i) => {
            const isCollapsed = collapsed.has(i);
            return (
              <section
                key={i}
                ref={(el) => { refs.current[i] = el; }}
                className="scroll-mt-4 rounded-lg border border-ink-200 bg-card"
              >
                <button
                  onClick={() => toggle(i)}
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left"
                >
                  {isCollapsed ? <ChevronRight size={15} className="shrink-0 text-ink-400" /> : <ChevronDown size={15} className="shrink-0 text-ink-400" />}
                  <SeverityIcon severity={sectionSeverity(s.body)} title={severityTitle} />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink-800">{s.title}</span>
                </button>
                {!isCollapsed && (
                  <div className="border-t border-ink-100 px-3 pb-3">
                    <ReportMarkdown markdown={s.body} />
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
      <nav className="sticky top-4 hidden w-52 shrink-0 lg:block" aria-label={tt('리포트 목차')}>
        <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-ink-400">{tt('목차')}</p>
        <ul className="space-y-0.5">
          {sections.map((s, i) => (
            <li key={i}>
              <button
                onClick={() => jump(i)}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[12px] text-ink-600 hover:bg-ink-50"
              >
                <SeverityIcon severity={sectionSeverity(s.body)} title={severityTitle} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
