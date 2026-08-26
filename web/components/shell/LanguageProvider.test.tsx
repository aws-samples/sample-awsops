// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LanguageProvider, useI18n } from './LanguageProvider';

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.lang = 'ko';
});

function Probe() {
  const { lang } = useI18n();
  return <div data-testid="lang">{lang}</div>;
}

const mount = () => render(<LanguageProvider><Probe /></LanguageProvider>);

describe('LanguageProvider saved-language restore', () => {
  it('restores a persisted ja choice on mount (PR #35 regression guard)', () => {
    localStorage.setItem('awsops-lang', 'ja');
    mount();
    expect(screen.getByTestId('lang').textContent).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
  });

  it('ignores an invalid persisted value and stays on ko', () => {
    localStorage.setItem('awsops-lang', 'jp');
    mount();
    expect(screen.getByTestId('lang').textContent).toBe('ko');
    expect(document.documentElement.lang).toBe('ko');
  });

  it('defaults to ko when nothing is persisted', () => {
    mount();
    expect(screen.getByTestId('lang').textContent).toBe('ko');
  });
});
