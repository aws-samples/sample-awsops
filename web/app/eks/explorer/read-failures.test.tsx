// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FleetKindPage from '@/components/eks/FleetKindPage';
import EksExplorerPage from './page';
import { setActiveScope } from '@/lib/account-context';

const ID = 'arn:aws:eks:ap-northeast-2:222222222222:cluster/shared';
const GOOD_ID = 'arn:aws:eks:us-west-2:333333333333:cluster/shared';
const json = (body: unknown, status = 200) => Response.json(body, { status });
const primaryRow = {
  name: 'primary-row', namespace: 'default', status: 'Ready', roles: 'worker', type: 'ClusterIP',
  cpuCapacity: 4, cpuAllocatable: 3, memCapacity: 8192, memAllocatable: 7168,
};
const failures = [
  { reason: 'denied', message: 'EKS resources are unavailable. Access denied; check read permissions.' },
  { reason: 'unreachable', message: 'EKS resources are unavailable. Endpoint unreachable; check network connectivity and DNS.' },
  { reason: 'timeout', message: 'EKS resources are unavailable. Request timed out; check connectivity and retry.' },
  { reason: 'upstream-error', message: 'EKS resources are unavailable.' },
];
const pages = [
  { name: 'FleetKindPage', page: () => <FleetKindPage kind="pods" /> },
  { name: 'explorer', page: () => <EksExplorerPage /> },
];
beforeEach(() => {
  localStorage.clear();
  setActiveScope({ accounts: ['222222222222', '333333333333'], regions: ['ap-northeast-2', 'us-west-2'], includeGlobal: true });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function serve(failed: (url: URL) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://x');
    if (url.pathname === '/api/eks') return json({ clusters: [
      { id: ID, name: 'shared', access: 'connected' }, { id: GOOD_ID, name: 'shared', access: 'connected' },
    ] });
    if (decodeURIComponent(url.pathname).includes(ID)) return failed(url);
    return json({ rows: [{ ...primaryRow, name: 'healthy-row', status: 'Running' }] });
  }));
}

describe.each(pages)('$name classified reads', ({ page }) => {
  it.each(failures)('retains the failed cluster identity and safe $reason message while showing other rows', async ({ reason, message }) => {
    serve(() => json({ status: 'error', reason, message }, 502));
    render(page());
    await waitFor(() => expect(screen.getByText(message, { exact: false })).toBeTruthy());
    expect(screen.getByText(message, { exact: false }).textContent).toContain('222222222222');
    expect(screen.getByText(message, { exact: false }).textContent).toContain(reason);
    expect(screen.getAllByText('healthy-row').length).toBeGreaterThan(0);
    expect(screen.queryByText(/일부 kind는 클러스터 RBAC 갱신 필요/)).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === `/api/eks/${encodeURIComponent(ID)}/incluster?kind=pods`)).toBe(true);
  });

  it('does not turn a browser transport failure into RBAC advice or expose the thrown detail', async () => {
    serve(() => Promise.reject(new Error('PRIVATE_NETWORK_BODY')));
    render(page());
    await waitFor(() => expect(screen.getByText(/Endpoint unreachable; check network connectivity and DNS/)).toBeTruthy());
    expect(screen.queryByText(/PRIVATE_NETWORK_BODY|RBAC 갱신/)).toBeNull();
  });

  it('ignores a classified failure that resolves after switching the account scope', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    let switched = false;
    serve(() => switched ? json({ rows: [{ ...primaryRow, name: 'current-row' }] }) : pending);
    render(page());
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/incluster?kind=pods'))).toBe(true));
    switched = true;
    act(() => setActiveScope({ accounts: ['333333333333'], regions: ['us-west-2'], includeGlobal: true }));
    await screen.findAllByText('current-row');
    await act(async () => resolve(json({ status: 'error', reason: 'denied', message: 'OLD_SCOPE_FAILURE' }, 403)));
    expect(screen.queryByText(/OLD_SCOPE_FAILURE/)).toBeNull();
  });
});

it.each(['nodes', 'services'] as const)('FleetKindPage also retains a failed pods dependency for %s', async kind => {
  serve(url => url.searchParams.get('kind') === 'pods'
    ? json({ status: 'error', ...failures[2] }, 504)
    : json({ rows: [primaryRow] }));
  render(<FleetKindPage kind={kind} />);
  await waitFor(() => expect(screen.getByText(failures[2].message, { exact: false })).toBeTruthy());
  expect(screen.getByText(failures[2].message, { exact: false }).textContent).toContain('222222222222');
  expect(screen.getAllByText('primary-row').length).toBeGreaterThan(0);
});
