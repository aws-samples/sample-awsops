// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import NodeDrilldownPanel from './NodeDrilldownPanel';

vi.mock('@/components/ui/DetailPanel', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/eks/NodeCapacityCards', () => ({ default: () => null }));
vi.mock('@/components/eks/NodePodsSection', () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('carries the qualified cluster through the node ENI child request', async () => {
  const cluster = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, 'http://local');
    return { ok: true, json: async () => url.pathname === '/api/eks/node-eni'
      ? { found: false }
      : { rows: url.searchParams.get('kind') === 'nodes' ? [{ name: 'same.internal' }] : [] } };
  });
  vi.stubGlobal('fetch', fetcher);
  render(<NodeDrilldownPanel cluster={cluster} nodeName="same.internal" onClose={() => {}} />);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('node-eni'))).toBe(true));
  const eniCall = fetcher.mock.calls.find(([url]) => url.includes('node-eni'))![0];
  expect(new URL(eniCall, 'http://local').searchParams.get('cluster')).toBe(cluster);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/incluster')).every(([url]) => url.includes(encodeURIComponent(cluster)))).toBe(true);
});
