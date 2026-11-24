'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { ReportForDeck } from '@/lib/diagnosis-deck';

type Action = 'preview' | 'html' | 'pptx';

export default function PresentationDownloads({ report }: { report: ReportForDeck }) {
  const { tt, lang } = useI18n();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    setPreview('');
    setBusy(null);
    setError(false);
    return () => {
      generation.current++;
    };
  }, [report.id, report.markdown, report.title, report.tier, report.status, lang]);
  useEffect(() => {
    if (preview && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [preview]);

  async function run(action: Action) {
    const current = ++generation.current;
    setBusy(action);
    setError(false);
    try {
      const { buildDiagnosisDeck } = await import('@/lib/diagnosis-deck');
      const deck = buildDiagnosisDeck(report, lang);
      let blob: Blob;
      if (action === 'pptx') {
        const { renderDeckPptx } = await import('@/lib/diagnosis-slides-pptx');
        blob = await renderDeckPptx(deck);
      } else {
        const { renderDeckHtml } = await import('@/lib/diagnosis-slides-html');
        const html = await renderDeckHtml(deck);
        if (current !== generation.current) return;
        if (action === 'preview') {
          setPreview(html);
          return;
        }
        blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      }
      if (current !== generation.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `awsops-diagnosis-${report.id}.${action}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setBusy(null);
    }
  }

  return (
    <>
      {(['preview', 'html', 'pptx'] as const).map((action) => (
        <button
          key={action}
          type="button"
          disabled={busy !== null}
          onClick={() => run(action)}
          className="whitespace-nowrap rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-100 disabled:opacity-50"
        >
          {busy === action
            ? tt('발표 자료 생성 중…')
            : action === 'preview'
              ? tt('발표 보기')
              : action.toUpperCase()}
        </button>
      ))}
      {error && (
        <span role="alert" className="text-sm text-negative">
          {tt('발표 자료를 만들지 못했습니다.')}
        </span>
      )}
      {preview && (
        <dialog
          ref={dialog}
          aria-label={tt('발표 보기')}
          onClose={() => setPreview('')}
          className="m-auto h-[92vh] w-[96vw] max-w-none rounded-lg bg-card p-0 text-ink-800 backdrop:bg-black/50"
        >
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 justify-end border-b border-ink-200 px-3 py-1">
              <button
                type="button"
                onClick={() => dialog.current?.close()}
                className="rounded px-3 py-1 hover:bg-ink-100"
              >
                {tt('닫기')}
              </button>
            </div>
            <iframe
              title={tt('발표 보기')}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={preview}
              className="min-h-0 w-full flex-1 border-0"
            />
          </div>
        </dialog>
      )}
    </>
  );
}
