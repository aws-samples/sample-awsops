// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SCOPE, setActiveScope } from '@/lib/account-context';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock('next/dynamic', () => ({ default: () => () => <div data-testid="default-flow" /> }));
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ lang: 'en', tt: (s: string) => s, t: (s: string) => s }) }));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => 'light' }));
vi.mock('@/components/topology/E2eGraphCanvas', () => ({ default: ({ graph }: { graph: import('@/lib/e2e-topology-types').E2eGraph }) => <output data-testid="actual-composed-graph">{JSON.stringify({ summary: graph.summary, identity: graph.edges.filter((e) => e.evidence === 'identity') })}</output> }));
import TopologyPage from '@/app/topology/page';
const END = '2026-09-15T00:15:00Z';
const region = 'us-east-1', vpcId = 'vpc-demo', ip = '10.0.1.10';
const lb = ['a', 'b'].map(x => ({ resource_id: x, region, data: { arn: `arn:fixture:lb:${x}`, dns_name: `lb-${x}.example.test` } }));
const rows: Record<string, { resource_id: string; region: string; data: object }[]> = { alb: lb, target_group: lb.map((l, i) => ({ resource_id: `tg-${i}`, region, data: { vpc_id: vpcId, target_type: 'ip', load_balancer_arns: [l.data.arn], target_health_descriptions: [{ Target: { Id: ip, Port: 443 } }] } })) };
function readGraph() { return JSON.parse(screen.getByTestId('actual-composed-graph').textContent!); }
let quality: 'healthy' | 'missing-run' | 'running' | 'missing-capture' = 'healthy';
beforeEach(() => {
 quality = 'healthy';
 localStorage.clear(); setActiveScope(DEFAULT_SCOPE);
 window.history.replaceState({}, '', '/topology');
 vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', () => {});
 vi.stubGlobal('fetch', vi.fn(async (input: string) => {
  const url = new URL(input, 'http://localhost');
  if (url.pathname.startsWith('/api/inventory/')) return Response.json({
   rows: (rows[url.pathname.split('/').pop()!] ?? []).map(row => ({ ...row, account_id: 'self',
    captured_at: quality === 'missing-capture' && url.pathname.endsWith('/alb') ? null : END })),
   consistency: 'statement-snapshot', run: quality === 'missing-run' && url.pathname.endsWith('/alb') ? null
    : { status: quality === 'running' && url.pathname.endsWith('/alb') ? 'running' : 'succeeded', finished_at: END, last_success_at: END, row_count: 2 },
  });
  if (url.pathname === '/api/eks') return Response.json({ clusters: [], region });
  if (url.pathname === '/api/accounts') return Response.json({ accounts: [{ accountId: '111111111111', isHost: true }] });
    if (url.pathname === '/api/graph') return Response.json({ class: 'trace', account: 'self', nodes: [], edges: [], captured_at: null });
  if (url.pathname === '/api/nfm') return Response.json({ monitors: [{ name: 'nfm-vpc-all', status: 'ACTIVE', cluster: null }], scopeCount: 1 });
  if (url.pathname === '/api/nfm/query') {
   const category = url.searchParams.get('category');
   return Response.json({ monitor: 'nfm-vpc-all', metric: 'DATA_TRANSFERRED', category, range: 900, unit: 'Bytes', capped: false,
    startTime: '2026-09-15T00:00:00Z', endTime: END, queriedAt: END,
    rows: [{ local: { ip, region, vpcId }, remote: { ip: '10.0.2.20', region, vpcId }, value: 100, unit: 'Bytes', category, traversed: [], traversedIds: [] }],
   });
  }
  throw new Error(`unexpected ${url}`);
 }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each(['healthy', 'missing-run', 'running', 'missing-capture'] as const)(
 'configuration completeness reflects non-critical inventory quality: %s', async state => {
  quality = state;
  window.history.replaceState({}, '', '/topology?view=e2e');
  render(<TopologyPage />);
  await screen.findByLabelText('Inventory collection evidence');
  await waitFor(() => expect(readGraph().summary.configuredNodes).toBeGreaterThan(0));
  expect(readGraph().summary.configurationComplete).toBe(state === 'healthy');
 });
it.each([false, true])('entry preference %s cannot discard competing configured candidates', async filtered => {
 const view = render(<TopologyPage />);
 await screen.findByTestId('default-flow');
 await screen.findByLabelText('Inventory collection evidence');
 if (filtered) {
  const entry = screen.getAllByRole('combobox').find(select => [...(select as HTMLSelectElement).options].some(option => option.value === 'alb:arn:fixture:lb:a'))!;
  fireEvent.change(entry, { target: { value: 'alb:arn:fixture:lb:a' } });
 }
 window.history.pushState({}, '', '/topology?view=e2e'); view.rerender(<TopologyPage />);
 await waitFor(() => expect((screen.getByRole('button', { name: '네트워크 조회' }) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.change(screen.getByRole('combobox', { name: '목적지 분류' }), { target: { value: 'INTER_AZ' } });
 fireEvent.click(screen.getByRole('button', { name: '네트워크 조회' }));
 await screen.findByRole('region', { name: '적용된 네트워크 조회' });
 const result = readGraph();
 expect(result.summary.ambiguousEndpoints).toBe(1);
 expect(result.identity).toHaveLength(0);
});
