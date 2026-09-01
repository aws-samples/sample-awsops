'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import ReportMarkdown, { normalizeHeadings } from '@/components/diagnosis/ReportMarkdown';
import { splitSections } from '@/components/diagnosis/ReportSections';
import { useI18n } from '@/components/shell/LanguageProvider';
import { localeOf } from '@/lib/i18n';

// Printable report view (gap L179, v1 parity): /ai-diagnosis/report?id=N opens in a new tab
// with a white A4 layout — cover block, numbered anchor TOC, per-section page breaks, and
// Print/Close buttons hidden in print media. Renders BARE (ShellGate skips the app chrome —
// the shell would print its sidebar and clip the body inside its h-screen overflow container).
// Access control is the existing GET /api/diagnosis/[id] (owner-or-admin) — no new data
// surface. Section splitting reuses ReportSections' fence-aware splitSections (a `## ` inside
// a code fence must not become a phantom section/page break), which also strips the stored
// markdown's dead-anchor **목차** list; headings are normalized (`## ### X` legacy artifacts)
// BEFORE splitting. Colors are fixed light-theme values — the app's ink tokens invert under
// .dark, which would print pale-on-white.

interface ReportMeta {
  id: number; title: string | null; tier: string | null; status: string | null;
  created_at: string | null; finished_at: string | null;
}


function PrintReportInner() {
  const { tt, lang } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const id = Number(params.get('id'));
  const [state, setState] = useState<{ report: ReportMeta | null; markdown: string | null; err: boolean }>({ report: null, markdown: null, err: false });

  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) { setState((s) => ({ ...s, err: true })); return; }
    let alive = true;
    fetch(`/api/diagnosis/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setState({ report: d.report ?? null, markdown: typeof d.markdown === 'string' ? d.markdown : null, err: false }); })
      .catch(() => { if (alive) setState({ report: null, markdown: null, err: true }); });
    return () => { alive = false; };
  }, [id]);

  // Empty-string markdown (a readable zero-byte artifact) must take the honest fallback too.
  const hasBody = typeof state.markdown === 'string' && state.markdown.trim().length > 0;
  const split = useMemo(
    () => (hasBody ? splitSections(normalizeHeadings(state.markdown as string)) : { preamble: '', sections: [] }),
    [hasBody, state.markdown],
  );

  const close = () => {
    // window.close works only for script-opened tabs; a target=_blank tab has no history —
    // fall back to navigating home to the diagnosis list instead of a dead button.
    window.close();
    setTimeout(() => {
      if (!window.closed) {
        if (window.history.length > 1) window.history.back();
        else router.push('/ai-diagnosis');
      }
    }, 150);
  };

  if (state.err) {
    return (
      <div className="mx-auto max-w-[210mm] bg-white p-10 text-[13px] text-rose-600">
        {tt('리포트를 불러오지 못했습니다.')}
      </div>
    );
  }
  if (!state.report) {
    return <div className="mx-auto max-w-[210mm] bg-white p-10 text-[13px] text-neutral-400">{tt('로딩 중…')}</div>;
  }

  const r = state.report;
  const fmt = (v: string | null) => {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—'; // never print 'Invalid Date'
    return `${d.toLocaleString(localeOf(lang), { timeZone: 'Asia/Seoul' })} (KST)`;
  };

  return (
    <div className="print-report-root min-h-screen bg-white">
      {/* print CSS: white ground, per-section breaks, controls hidden. The ink tokens are
          re-pinned to LIGHT values inside this root — the app-level .dark theme inverts them,
          which would render (and print) pale-on-white. */}
      <style>{`
        .print-report-root {
          /* EVERY token ReportMarkdown paints with must be re-pinned to the light palette —
             .dark inverts ink AND paper/brand (code blocks, <pre>, table heads use
             --paper-muted, which is #141A1F in dark → dark-on-dark on this white page). */
          --ink-900: #05080B; --ink-800: #1B2530; --ink-700: #2C3A47;
          --ink-600: #455664; --ink-500: #64748B; --ink-400: #94A3B8; --ink-300: #CBD5E1;
          --ink-200: #E2E8F0; --ink-100: #EEF2F6; --ink-50: #F6F8FA;
          --paper: #F4F6F8; --paper-muted: #EBEFF2; --white: #FFFFFF;
          --surface-page: #FFFFFF; --surface-sunken: #EBEFF2; --surface-card: #FFFFFF;
          --brand-50: #E6F6F2; --brand-100: #C4EBE3; --brand-200: #8FD9CC; --brand-300: #54C3B0;
          --brand-400: #1FB199; --brand-500: #01A88D; --brand-600: #00876F; --brand-700: #0A6B5A;
          color-scheme: light;
          color: #1B2530;
        }
        @media print {
          .print-hidden { display: none !important; }
          .print-break { break-before: page; }
          body { background: #fff !important; }
        }
      `}</style>
      <div className="mx-auto max-w-[210mm] px-10 py-8">
        <div className="print-hidden mb-6 flex items-center justify-end gap-2">
          <button onClick={() => window.print()} className="rounded-md bg-brand-500 px-3 py-1.5 text-[13px] font-medium text-white">{tt('인쇄')}</button>
          <button onClick={close} className="rounded-md border border-neutral-300 px-3 py-1.5 text-[13px] text-neutral-600">{tt('닫기')}</button>
        </div>

        {/* Cover block */}
        <header className="mb-8 border-b-2 border-neutral-800 pb-6">
          <h1 className="text-[24px] font-bold text-neutral-900">{r.title || `AI Diagnosis Report #${r.id}`}</h1>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px] text-neutral-600">
            <div><dt className="inline text-neutral-400">{tt('티어')} </dt><dd className="inline font-medium">{r.tier ?? '—'}</dd></div>
            <div><dt className="inline text-neutral-400">{tt('상태')} </dt><dd className="inline font-medium">{r.status ?? '—'}</dd></div>
            <div><dt className="inline text-neutral-400">{tt('생성')} </dt><dd className="inline">{fmt(r.created_at)}</dd></div>
            <div><dt className="inline text-neutral-400">{tt('완료')} </dt><dd className="inline">{fmt(r.finished_at)}</dd></div>
          </dl>
        </header>

        {/* Numbered anchor TOC (the stored markdown's dead-anchor 목차 list is stripped by splitSections) */}
        {split.sections.length > 0 && (
          <nav className="mb-8">
            <h2 className="mb-2 text-[15px] font-semibold text-neutral-800">{tt('목차')}</h2>
            <ol className="list-decimal space-y-1 pl-6 text-[13px]">
              {split.sections.map((s, i) => (
                <li key={i}><a href={`#report-sec-${i}`} className="text-brand-700 hover:underline">{s.title}</a></li>
              ))}
            </ol>
          </nav>
        )}

        {!hasBody ? (
          // Tri-state honesty: a not-yet-finished report and an unreadable artifact on a
          // finished one are different operator situations — never one flat '데이터 불가'.
          <p className="text-[13px] text-neutral-400">
            {r.status === 'succeeded' || r.status === 'partial'
              ? tt('리포트 본문을 읽지 못했습니다.')
              : r.status === 'failed'
                ? tt('리포트 생성이 실패했습니다.')
                : `${tt('리포트가 아직 완료되지 않았습니다.')} (${r.status ?? '—'})`}
          </p>
        ) : (
          <>
            {split.preamble.trim() && (
              <section>
                <ReportMarkdown markdown={split.preamble} />
              </section>
            )}
            {split.sections.map((s, i) => (
              <section key={i} id={`report-sec-${i}`} className="print-break mt-8">
                <ReportMarkdown markdown={`## ${s.title}\n${s.body}`} />
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export default function PrintReportPage() {
  return (
    <Suspense fallback={null}>
      <PrintReportInner />
    </Suspense>
  );
}
