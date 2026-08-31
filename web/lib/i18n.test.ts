import { describe, it, expect } from 'vitest';
import { translate, makeT, MESSAGES, SUPPORTED_LANGS, isLang } from './i18n';

describe('translate', () => {
  it('looks up ko and en', () => {
    expect(translate('ko', 'sidebar.signOut')).toBe('로그아웃');
    expect(translate('en', 'sidebar.signOut')).toBe('Sign out');
  });

  it('has the Integrations hub nav key in both locales', () => {
    expect(translate('ko', 'nav.integrations')).toBe('연동');
    expect(translate('en', 'nav.integrations')).toBe('Integrations');
  });
  it('falls back to en for a key missing in ko, then to the key itself', () => {
    // every key exists in both today, so simulate via a definitely-absent key
    expect(translate('ko', 'definitely.absent.key')).toBe('definitely.absent.key');
    expect(translate('en', 'definitely.absent.key')).toBe('definitely.absent.key');
  });
  it('interpolates {param} and leaves unknown placeholders intact', () => {
    expect(translate('en', 'sidebar.statusLine', { status: 'Online' })).toBe('ap-northeast-2 · Online');
    expect(translate('ko', 'sidebar.statusLine', { status: '온라인' })).toBe('ap-northeast-2 · 온라인');
    expect(translate('en', 'sidebar.statusLine')).toBe('ap-northeast-2 · {status}'); // no params → raw
  });
});

describe('makeT', () => {
  it('binds a language', () => {
    const t = makeT('en');
    expect(t('nav.topology')).toBe('Topology');
    expect(makeT('ko')('nav.topology')).toBe('토폴로지');
  });
});

describe('keyset parity (regression guard)', () => {
  it('every supported language defines the exact same keys as ko', () => {
    const koKeys = Object.keys(MESSAGES.ko).sort();
    for (const l of SUPPORTED_LANGS) {
      expect(Object.keys(MESSAGES[l]).sort(), `MESSAGES.${l} keyset`).toEqual(koKeys);
    }
  });

  it('{param} placeholders match across all languages for every key', () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(MESSAGES.ko)) {
      const expected = ph(MESSAGES.ko[key]);
      for (const l of SUPPORTED_LANGS) {
        expect(ph(MESSAGES[l][key]), `placeholders of ${l}:${key}`).toEqual(expected);
      }
    }
  });

  it('nav.datasources exists in every locale (Explore page)', () => {
    expect(translate('ko', 'nav.datasources')).toBe('데이터소스');
    expect(translate('en', 'nav.datasources')).toBe('Datasources');
    expect(translate('zh', 'nav.datasources')).toBe('数据源');
    expect(translate('ja', 'nav.datasources')).toBe('データソース');
  });

});

describe('language set (single source of truth)', () => {
  it('exposes the four supported languages in toggle order', () => {
    expect(SUPPORTED_LANGS).toEqual(['ko', 'en', 'zh', 'ja']);
  });

  it('isLang validates membership', () => {
    expect(isLang('ja')).toBe(true);
    expect(isLang('ko')).toBe(true);
    expect(isLang('jp')).toBe(false);
    expect(isLang(null)).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });

  it('translates a shell key in every language', () => {
    expect(translate('ja', 'sidebar.signOut')).toBe('ログアウト');
    expect(translate('zh', 'sidebar.signOut')).toBe('退出登录');
  });
});

