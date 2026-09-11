// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { DEFAULT_SCOPE, setActiveScope } from '@/lib/account-context';
import TopologyPage from './page';

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
class DOMMatrixReadOnlyStub { m22 = 1; }
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body));
const region = 'us-east-1';
function serve() {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    requests.push(url);
    if (url.pathname === '/api/eks') return json({ clusters: [] });
    if (url.pathname === '/api/nfm') return json({ monitors: [], scopeCount: 0 });
    if (url.pathname === '/api/graph') return json({
      class: 'trace', account: 'self', captured_at: null, nodes: [], edges: [],
    });
    if (url.pathname.startsWith('/api/inventory/')) {
      const rows: Record<string, unknown>[] = [];
      if (url.pathname.endsWith('/target_group')) rows.push({
        resource_id: 'tg-orders', region, data: {
          target_type: 'ip', vpc_id: 'vpc-a', target_health_descriptions: [{ Target: { Id: '10.0.1.10' } }],
        },
      });
      if (url.pathname.endsWith('/ecs_task')) rows.push({
        resource_id: 'task-orders', region, data: {
          cluster_arn: 'cluster/production', task_group: 'service:orders-api',
          attachments: [{ Details: [
            { Name: 'subnetId', Value: 'subnet-a' }, { Name: 'privateIPv4Address', Value: '10.0.1.10' },
          ] }],
        },
      });
      if (url.pathname.endsWith('/subnet')) rows.push({ resource_id: 'subnet-a', region, data: { vpc_id: 'vpc-a' } });
      return json({ rows, run: { finished_at: '2026-09-11T12:00:00Z' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  return requests;
}

// Exercise the real Next hooks with reactive router context. History pushes intentionally do not
// dispatch popstate, matching same-page Link navigation. The browser suite owns actual Next routing.
function mount(initial = '/topology') {
  window.history.replaceState({}, '', initial);
  let update!: (href: string) => void;
  const entries = [initial];
  let index = 0;
  const publish = (href: string) => {
    window.history.replaceState({}, '', href);
    update(href);
  };
  const router: AppRouterInstance = {
    push: vi.fn(href => { entries.splice(++index); entries.push(href); publish(href); }),
    replace: vi.fn(href => { entries[index] = href; publish(href); }),
    back: () => { if (index > 0) publish(entries[--index]); },
    forward: () => { if (index + 1 < entries.length) publish(entries[++index]); },
    refresh: () => {}, prefetch: () => {},
  };
  function Harness() {
    const [href, setHref] = useState(initial);
    update = setHref;
    return <AppRouterContext.Provider value={router}>
      <SearchParamsContext.Provider value={new URL(href, 'http://localhost').searchParams}>
        <TopologyPage />
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>;
  }
  render(<Harness />);
  return router;
}

async function flowReady() {
  await screen.findByRole('button', { name: '서비스 + 네트워크' });
  await waitFor(() => expect(screen.queryByText('로딩 중…')).toBeNull());
}
async function e2eReady() {
  await screen.findByRole('region', { name: 'NFM 소스' });
}

describe('topology page URL and restored scope', () => {
  it('reacts to same-page opt-out, opt-in and history traversal without remounting the page', async () => {
    const requests = serve();
    const router = mount('/topology?view=e2e');
    await e2eReady();
    act(() => router.push('/topology'));
    await flowReady();
    expect(screen.queryByRole('region', { name: 'NFM 소스' })).toBeNull();
    act(() => router.push('/topology?view=e2e'));
    await e2eReady();
    act(() => router.back());
    await flowReady();
    act(() => router.forward());
    await e2eReady();
    expect(requests.filter(url => url.pathname === '/api/nfm/query')).toEqual([]);
  });

  it('uses router navigation for view controls and preserves unrelated deep-link parameters', async () => {
    serve();
    const router = mount('/topology?monitor=vpc-monitor&range=1800');
    await flowReady();
    fireEvent.click(screen.getByRole('button', { name: '서비스 + 네트워크' }));
    await e2eReady();
    expect(router.push).toHaveBeenCalledWith('/topology?monitor=vpc-monitor&range=1800&view=e2e', { scroll: false });
    fireEvent.click(screen.getByRole('button', { name: '구성 흐름으로 돌아가기' }));
    await flowReady();
    expect(router.push).toHaveBeenLastCalledWith('/topology?monitor=vpc-monitor&range=1800', { scroll: false });
  });

  it.each([
    { accounts: ['123456789012'], regions: ['us-east-1'], includeGlobal: false },
    { accounts: '__all__' as const, regions: '__all__' as const, includeGlobal: true },
  ])('restores persisted scope before any inventory or host observation request: %j', async scope => {
    window.localStorage.setItem('awsops:scope', JSON.stringify(scope));
    const requests = serve();
    mount('/topology?view=e2e');
    await e2eReady();
    await waitFor(() => expect(within(screen.getByRole('region', { name: '구성 소스' }))
      .queryByText('구성을 불러오는 중…')).toBeNull());
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(url => url.pathname.startsWith('/api/inventory/'))).toBe(true);
    expect(requests.every(url => url.searchParams.get('accounts') ===
      (scope.accounts === '__all__' ? '__all__' : scope.accounts.join(',')))).toBe(true);
    expect(requests.every(url => url.searchParams.get('regions') ===
      (scope.regions === '__all__' ? '__all__' : scope.regions.join(',')))).toBe(true);
    expect(requests.every(url => url.searchParams.get('includeGlobal') === (scope.includeGlobal ? '1' : '0'))).toBe(true);
    expect(requests.filter(url => ['/api/nfm', '/api/graph', '/api/eks', '/api/nfm/query'].includes(url.pathname))).toEqual([]);
  });

  it('passes existing subnet inventory into ECS resolution without a second subnet request', async () => {
    const requests = serve();
    mount();
    await flowReady();
    fireEvent.change(screen.getByPlaceholderText('리소스 이름 검색…'), { target: { value: 'orders-api' } });
    expect(await screen.findByRole('button', { name: /^orders-api\s*target$/ })).toBeTruthy();
    expect(requests.filter(url => url.pathname === '/api/inventory/subnet')).toHaveLength(1);
  });

  it('updates the cluster filter from same-page navigation and writes filter controls to the URL', async () => {
    serve();
    const router = mount('/topology?cluster=ecs%3Aproduction');
    await flowReady();
    // The cluster select is identified by its option, avoiding assumptions about toolbar order.
    const select = screen.getByRole('option', { name: 'Cluster: 전체' }).parentElement as HTMLSelectElement;
    expect(select.value).toBe('ecs:production');
    act(() => router.push('/topology'));
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'ecs:production' } });
    expect(router.push).toHaveBeenLastCalledWith('/topology?cluster=ecs%3Aproduction', { scroll: false });
    act(() => router.back());
    expect(select.value).toBe('');
  });

  it.each([
    { ...DEFAULT_SCOPE, accounts: ['123456789012'] },
    { ...DEFAULT_SCOPE, regions: ['us-west-2'] },
    { ...DEFAULT_SCOPE, includeGlobal: false },
  ])('clears selected resource details on scope changes: %j', async nextScope => {
    serve();
    mount();
    await flowReady();
    // Use the target group (always present, independently of ECS attribution).
    fireEvent.change(screen.getByPlaceholderText('리소스 이름 검색…'), { target: { value: 'tg-orders' } });
    fireEvent.click(await screen.findByRole('button', { name: /^tg-orders\s*tg$/ }));
    expect(screen.getByRole('button', { name: 'ARN 복사' })).toBeTruthy();
    act(() => setActiveScope(nextScope));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ARN 복사' })).toBeNull());
  });
});
