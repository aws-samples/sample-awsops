// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

it.each(['infra', 'resource'])('shows retained collection warnings in the %s graph', async page => {
  vi.stubGlobal('fetch', async () => Response.json({
    nodes: [], edges: [], captured_at: '2026-09-14T10:00:00Z',
    collection: { status: 'error', stale: true, retainedPrevious: true,
      sources: [{ sourceId: 'inventory:alb', status: 'error', scope: 'aggregate' }] },
  }));
  render(page === 'infra' ? <InfraPage /> : <ResourcePage params={{ id: 'alb:one' }} />);
  const warning = await screen.findByRole('alert');
  expect(warning.textContent).toContain('Collection failed');
  expect(warning.textContent).toContain('previous graph');
});

it.each(['infra', 'resource', 'services'])('shows safe unavailable evidence for a failed %s read', async page => {
  vi.stubGlobal('fetch', async () => Response.json({ message: 'PRIVATE', collection: {
    status: 'unknown', stale: true, readStatus: 'unavailable', readReason: 'query_failed' } }, { status: 503 }));
  render(page === 'infra' ? <InfraPage /> : page === 'resource' ? <ResourcePage params={{ id: 'alb:one' }} /> : <ServicesPage />);
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
  render(<ResourcePage params={{ id: 'vpc:one' }} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } });
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0].aborted).toBe(true);
  expect((await screen.findByRole('alert')).textContent).toContain('Graph read timed out');
});

it.each(['infra', 'resource', 'services'])('shows a sign-in action for %s auth expiry', async page => {
  vi.stubGlobal('fetch', async () => Response.json({ message: 'PRIVATE' }, { status: 401 }));
  render(page === 'infra' ? <InfraPage /> : page === 'resource' ? <ResourcePage params={{ id: 'alb:one' }} /> : <ServicesPage />);
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
  render(page === 'infra' ? <InfraPage /> : page === 'resource' ? <ResourcePage params={{ id: 'vpc:one' }} /> : <ServicesPage />);
  expect((await screen.findByRole('alert')).textContent).toContain('Collection failed');
  expect(fetch).toHaveBeenCalledTimes(2);
});
