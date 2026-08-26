import { describe, it, expect } from 'vitest';
import { MOBILE_TABS, isTabActive } from './mobile-tabs';

// Resolve tabs by tkey for readable assertions.
const byKey = (key: string) => {
  const tab = MOBILE_TABS.find((t) => t.tkey === key);
  if (!tab) throw new Error(`no tab with tkey ${key}`);
  return tab;
};

describe('MOBILE_TABS', () => {
  it('has the five expected tabs in order', () => {
    expect(MOBILE_TABS.map((t) => t.tkey)).toEqual([
      'nav.overview',
      'nav.cost',
      'nav.inventory',
      'nav.assistant',
      'nav.more',
    ]);
  });

  it('resolves the Inventory tab to the first inventory type', () => {
    // first inventory type is ec2 (Compute group, first key)
    expect(byKey('nav.inventory').href).toBe('/inventory/ec2');
  });

  it('the More tab is a drawer action, not a link', () => {
    const more = byKey('nav.more');
    expect(more.action).toBe('drawer');
    expect(more.href).toBeUndefined();
  });
});

describe('isTabActive', () => {
  it('Overview is active only on the exact root path', () => {
    expect(isTabActive('/', byKey('nav.overview'))).toBe(true);
    expect(isTabActive('/cost', byKey('nav.overview'))).toBe(false);
    expect(isTabActive('/inventory/ec2', byKey('nav.overview'))).toBe(false);
  });

  it('Cost is active on /cost', () => {
    expect(isTabActive('/cost', byKey('nav.cost'))).toBe(true);
    expect(isTabActive('/', byKey('nav.cost'))).toBe(false);
  });

  it('Inventory is active for any /inventory/... path', () => {
    expect(isTabActive('/inventory/ec2', byKey('nav.inventory'))).toBe(true);
    expect(isTabActive('/inventory/s3', byKey('nav.inventory'))).toBe(true);
    expect(isTabActive('/inventory', byKey('nav.inventory'))).toBe(true);
    expect(isTabActive('/cost', byKey('nav.inventory'))).toBe(false);
  });

  it('Assistant is active on /assistant', () => {
    expect(isTabActive('/assistant', byKey('nav.assistant'))).toBe(true);
    expect(isTabActive('/eks', byKey('nav.assistant'))).toBe(false);
  });

  it('no tab is active on an unrelated route (/eks → drawer territory)', () => {
    for (const tab of MOBILE_TABS) {
      expect(isTabActive('/eks', tab)).toBe(false);
    }
  });

  it('the drawer tab is never active', () => {
    expect(isTabActive('/', byKey('nav.more'))).toBe(false);
    expect(isTabActive('/more', byKey('nav.more'))).toBe(false);
  });
});
