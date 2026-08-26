'use client';
import { useEffect, useState } from 'react';
import { DEFAULT_THEME, THEME_EVENT, isTheme, type Theme } from './theme';

function read(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const v = document.documentElement.getAttribute('data-theme');
  return isTheme(v) ? v : DEFAULT_THEME;
}

/** Active theme, reactive to runtime theme switches (THEME_EVENT). */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  useEffect(() => {
    setTheme(read());
    const handler = () => setTheme(read());
    window.addEventListener(THEME_EVENT, handler);
    return () => window.removeEventListener(THEME_EVENT, handler);
  }, []);
  return theme;
}
