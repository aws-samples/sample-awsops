// @vitest-environment jsdom
// `/topology` (and its alias `?view=site`) mounts SiteFlowView from TopologyScope (keyed by the inventory scope) so the default
// flow page's own inventory load never runs alongside the view's.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SCOPE, setActiveScope } from '@/lib/account-context';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock('next/dynamic', () => ({ default: () => () => <div data-testid="default-flow" /> }));
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ lang: 'en', tt: (s: string) => s, t: (s: string) => s }),
}));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => 'light' }));
const site = vi.hoisted(() => ({ scopes: [] as string[] }));
vi.mock('@/components/topology/SiteFlowView', () => ({
  default: ({ inventoryScope }: { inventoryScope: string }) => {
    site.scopes.push(inventoryScope);
    return <div data-testid="site-view">{inventoryScope}</div>;
  },
}));
import TopologyPage from './page';

beforeEach(() => {
  window.localStorage.clear();
  site.scopes = [];
  setActiveScope(DEFAULT_SCOPE);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ rows: [] })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('mounts the site view with the page inventory scope and no page-level inventory load', async () => {
  window.history.replaceState({}, '', '/topology?view=site&host=mall.example.com');
  render(<TopologyPage />);
  expect(await screen.findByTestId('site-view')).toBeTruthy();
  expect(site.scopes.at(-1)).toBe('accounts=self&regions=__all__&includeGlobal=1');
  await new Promise((r) => setTimeout(r, 20));
  expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).startsWith('/api/inventory/'))).toHaveLength(0);
  expect(screen.queryByRole('heading', { name: 'Topology' })).toBeNull();
});

it('offers the site view from the flow graph as plain /topology', async () => {
  window.history.replaceState({}, '', '/topology?view=flow');
  render(<TopologyPage />);
  const link = await screen.findByRole('link', { name: '사이트 흐름 →' });
  expect(link.getAttribute('href')).toBe('/topology');
  expect(screen.queryByTestId('site-view')).toBeNull();
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith('/api/inventory/'))).toBe(true));
});

it.each(['/topology', '/topology?view=site', '/topology?host=mall.example.com', '/topology?foo=bar'])('opens the site view at %s', async (url) => {
  window.history.replaceState({}, '', url);
  render(<TopologyPage />);
  expect(await screen.findByTestId('site-view')).toBeTruthy();
  expect(screen.queryByRole('link', { name: '사이트 흐름 →' })).toBeNull();
});

it.each([
  '/topology?view=flow', '/topology?view=e2e', '/topology?lens=service', '/topology?cluster=ecs%3Aecs-app',
  '/topology?monitor=m&range=1800', '/topology?metric=bytes', '/topology?category=ALL',
])('keeps the old flow graph at %s', async (url) => {
  window.history.replaceState({}, '', url);
  render(<TopologyPage />);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith('/api/inventory/'))).toBe(true));
  expect(screen.queryByTestId('site-view')).toBeNull();
});
