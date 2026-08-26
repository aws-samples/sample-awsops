// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  accountParam,
  getActiveAccount,
  setActiveAccount,
  ALL_ACCOUNTS,
  ALL_REGIONS,
  getActiveScope,
  setActiveScope,
  scopeParams,
} from './account-context';

beforeEach(() => { window.localStorage.clear(); });

describe('accountParam', () => {
  it('host/self/empty → empty (default creds)', () => {
    expect(accountParam('self')).toBe('');
    expect(accountParam('')).toBe('');
  });
  it('target account → account=<id>', () => {
    expect(accountParam('210987654321')).toBe('account=210987654321');
  });
  it('all accounts → account=__all__', () => {
    expect(accountParam(ALL_ACCOUNTS)).toBe('account=__all__');
  });
});

describe('getActiveAccount / setActiveAccount', () => {
  it('defaults to self', () => {
    expect(getActiveAccount()).toBe('self');
  });
  it('persists the selection', () => {
    setActiveAccount('210987654321');
    expect(getActiveAccount()).toBe('210987654321');
  });
  it('broadcasts an awsops:accountchange event', () => {
    let fired = '';
    window.addEventListener('awsops:accountchange', (e) => { fired = (e as CustomEvent).detail.id; });
    setActiveAccount('__all__');
    expect(fired).toBe('__all__');
  });
});

describe('getActiveScope / setActiveScope', () => {
  it('defaults to host, all enabled regions, and global services included', () => {
    expect(getActiveScope()).toEqual({
      accounts: ['self'],
      regions: ALL_REGIONS,
      includeGlobal: true,
    });
  });

  it('persists and broadcasts structured scope selections', () => {
    let fired: unknown = null;
    window.addEventListener('awsops:scopechange', (e) => { fired = (e as CustomEvent).detail.scope; });

    const scope = {
      accounts: ['self', '210987654321'],
      regions: ['ap-northeast-2', 'us-east-1'],
      includeGlobal: false,
    };

    setActiveScope(scope);

    expect(getActiveScope()).toEqual(scope);
    expect(fired).toEqual(scope);
  });

  it('falls back to a valid default when localStorage contains malformed scope JSON', () => {
    window.localStorage.setItem('awsops:scope', '{"accounts":[],"regions":[],"includeGlobal":"yes"}');

    expect(getActiveScope()).toEqual({
      accounts: ['self'],
      regions: ALL_REGIONS,
      includeGlobal: true,
    });
  });
});

describe('scopeParams', () => {
  it('serializes host defaults without an account query param but keeps region/global intent', () => {
    expect(scopeParams({ accounts: ['self'], regions: ALL_REGIONS, includeGlobal: true })).toBe(
      'regions=__all__&includeGlobal=1',
    );
  });

  it('serializes all accounts and multiple regions', () => {
    expect(scopeParams({
      accounts: ALL_ACCOUNTS,
      regions: ['ap-northeast-2', 'us-east-1'],
      includeGlobal: false,
    })).toBe('accounts=__all__&regions=ap-northeast-2%2Cus-east-1&includeGlobal=0');
  });
});
