// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/account-context', () => ({ useActiveAccount: () => ['self'], accountParam: () => 'account=self' }));
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ lang: 'en', tt: (s: string) => s }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@xyflow/react', () => ({ Background: () => null, Controls: () => null, Position: {} }));
import InfraPage from './page';
import ResourcePage from '../resource/[id]/page';
import ServicesPage from '../services/page';
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('paginates the populated default VPC and clears invalid filters after implicit search scope changes', async () => {
  const resources = Array.from({ length: 7 }, (_, i) => ({ id: `app-${i}`, kind: 'ec2', label: `app-${i}` }));
  const graph = {
    nodes: [
      ...resources, { id: 'db', kind: 'rds', label: 'app-db' },
      { id: 'v0', kind: 'vpc', label: 'primary' }, { id: 'v1', kind: 'vpc', label: 'other' },
      { id: 's0', kind: 'subnet', label: 'primary-subnet' }, { id: 's1', kind: 'subnet', label: 'other-subnet' },
    ],
    edges: [
      ...resources.flatMap(n => [
        { source: n.id, target: 'v0', rel: 'infra:in_vpc' },
        { source: n.id, target: 's0', rel: 'infra:in_subnet' },
      ]),
      { source: 'db', target: 'v1', rel: 'infra:in_vpc' },
      { source: 'db', target: 's1', rel: 'infra:in_subnet' },
    ],
    captured_at: null,
  };
  vi.stubGlobal('fetch', async () => Response.json(graph));
  await act(async () => { render(<InfraPage />); });
  expect((screen.getByRole('combobox', { name: '배치 그래프 VPC' }) as HTMLSelectElement).value).toBe('v0');
  expect(screen.getByText('표시 리소스 4 / 7')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '다음 리소스' }));
  expect(screen.getByText('표시 리소스 3 / 7')).toBeTruthy();
  const search = screen.getByPlaceholderText('검색 (id · 이름 · IP · 타입)…');
  fireEvent.change(search, { target: { value: 'app' } });
  fireEvent.change(screen.getByRole('combobox', { name: '배치 그래프 서브넷' }), { target: { value: 's1' } });
  fireEvent.change(screen.getByRole('combobox', { name: '배치 그래프 리소스 종류' }), { target: { value: 'rds' } });
  expect(screen.getByText('표시 리소스 1 / 1')).toBeTruthy();
  fireEvent.change(search, { target: { value: '' } });
  await waitFor(() => expect(screen.getByText('표시 리소스 4 / 7')).toBeTruthy());
  expect((screen.getByRole('combobox', { name: '배치 그래프 서브넷' }) as HTMLSelectElement).value).toBe('');
  expect((screen.getByRole('combobox', { name: '배치 그래프 리소스 종류' }) as HTMLSelectElement).value).toBe('');
});

it('offers canonical regional choices for an ambiguous legacy resource link', async () => {
  const candidates = ['rds:@self:us-east-1:app-db', 'rds:@self:ap-northeast-2:app-db'];
  vi.stubGlobal('fetch', async () => Response.json({
    nodes: [], edges: [], captured_at: null,
    selection: { status: 'ambiguous', requested_id: 'rds:app-db', candidate_ids: candidates },
    collection: { status: 'unknown', stale: true, sources: [] },
  }));
  await act(async () => { render(<ResourcePage params={Promise.resolve({ id: 'rds:app-db' })} />); });
  expect((await screen.findByText(/리소스 선택이 모호합니다/)).closest('[role="alert"]')).toBeTruthy();
  for (const id of candidates) expect(screen.getByRole('link', { name: id }).getAttribute('href'))
    .toBe(`/topology/resource/${encodeURIComponent(id)}`);
});

it.each(['infra', 'resource'])('shows retained collection warnings in the %s graph', async page => {
  vi.stubGlobal('fetch', async () => Response.json({
    nodes: [], edges: [], captured_at: '2026-09-14T10:00:00Z',
    collection: { status: 'error', stale: true, retainedPrevious: true,
      sources: [{ sourceId: 'inventory:alb', status: 'error', scope: 'aggregate' }] },
  }));
  await act(async () => { render(page === 'infra' ? <InfraPage /> : <ResourcePage params={Promise.resolve({ id: 'alb:one' })} />); });
  const warning = await screen.findByRole('alert');
  expect(warning.textContent).toContain('Collection failed');
  expect(warning.textContent).toContain('previous graph');
});

it.each(['infra', 'resource', 'services'])('shows safe unavailable evidence for a failed %s read', async page => {
  vi.stubGlobal('fetch', async () => Response.json({ message: 'PRIVATE', collection: {
    status: 'unknown', stale: true, readStatus: 'unavailable', readReason: 'query_failed' } }, { status: 500 }));
  await act(async () => { render(page === 'infra' ? <InfraPage /> : page === 'resource' ? <ResourcePage params={Promise.resolve({ id: 'alb:one' })} /> : <ServicesPage />); });
  const warning = await screen.findByRole('alert');
  expect(warning.textContent).toContain('Graph read unavailable');
  expect(document.body.textContent).not.toContain('PRIVATE');
  expect(document.body.textContent).not.toContain('503');
  expect(warning.textContent).not.toContain('Collection failed');
});

it('aborts the obsolete resource-depth fetch before displaying the latest read result', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', (_url: string, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    return signals.length === 1 ? new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }) : Promise.resolve(Response.json({
      collection: { status: 'unknown', readReason: 'timeout' } }, { status: 500 }));
  });
  await act(async () => { render(<ResourcePage params={Promise.resolve({ id: 'vpc:one' })} />); });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } });
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0].aborted).toBe(true);
  expect((await screen.findByRole('alert')).textContent).toContain('Graph read timed out');
});

it.each(['infra', 'resource', 'services'])('shows a sign-in action for %s auth expiry', async page => {
  vi.stubGlobal('fetch', async () => Response.json({ message: 'PRIVATE' }, { status: 401 }));
  await act(async () => { render(page === 'infra' ? <InfraPage /> : page === 'resource' ? <ResourcePage params={Promise.resolve({ id: 'alb:one' })} /> : <ServicesPage />); });
  expect((await screen.findByRole('alert')).textContent).toContain('Session expired');
  expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
  expect(document.body.textContent).not.toContain('Graph read unavailable');
  expect(document.body.textContent).not.toContain('PRIVATE');
});

it.each(['infra','resource','services'])('recovers a typed busy response automatically on %s', async page => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ collection: { readStatus: 'unavailable', readReason: 'busy' } }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ nodes: [], edges: [], captured_at: null,
      collection: { status: 'error', stale: true, retainedPrevious: true, sources: [] } }));
  vi.stubGlobal('fetch', fetch);
  await act(async () => { render(page === 'infra' ? <InfraPage /> : page === 'resource' ? <ResourcePage params={Promise.resolve({ id: 'vpc:one' })} /> : <ServicesPage />); });
  expect((await screen.findByRole('alert')).textContent).toContain('Collection failed');
  expect(fetch).toHaveBeenCalledTimes(2);
});
