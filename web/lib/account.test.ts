import { describe, it, expect, beforeEach } from 'vitest';
import { currentAccountId, currentAccountAlias } from './account';

beforeEach(() => {
  delete process.env.HOST_ACCOUNT_ID;
  delete process.env.HOST_ACCOUNT_ALIAS;
});

describe('currentAccountId', () => {
  it("returns HOST_ACCOUNT_ID when set", () => {
    process.env.HOST_ACCOUNT_ID = '123456789012';
    expect(currentAccountId()).toBe('123456789012');
  });

  it("trims surrounding whitespace", () => {
    process.env.HOST_ACCOUNT_ID = '  123456789012  ';
    expect(currentAccountId()).toBe('123456789012');
  });

  it("falls back to 'self' when unset (Phase-1 single-account convention)", () => {
    expect(currentAccountId()).toBe('self');
  });

  it("falls back to 'self' when blank/whitespace-only", () => {
    process.env.HOST_ACCOUNT_ID = '   ';
    expect(currentAccountId()).toBe('self');
  });
});

describe('currentAccountAlias', () => {
  it('returns the alias when set', () => {
    process.env.HOST_ACCOUNT_ALIAS = 'prod-fsi';
    expect(currentAccountAlias()).toBe('prod-fsi');
  });

  it('trims surrounding whitespace', () => {
    process.env.HOST_ACCOUNT_ALIAS = '  prod-fsi  ';
    expect(currentAccountAlias()).toBe('prod-fsi');
  });

  it('returns undefined when unset', () => {
    expect(currentAccountAlias()).toBeUndefined();
  });

  it('returns undefined when blank/whitespace-only', () => {
    process.env.HOST_ACCOUNT_ALIAS = '   ';
    expect(currentAccountAlias()).toBeUndefined();
  });
});
