import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Task 28 — nav contract: the Integrations hub replaces the standalone Datasources + Custom Agents
// entries across all three nav surfaces. A source-level assertion (Sidebar pulls in many providers that
// would make a render test heavy) locks the contract so a regression fails CI.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('nav fold-in to the Integrations hub', () => {
  it('Sidebar FIXED has /integrations and not the standalone /datasources or /customization', () => {
    const src = read('./Sidebar.tsx');
    const fixed = src.slice(src.indexOf('const FIXED'), src.indexOf('];', src.indexOf('const FIXED')));
    expect(fixed).toContain("'/integrations'");
    expect(fixed).not.toContain("'/datasources'");
    expect(fixed).not.toContain("'/customization'");
  });

  it('CommandPalette quick-nav points to /integrations, not /datasources', () => {
    const src = read('./CommandPalette.tsx');
    expect(src).toContain("'/integrations'");
    expect(src).not.toContain("href: '/datasources'");
  });
});

// Accordion contract — behaviour (navTree shaping, path resolution) is unit-tested in
// lib/inventory-types.test.ts; here we lock the Sidebar's structural contract at the
// source level (rendering Sidebar pulls AccountSelector/providers → too heavy for jsdom).
describe('collapsible inventory groups', () => {
  const src = read('./Sidebar.tsx');
  it('mounts the account/region ScopeSelector in the sidebar', () => {
    expect(src).toContain("from '@/components/shell/ScopeSelector'");
    expect(src).toContain('<ScopeSelector />');
    expect(src).not.toContain("from '@/components/shell/AccountSelector'");
  });

  it('drives the grouped nav from navTree() (not the flat inventoryGroups)', () => {
    expect(src).toContain("from '@/lib/inventory-types'");
    expect(src).toMatch(/\bnavTree\(\)/);
    expect(src).toMatch(/\bgroupForPath\b/);
  });
  it('renders a chevron toggle button with aria-expanded + conditional aria-controls', () => {
    expect(src).toContain('aria-expanded={open}');
    expect(src).toContain('aria-controls={open ? panelId : undefined}'); // no dangling ref when unmounted
    expect(src).toMatch(/type="button"/);
  });
  it('only the owner instance persists (drawer passes persist=false)', () => {
    expect(src).toContain('persist = true');
    expect(src).toContain('if (!persist || !hydrated) return');
  });
  it('scopes accordion panel ids per instance via useId (dual-mounted sidebars must not collide)', () => {
    expect(src).toMatch(/\buseId\b/);
    expect(src).toContain('${uid}-panel-'); // group panel id is instance-scoped
    expect(src).toContain('${uid}-sub-');   // subgroup panel id is instance-scoped
    expect(src).not.toContain('`nav-panel-'); // no static (collision-prone) id
  });
  it('unmounts collapsed panels (so links leave the tab order)', () => {
    expect(src).toContain('{open && (');
    expect(src).toContain('{subOpen && (');
  });
  it('persists expand state under a namespaced localStorage key', () => {
    expect(src).toContain("'awsops:nav:expanded'");
  });
  it('keeps the FIXED feature list pinned and untouched (still /integrations)', () => {
    const fixed = src.slice(src.indexOf('const FIXED'), src.indexOf('];', src.indexOf('const FIXED')));
    expect(fixed).toContain("'/integrations'");
  });
});
