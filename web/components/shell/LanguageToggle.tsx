'use client';
import { useI18n } from './LanguageProvider';
import { SUPPORTED_LANGS, type Lang } from '@/lib/i18n';

// 라틴 코드 4버튼 (owner 확정 디자인 — 네이티브 라벨은 w-64 헤더를 상시 2행으로 만들어 원복).
// Record<Lang, …>이므로 언어 추가 시 여기서 컴파일이 깨져 라벨 누락을 잡는다.
const LABELS: Record<Lang, string> = { ko: 'KO', en: 'EN', zh: 'CN', ja: 'JA' };

export default function LanguageToggle() {
  const { lang, setLang } = useI18n();
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-ink-200" role="group" aria-label="Language">
      {SUPPORTED_LANGS.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`whitespace-nowrap px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
            lang === l ? 'bg-brand-500/10 text-brand-700' : 'text-ink-400 hover:bg-ink-100 hover:text-ink-700'
          }`}
        >
          {LABELS[l]}
        </button>
      ))}
    </div>
  );
}
