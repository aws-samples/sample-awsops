import { describe, it, expect } from 'vitest';
import { normalizeChatLang, chatMsg } from './chat-i18n';
import { SUPPORTED_LANGS } from './i18n';

describe('normalizeChatLang', () => {
  it('passes every supported language through', () => {
    for (const l of SUPPORTED_LANGS) expect(normalizeChatLang(l)).toBe(l);
  });

  it('collapses unknown/absent values to ko', () => {
    expect(normalizeChatLang('jp')).toBe('ko');
    expect(normalizeChatLang('')).toBe('ko');
    expect(normalizeChatLang(undefined)).toBe('ko');
    expect(normalizeChatLang(42)).toBe('ko');
  });
});

describe('chatMsg templates', () => {
  it('every template yields a distinct non-empty string per language', () => {
    const simple = [
      (l: (typeof SUPPORTED_LANGS)[number]) => chatMsg.allRoutesFailed(l),
      (l: (typeof SUPPORTED_LANGS)[number]) => chatMsg.fallbackNotice(l),
      (l: (typeof SUPPORTED_LANGS)[number]) => chatMsg.codeExecHeader(l),
      (l: (typeof SUPPORTED_LANGS)[number]) => chatMsg.codeExecFailed(l),
    ];
    for (const fn of simple) {
      const out = SUPPORTED_LANGS.map(fn);
      out.forEach((s) => expect(s.length).toBeGreaterThan(0));
      expect(new Set(out).size).toBe(SUPPORTED_LANGS.length);
    }
  });

  it('parameterized templates interpolate in every language', () => {
    for (const l of SUPPORTED_LANGS) {
      expect(chatMsg.unavailablePin(l, 'net-agent')).toContain('net-agent');
      expect(chatMsg.inactiveSection(l, 'Cost', 'Ops')).toContain('Cost');
    }
  });

  it('ja fallback notice is Japanese, not Korean', () => {
    expect(chatMsg.fallbackNotice('ja')).toContain('リアルタイム');
    expect(chatMsg.fallbackNotice('ja')).not.toContain('실시간');
  });
});
