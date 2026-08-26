'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { type Lang, isLang, makeT, makeTT } from '@/lib/i18n';

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Term translator: known Korean UI literals → active language; unknown passthrough. */
  tt: (s: string) => string;
}

const Ctx = createContext<I18nCtx | null>(null);
const STORAGE_KEY = 'awsops-lang';

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // SSR-safe initial = 'ko' (matches <html lang="ko">); client restores the saved choice post-mount.
  const [lang, setLangState] = useState<Lang>('ko');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isLang(saved)) {
        setLangState(saved);
        document.documentElement.lang = saved;
      }
    } catch { /* localStorage unavailable — keep default */ }
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = l;
  }, []);

  const value = useMemo<I18nCtx>(() => ({ lang, setLang, t: makeT(lang), tt: makeTT(lang) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// No-provider fallback (ko, passthrough) — shared UI atoms (StatTile/Card/…) call useI18n and
// must keep rendering in unit tests / isolated mounts without a provider.
const FALLBACK: I18nCtx = { lang: 'ko', setLang: () => {}, t: makeT('ko'), tt: (s) => s };

export function useI18n(): I18nCtx {
  return useContext(Ctx) ?? FALLBACK;
}
