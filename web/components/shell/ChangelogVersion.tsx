'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ScrollText } from 'lucide-react';
import { useI18n } from '@/components/shell/LanguageProvider';
import Markdown from '@/components/chat/Markdown';
import type { Changelog, ChangelogVersion as CV } from '@/lib/changelog';

// 사이드바 풋터의 버전 칩 (CHANGELOG.md 최신 릴리스와 항상 일치 — /api/changelog가
// 배포 이미지에 실린 파일을 읽음) + 클릭 시 버전별 변경 이력 모달.
// 본문은 ko면 한국어 섹션, 그 외(en/zh/ja)는 영어 섹션을 렌더 (CHANGELOG는 2개 언어만 보유).

export default function ChangelogVersion() {
  const { lang, tt } = useI18n();
  const [data, setData] = useState<Changelog | null>(null);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/changelog')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d?.versions) setData(d as Changelog); })
      .catch(() => { /* 칩 미표시로 degrade */ });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!data?.latest) return null;
  // 빈 Unreleased는 목록에서 숨긴다 (내용 있는 버전만 선택지).
  const versions = data.versions.filter((v) => v.version !== 'Unreleased' || v.en.trim() !== '');
  const active: CV | undefined = versions.find((v) => v.version === (sel ?? data.latest)) ?? versions[0];
  const body = active ? (lang === 'ko' ? active.ko : active.en) : '';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={tt('변경 이력 보기')}
        className="mt-1.5 flex items-center gap-1.5 rounded-md px-0.5 py-0.5 font-mono text-[11px] text-chrome-fg-muted transition-colors hover:text-chrome-fg"
      >
        <ScrollText size={11} aria-hidden />
        v{data.latest}
      </button>

      {open && createPortal(
        <>
          <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-ink-900/40" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={tt('변경 이력')}
            className="fixed inset-x-3 top-[6vh] z-50 mx-auto flex max-h-[86vh] w-auto max-w-3xl flex-col overflow-hidden rounded-xl border border-ink-100 bg-card shadow-pop"
          >
            <header className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-semibold text-ink-800">{tt('변경 이력')}</h2>
                <select
                  value={active?.version}
                  onChange={(e) => setSel(e.target.value)}
                  aria-label="version"
                  className="rounded-md border border-ink-200 bg-card px-2 py-1 font-mono text-[12px] text-ink-700"
                >
                  {versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}{v.date ? ` — ${v.date}` : ''}
                    </option>
                  ))}
                </select>
                {active?.version === data.latest && (
                  <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-brand-700">
                    {tt('현재 버전')}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="닫기"
                className="rounded p-1 text-ink-400 hover:bg-ink-50 hover:text-ink-700"
              >
                <X size={16} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-5 py-4 text-[13px]">
              {body ? <Markdown>{body}</Markdown> : <p className="text-ink-400">{tt('데이터 없음')}</p>}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
