// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import EksClusterPage from './page';
import { setActiveScope } from '@/lib/account-context';

const route = vi.hoisted(() => ({ cluster: 'arn:aws:eks:us-east-1:222222221802:cluster/shared' }));
vi.mock('next/navigation', () => ({ useParams: () => route }));
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const ID = 'arn:aws:eks:us-east-1:222222221802:cluster/shared';
beforeEach(() => {
  route.cluster = ID;
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.endsWith('/api/me')) return response({ isAdmin: false, groups: [] });
    if (input.includes('/incluster?kind=nodes')) return response({ rows: [] });
    if (input.includes('/incluster?kind=pods')) return response({ rows: [{ name: 'selected-pod', namespace: 'default', status: 'Running' }] });
    if (input.includes('/k8sgpt')) return response({ enabled: false, findings: [] });
    return response({ available: false, installed: false, ready: false, valuesYaml: '', installSh: '' });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the cluster name with account context while requests and child APIs keep the canonical ID', async () => {
  render(<EksClusterPage />);
  await waitFor(() => expect(screen.getByRole('heading', { name: /shared/ })).toBeTruthy());
  const heading = screen.getByRole('heading', { name: /shared/ });
  expect(heading.textContent).not.toContain('arn:');
  expect(heading.textContent).toContain('222222221802');
  expect(heading.textContent).toContain('us-east-1');
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === `/api/eks/${encodeURIComponent(ID)}/incluster?kind=nodes`)).toBe(true);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === `/api/opencost/${encodeURIComponent(ID)}/status`)).toBe(true));
  fireEvent.click(screen.getByRole('tab', { name: 'Cost' }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === `/api/opencost/${encodeURIComponent(ID)}/allocation`)).toBe(true));
  fireEvent.click(screen.getByRole('tab', { name: 'Diagnosis' }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === `/api/eks/${encodeURIComponent(ID)}/k8sgpt`)).toBe(true));
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('%253A'))).toBe(false);
});

it('decodes Next14 client route params once before encoding cluster and child API paths', async () => {
  route.cluster = 'arn%3Aaws%3Aeks%3Aap-northeast-2%3A222222222222%3Acluster%2Ffsi-demo-cluster';
  render(<EksClusterPage />);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) =>
    url === '/api/eks/arn%3Aaws%3Aeks%3Aap-northeast-2%3A222222222222%3Acluster%2Ffsi-demo-cluster/incluster?kind=nodes',
  )).toBe(true));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) =>
    url === '/api/opencost/arn%3Aaws%3Aeks%3Aap-northeast-2%3A222222222222%3Acluster%2Ffsi-demo-cluster/status',
  )).toBe(true));
  expect(screen.getByRole('heading', { name: /fsi-demo-cluster/ }).textContent).toBe(
    'fsi-demo-cluster (222222222222 / ap-northeast-2)',
  );
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('%25'))).toBe(false);
});

it.each([
  '%',
  '%E0%A4%A',
  'arn%3Aaws%3Aeks%3Aus-east-1%3A222222221802%3Acluster%2Fshared%ZZ',
  'arn%253Aaws%253Aeks%253Aus-east-1%253A222222221802%253Acluster%252Fshared',
  '%2F',
])('rejects malformed or multiply encoded route value %s without fetching a host cluster or crashing', (value) => {
  route.cluster = value;
  expect(() => render(<EksClusterPage />)).not.toThrow();
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it('preserves legacy bare cluster names', async () => {
  route.cluster = 'legacy-host';
  render(<EksClusterPage />);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) =>
    url === '/api/eks/legacy-host/incluster?kind=nodes',
  )).toBe(true));
  expect(screen.getByRole('heading', { name: 'legacy-host' })).toBeTruthy();
});

it('clears a selected detail when account/region scope changes even for the same URL', async () => {
  render(<EksClusterPage />);
  fireEvent.click(screen.getByRole('tab', { name: 'Pods' }));
  fireEvent.click((await screen.findAllByText('selected-pod'))[0]);
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  act(() => setActiveScope({ accounts: ['222222221802'], regions: ['us-east-1'], includeGlobal: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('passes the URL cluster identity into node ENI lookups', async () => {
  const fallback = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith('/incluster?kind=nodes')
    ? Promise.resolve(response({ rows: [{
      name: 'same-private-node', roles: 'worker', status: 'Ready', cpuCapacity: 4, cpuAllocatable: 3,
      memCapacity: 8192, memAllocatable: 7168,
    }] }))
    : fallback(input, init));
  render(<EksClusterPage />);
  fireEvent.click((await screen.findAllByText('same-private-node')).find((element) => element.closest('tr'))!);
  await waitFor(() => {
    const eni = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url), 'http://localhost')).find((url) => url.pathname === '/api/eks/node-eni');
    expect(eni?.searchParams.get('cluster')).toBe(ID);
    expect(eni?.searchParams.get('node')).toBe('same-private-node');
  });
});
