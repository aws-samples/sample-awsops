// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  THEMES, DEFAULT_THEME, THEME_LABELS, isTheme,
  getStoredTheme, setStoredTheme, applyTheme, STORAGE_KEY,
} from './theme';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme model', () => {
  it('exposes the three themes and a cobalt default', () => {
    expect(THEMES).toEqual(['cobalt', 'teal', 'dark']);
    expect(DEFAULT_THEME).toBe('cobalt');
    expect(THEME_LABELS['dark']).toBe('Dark');
  });

  it('isTheme validates membership', () => {
    expect(isTheme('cobalt')).toBe(true);
    expect(isTheme('nope')).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  it('getStoredTheme returns default when unset or invalid', () => {
    expect(getStoredTheme()).toBe('cobalt');
    localStorage.setItem(STORAGE_KEY, 'bogus');
    expect(getStoredTheme()).toBe('cobalt');
  });

  it('setStoredTheme + getStoredTheme round-trips', () => {
    setStoredTheme('cobalt');
    expect(getStoredTheme()).toBe('cobalt');
  });

  it('applyTheme sets the data-theme attribute on <html>', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

// PWA theme-color lockstep: THEME_CHROME_COLORS ↔ layout.tsx no-flash 인라인 스크립트의 색 맵.
// 스크립트는 첫 페인트 전에 meta를 맞추고, applyTheme()는 이후 토글에서 갱신 — 두 맵이 어긋나면
// 다크 사용자가 새로고침 직후와 토글 후 서로 다른 브라우저 크롬 색을 본다.
describe('THEME_CHROME_COLORS', () => {
  it('모든 테마에 크롬 색이 있고 layout 인라인 스크립트 맵과 일치', async () => {
    const { THEMES, THEME_CHROME_COLORS } = await import('./theme');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const layout = fs.readFileSync(path.join(__dirname, '..', 'app', 'layout.tsx'), 'utf8');
    for (const t of THEMES) {
      expect(THEME_CHROME_COLORS[t]).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(layout, `layout no-flash script missing ${t}:${THEME_CHROME_COLORS[t]}`)
        .toContain(`${t}:'${THEME_CHROME_COLORS[t]}'`);
    }
  });
});
