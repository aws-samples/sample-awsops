// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ALL_ACCOUNTS, DEFAULT_SCOPE, setActiveScope } from '@/lib/account-context';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock('next/dynamic', () => ({ default: () => () => <div data-testid="default-flow" /> }));
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ lang: 'en', tt: (s: string) => s, t: (s: string) => s }),
}));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => 'light' }));
import TopologyPage from './page';

beforeEach(() => {
  window.localStorage.clear();
  setActiveScope(DEFAULT_SCOPE);
  window.history.replaceState({}, '', '/topology?view=e2e');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serve(fail = false) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/accounts') return Response.json({ accounts: [{ accountId: '111111111111', isHost: true }] });
    if (url.pathname === '/api/graph') return Response.json({
      class: 'trace', account: 'self', captured_at: null, nodes: [], edges: [],
      collection: { readStatus: 'unavailable', readReason: 'database_unavailable' },
    });
    if (url.pathname === '/api/nfm') return Response.json({ monitors: [], scopeCount: 0 });
    if (url.pathname === '/api/eks') return Response.json({ clusters: [], region: 'us-east-1' });
    if (url.pathname.startsWith('/api/inventory/')) {
      if (fail) return Response.json({ error: 'secret backend detail' }, { status: 503 });
      return Response.json({
        rows: url.pathname.endsWith('/alb') ? [{
          resource_id: 'fixture-alb', region: 'us-east-1', account_id: '111111111111',
          captured_at: '2026-09-15T00:00:00Z', data: {},
        }] : [],
        consistency: 'statement-snapshot',
        run: { status: 'succeeded', last_success_at: '2026-09-15T00:00:00Z', finished_at: '2026-09-15T00:00:00Z', row_count: 1 },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
}
const observations = () => vi.mocked(fetch).mock.calls.filter(([url]) => /^\/api\/(graph|nfm)/.test(String(url)));

it('mounts the opt-in view with current inventory evidence and no automatic network query', async () => {
  serve();
  render(<TopologyPage />);
  expect(await screen.findByRole('heading', { name: '서비스 + 네트워크' })).toBeTruthy();
  await screen.findByLabelText('Inventory collection evidence');
  expect(screen.getByRole('link', { name: '구성 흐름으로 돌아가기' }).getAttribute('href')).toBe('/topology');
  expect(observations()).toHaveLength(2);
  expect(screen.queryByRole('heading', { name: 'Topology' })).toBeNull();
});

it('follows URL mode changes and leaves the default view free of observation reads', async () => {
  window.history.replaceState({}, '', '/topology');
  serve();
  const view = render(<TopologyPage />);
  await screen.findByTestId('default-flow');
  expect(observations()).toHaveLength(0);
  expect(screen.getByRole('link', { name: '서비스 + 네트워크 →' })).toBeTruthy();
  window.history.pushState({}, '', '/topology?view=e2e');
  view.rerender(<TopologyPage />);
  await screen.findByRole('heading', { name: '서비스 + 네트워크' });
  await waitFor(() => expect(observations()).toHaveLength(2));
});

it.each([['123456789012'], ALL_ACCOUNTS] as const)('never reads host observations for saved scope %s', async accounts => {
  setActiveScope({ ...DEFAULT_SCOPE, accounts: typeof accounts === 'string' ? accounts : [...accounts] });
  serve();
  render(<TopologyPage />);
  await screen.findByRole('heading', { name: '서비스 + 네트워크' });
  await screen.findByLabelText('Inventory collection evidence');
  expect(observations()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: '네트워크 조회' })).toBeNull();
});

it('shows inventory failures and preserves retained evidence after refresh', async () => {
  serve();
  render(<TopologyPage />);
  await screen.findByLabelText('Inventory collection evidence');
  serve(true);
  fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
  await screen.findByText('조회 실패로 이전 결과를 표시합니다.');
  expect(screen.getByLabelText('Inventory collection evidence')).toBeTruthy();
  expect(document.body.textContent).not.toContain('secret backend detail');
  await act(async () => {});
});
