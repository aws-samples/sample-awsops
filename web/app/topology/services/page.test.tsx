// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ lang: 'en', tt: (s: string) => s }),
}));
// Exercise the real page labels, filtering and navigation without a layout-dependent canvas.
vi.mock('next/dynamic', () => ({
  default: () => ({ nodes, onNodeClick }: any) => <div>
    {nodes.map((node: any) => <button key={node.id} onClick={() => onNodeClick(null, node)}>{node.data.label}</button>)}
  </div>,
}));
vi.mock('@xyflow/react', () => ({ Background: () => null, Controls: () => null, Position: {} }));
import ServiceMapPage from './page';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockReset(); });

it('labels queue attribution as unverified telemetry and never navigates it into AWS inventory', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    nodes: [{ id: 'queue:1', kind: 'queue', label: 'orders', meta: {
      environment: 'prod', sourceId: 'tempo:1', identityProvenance: 'aws_verified',
      claimedAccountId: '111122223333', claimedRegion: 'us-east-1',
      infra_ref: 'inventory:queue', cluster: 'claimed-cluster',
    } }], edges: [], captured_at: null,
  }) })));
  render(<ServiceMapPage />);
  const queue = await screen.findByRole('button', { name: /queue: orders/ });
  expect(queue.textContent).toContain('Telemetry claim');
  expect(queue.textContent).toContain('AWS identity unverified');
  fireEvent.click(queue);
  expect(push).not.toHaveBeenCalled();
});
