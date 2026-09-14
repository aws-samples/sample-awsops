// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/account-context', () => ({ useActiveAccount: () => ['self'], accountParam: () => 'account=self' }));
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ lang: 'en', tt: (s: string) => s }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@xyflow/react', () => ({ Background: () => null, Controls: () => null, Position: {} }));
import InfraPage from './page';
import ResourcePage from '../resource/[id]/page';
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
