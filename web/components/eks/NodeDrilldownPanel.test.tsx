// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import NodeDrilldownPanel from './NodeDrilldownPanel';

vi.mock('@/components/ui/DetailPanel', () => ({ default: ({ children, data }: { children: ReactNode; data?: unknown }) => <div><pre>{JSON.stringify(data)}</pre>{children}</div> }));
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

it('uses the caller-provided EC2/node-group row without re-listing nodes', async () => {
  const fetcher = vi.fn(async (input: string) => ({ ok: true, json: async () => (input.includes('node-eni') ? { found: false } : { rows: [] }) }));
  vi.stubGlobal('fetch', fetcher);
  const row = { name: 'ip-1.ec2.internal', status: 'EC2 running', source: 'aws-api' as const, roles: '', version: '', instanceType: 'm7g.large', zone: 'a', age: '1d',
    cpuCapacity: 2, cpuAllocatable: 2, memCapacity: 8192, memAllocatable: 8192, diskCapacity: 0, diskAllocatable: 0 };
  render(<NodeDrilldownPanel cluster="arn:aws:eks:us-west-2:222222222222:cluster/shared" nodeName={row.name} node={row} onClose={() => {}} />);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('kind=pods'))).toBe(true));
  expect(fetcher.mock.calls.some(([url]) => url.includes('kind=nodes'))).toBe(false);
});

it('reports a denied node read (route 502 + reason denied) as kubelet details unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => (input.includes('kind=nodes')
    ? { ok: false, status: 502, json: async () => ({ status: 'error', reason: 'denied', message: 'EKS resources are unavailable. Access denied; check read permissions.' }) }
    : { ok: true, json: async () => ({ rows: [] }) })));
  const { findByText } = render(<NodeDrilldownPanel cluster="c" nodeName="n" onClose={() => {}} />);
  await findByText(/kubelet 상세 정보 없음/);
});

