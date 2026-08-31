'use client';
import { useEffect, useState } from 'react';
import { THEMES, THEME_LABELS, getStoredTheme, setStoredTheme, applyTheme, type Theme } from '@/lib/theme';
import { useI18n } from '@/components/shell/LanguageProvider';
import { cn } from '@/lib/cn';

/**
 * ThemeToggle — 3-way segmented control (Cobalt / Teal / Dark) in the sidebar
 * footer. Reads the stored theme on mount, writes + applies on change.
 * Uses chrome tokens so it reads correctly on both light and dark chrome.
 */
export default function ThemeToggle() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>('teal');

  useEffect(() => {
    setTheme(getStoredTheme());
  }, []);

  function pick(nextTheme: Theme) {
    setTheme(nextTheme);
    setStoredTheme(nextTheme);
    applyTheme(nextTheme);
  }

  return (
    <div className="mt-2 flex gap-1 rounded-md border border-chrome-border p-0.5" role="group" aria-label={t('theme.label')}>
      {THEMES.map((themeOption) => (
        <button
          key={themeOption}
          type="button"
          onClick={() => pick(themeOption)}
          aria-pressed={theme === themeOption}
          className={cn(
            'flex-1 rounded px-1.5 py-1 text-[11px] font-semibold transition-colors',
            theme === themeOption
              ? 'bg-chrome-active text-chrome-active-fg'
              : 'text-chrome-fg-muted hover:text-chrome-fg',
          )}
        >
          {THEME_LABELS[themeOption]}
        </button>
      ))}
    </div>
  );
}
