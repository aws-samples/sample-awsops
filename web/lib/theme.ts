export const THEMES = ['cobalt', 'teal', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'cobalt';
export const STORAGE_KEY = 'awsops-theme';
export const THEME_EVENT = 'awsops:themechange';

// 브라우저 크롬(<meta name="theme-color">) 색 — layout.tsx no-flash 스크립트의 맵과 lockstep.
// 정적 meta 하나만 두면 dark 사용자가 다크 화면 위 코발트 틴트를 보게 된다.
export const THEME_CHROME_COLORS: Record<Theme, string> = {
  cobalt: '#528DF8',
  teal: '#01A88D',
  dark: '#1A2026',
};

export const THEME_LABELS: Record<Theme, string> = {
  cobalt: 'Cobalt',
  teal: 'Teal',
  dark: 'Dark',
};

export function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore (private mode / SSR) */
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', THEME_CHROME_COLORS[theme]);
  if (typeof window !== 'undefined') {
    try { window.dispatchEvent(new Event(THEME_EVENT)); } catch { /* no-op */ }
  }
}
