// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ServiceNetworkTopology, { type ConfigurationStatus } from './ServiceNetworkTopology';
import type { FlowGraph } from '@/lib/flow-topology';

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  window.history.replaceState({}, '', '/topology?view=e2e');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const configured: FlowGraph = {
  nodes: [{ id: 'front-door', kind: 'alb', label: 'configured-front-door' }], edges: [],
};
const configuration: ConfigurationStatus = {
  loading: false, capturedAt: '2026-09-11T12:00:00Z', error: '', cappedTypes: [], failedTypes: [],
};
const props = { configured, configuration, account: 'self', onBack: () => {} };
const status = {
  monitors: [
    { name: 'nfm-eks-shop', status: 'ACTIVE', cluster: 'shop' },
    { name: 'nfm-vpc-all', status: 'ACTIVE', cluster: null },
    { name: 'nfm-paused', status: 'PENDING', cluster: null },
  ],
  scopeCount: 1,
};
const snapshot = {
  class: 'trace', account: 'self', captured_at: '2026-09-11T11:55:00Z',
  nodes: [{ id: 'checkout', kind: 'service', label: 'checkout-service', meta: {} }], edges: [],
};
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), {
  status: code, headers: { 'Content-Type': 'application/json' },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function observation(url: URL, overrides: Record<string, unknown> = {}) {
  const category = url.searchParams.get('category');
  const metric = url.searchParams.get('metric');
  const unit = metric === 'ROUND_TRIP_TIME' ? 'Milliseconds' : 'Bytes';
  return {
    monitor: url.searchParams.get('monitor'), metric, category, range: Number(url.searchParams.get('range')),
    unit, tookMs: 20, capped: false, startTime: '2026-09-11T11:45:00Z',
    endTime: '2026-09-11T12:00:00Z', queriedAt: '2026-09-11T12:00:01Z',
    rows: [{
      local: { ip: '10.0.1.10', region: 'ap-northeast-2', vpcId: 'vpc-shop' },
      remote: { ip: '10.0.2.20', region: 'ap-northeast-2', vpcId: 'vpc-shop' },
      value: 8192, unit, category, targetPort: 443, traversed: [], traversedIds: [],
    }],
    ...overrides,
  };
}
type HttpHandler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function serve(options: { nfm?: HttpHandler; service?: HttpHandler; query?: HttpHandler } = {}) {
  const requests: { url: URL; signal?: AbortSignal | null }[] = [];
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push({ url, signal: init?.signal });
    if (url.pathname === '/api/nfm') return Promise.resolve(options.nfm?.(url, init) ?? json(status));
    if (url.pathname === '/api/graph' && url.searchParams.get('class') === 'trace') {
      return Promise.resolve(options.service?.(url, init) ?? json(snapshot));
    }
    if (url.pathname === '/api/nfm/query') return Promise.resolve(options.query?.(url, init) ?? json(observation(url)));
    throw new Error(`Unexpected HTTP request: ${url}`);
  }));
  return { requests, queries: () => requests.filter(({ url }) => url.pathname === '/api/nfm/query') };
}
async function ready() {
  const button = screen.getByRole('button', { name: '네트워크 조회' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  return button;
}
function select(label: string, value: string) {
  fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } });
}
function search(value: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: '서비스 또는 리소스 검색' }), { target: { value } });
}

describe('ServiceNetworkTopology', () => {
  it('loads independent sources concurrently but does not query NFM before an explicit click', async () => {
    const service = deferred<Response>();
    const http = serve({ service: () => service.promise });
    render(<ServiceNetworkTopology {...props} />);
    const button = await ready();
    expect(http.requests.map(({ url }) => url.pathname + url.search)).toEqual(['/api/nfm', '/api/graph?class=trace']);
    expect((screen.getByRole('combobox', { name: '모니터' }) as HTMLSelectElement).value).toBe('nfm-vpc-all');
    expect(http.queries()).toHaveLength(0);
    select('메트릭', 'ROUND_TRIP_TIME');
    select('목적지 분류', 'INTER_AZ');
    select('조회 범위', '1800');
    expect(http.queries()).toHaveLength(0);
    fireEvent.click(button);
    await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    expect(http.queries()).toHaveLength(1);
    expect(Object.fromEntries(http.queries()[0].url.searchParams)).toEqual({
      monitor: 'nfm-vpc-all', metric: 'ROUND_TRIP_TIME', category: 'INTER_AZ', range: '1800',
    });
    await act(async () => { service.resolve(json(snapshot)); });
    search('checkout-service');
    expect(await screen.findByRole('button', { name: '선택: checkout-service' })).toBeTruthy();
  });

  it.each([
    ['HTTP rejection', () => json({ status: 'error', message: 'private-auth-detail' }, 401), /로그인|세션/],
    ['200 error envelope', () => json({ ...status, monitors: [], error: 'private-role-arn' }), /소스를 불러오지 못했습니다/],
    ['malformed status', () => json({ monitors: 'broken', scopeCount: 0 }), /올바르지 않은/],
  ])('distinguishes %s from an unconfigured NFM source', async (_, nfm, error) => {
    const http = serve({ nfm });
    render(<ServiceNetworkTopology {...props} />);
    const source = screen.getByRole('region', { name: 'NFM 소스' });
    expect(await within(source).findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(error));
    expect(document.body.textContent).not.toMatch(/private-auth-detail|private-role-arn/);
    expect(within(source).queryByText(/모니터가 없습니다/)).toBeNull();
    expect(http.queries()).toHaveLength(0);
    search('checkout-service');
    expect(await screen.findByRole('button', { name: '선택: checkout-service' })).toBeTruthy();
  });

  it('accepts a null error field in an otherwise successful source response', async () => {
    serve({ nfm: () => json({ ...status, error: null }) });
    render(<ServiceNetworkTopology {...props} />);
    await ready();
    expect(within(screen.getByRole('region', { name: 'NFM 소스' })).queryByRole('alert')).toBeNull();
  });

  it.each(['class', 'account'])('rejects service snapshots with missing %s scope', async field => {
    const missing = { ...snapshot } as Record<string, unknown>;
    delete missing[field];
    serve({ service: () => json(missing) });
    render(<ServiceNetworkTopology {...props} />);
    expect(await within(screen.getByRole('region', { name: '서비스 소스' })).findByRole('alert')).toBeTruthy();
    await ready();
  });

  it('preserves partial, stale and retained collection evidence from the service snapshot', async () => {
    serve({ service: () => json({ ...snapshot, collection: {
      status: 'partial', stale: true, retainedPrevious: true,
      captured_at: snapshot.captured_at,
      sources: [{ sourceId: 'trace:tempo', status: 'error', itemCount: 0 }],
    } }) });
    render(<ServiceNetworkTopology {...props} />);
    const source = screen.getByRole('region', { name: '서비스 소스' });
    expect(await within(source).findByText(/부분 수집/)).toBeTruthy();
    expect(within(source).getByText(/이전 그래프/)).toBeTruthy();
    expect(within(source).getByText(/오래된 데이터/)).toBeTruthy();
  });

  it('keeps evidence preferences when a query replaces observation data', async () => {
    serve();
    render(<ServiceNetworkTopology {...props} />);
    const button = await ready();
    const configurationLayer = screen.getByRole('checkbox', { name: '구성 관계' });
    fireEvent.click(configurationLayer);
    expect((configurationLayer as HTMLInputElement).checked).toBe(false);
    fireEvent.click(button);
    await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    expect((screen.getByRole('checkbox', { name: '구성 관계' }) as HTMLInputElement).checked).toBe(false);
  });

  it('discloses incomplete observation windows even when category requests succeeded', async () => {
    serve({ query: url => json(observation(url, { startTime: null, endTime: null, queriedAt: null })) });
    render(<ServiceNetworkTopology {...props} />);
    fireEvent.click(await ready());
    const result = await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    expect(within(result).getByText(/부분 성공/)).toBeTruthy();
    expect(within(result).queryByText(/^조회 완료/)).toBeNull();
    expect(within(result).getAllByText(/관측 시각 알 수 없음/).length).toBeGreaterThan(0);
  });

  it('accepts empty source arrays as unavailable observations, never as proof of zero traffic', async () => {
    serve({
      nfm: () => json({ monitors: [], scopeCount: 0 }),
      service: () => json({ ...snapshot, nodes: [], edges: [], captured_at: null }),
    });
    render(<ServiceNetworkTopology {...props} />);
    expect(await screen.findByText(/설정된 NFM 모니터가 없습니다/)).toBeTruthy();
    expect(await screen.findByText(/저장된 서비스 스냅샷이 없습니다/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/트래픽 없음|트래픽이 없습니다/)).toBeNull();
    search('configured-front-door');
    expect(screen.getByRole('button', { name: '선택: configured-front-door' })).toBeTruthy();
  });

  it.each([
    () => json({ status: 'error', message: 'snapshot unavailable' }, 503),
    () => json({ ...snapshot, nodes: [{ id: 'bad' }] }),
    () => json({ ...snapshot, account: '123456789012' }),
  ])('rejects a failed, malformed or incorrectly scoped service snapshot without disabling NFM', async (service) => {
    serve({ service });
    render(<ServiceNetworkTopology {...props} />);
    expect(await within(screen.getByRole('region', { name: '서비스 소스' })).findByRole('alert')).toBeTruthy();
    expect(await ready()).toBeTruthy();
    search('checkout-service');
    expect(screen.queryByRole('button', { name: '선택: checkout-service' })).toBeNull();
  });

  it('retains successful categories and reports bounded progress, failures, caps and original windows', async () => {
    const slow = deferred<Response>();
    let slowUrl!: URL;
    const http = serve({ query: (url) => {
      const category = url.searchParams.get('category');
      if (category === 'INTER_AZ') return json({ message: 'category unavailable' }, 503);
      if (category === 'UNCLASSIFIED') { slowUrl = url; return slow.promise; }
      return json(observation(url, { capped: category === 'INTRA_AZ', ...(category === 'INTER_VPC' ? {
        startTime: '2026-09-11T10:45:00Z', endTime: '2026-09-11T11:00:00Z',
      } : {}) }));
    } });
    render(<ServiceNetworkTopology {...props} />);
    fireEvent.click(await ready());
    await waitFor(() => expect(http.queries()).toHaveLength(7));
    expect(screen.getByRole('status', { name: '네트워크 조회 진행' }).textContent).toMatch(/6\s*\/\s*7/);
    for (const control of screen.getAllByRole('combobox')) expect((control as HTMLSelectElement).disabled).toBe(true);
    await act(async () => { slow.resolve(json(observation(slowUrl))); });
    const applied = await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    expect(within(applied).getByText(/부분 성공/)).toBeTruthy();
    expect(within(applied).getByText(/INTER_AZ.*조회 실패/)).toBeTruthy();
    expect(applied.textContent).not.toContain('category unavailable');
    expect(within(applied).getByText(/상한.*INTRA_AZ/)).toBeTruthy();
    expect(applied.querySelector('time[datetime="2026-09-11T10:45:00Z"]')).not.toBeNull();
    expect(screen.getByText(/서비스 스냅샷과 NFM 관측 시각이 일치하지 않습니다/)).toBeTruthy();
    expect(screen.getByTestId('e2e-network-edge-count').textContent).toBe('12');
  });

  it('keeps applied labels and graph while edited filters wait for the next click', async () => {
    const http = serve();
    render(<ServiceNetworkTopology {...props} />);
    await ready();
    select('목적지 분류', 'INTER_AZ');
    fireEvent.click(screen.getByRole('button', { name: '네트워크 조회' }));
    const applied = await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    select('모니터', 'nfm-eks-shop');
    select('메트릭', 'ROUND_TRIP_TIME');
    select('목적지 분류', 'INTRA_AZ');
    select('조회 범위', '3600');
    expect(screen.getByText('조회 조건이 변경되었습니다. 조회를 눌러 적용하세요.')).toBeTruthy();
    expect(applied.textContent).toContain('nfm-vpc-all');
    expect(applied.textContent).toContain('전송량');
    expect(applied.textContent).toContain('INTER_AZ');
    expect(applied.textContent).toContain('15분');
    expect(applied.textContent).not.toContain('nfm-eks-shop');
    expect(applied.textContent).not.toContain('RTT');
    expect(http.queries()).toHaveLength(1);
    expect(screen.getByTestId('e2e-network-edge-count').textContent).toBe('2');
  });

  it.each(['123456789012', '__all__'])('shows configuration alone with no source calls for account %s', (account) => {
    const http = serve();
    render(<ServiceNetworkTopology {...props} account={account} />);
    expect(http.requests).toHaveLength(0);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(/호스트 계정.*지원/)).toBeTruthy();
    search('configured-front-door');
    expect(screen.getByRole('button', { name: '선택: configured-front-door' })).toBeTruthy();
  });

  it('aborts and ignores late source and network responses after an account switch, including a return to self', async () => {
    const lateService = deferred<Response>();
    const lateQuery = deferred<Response>();
    let queryUrl!: URL;
    let serviceCalls = 0;
    const http = serve({
      service: () => ++serviceCalls === 1 ? lateService.promise : json({ ...snapshot, nodes: [], edges: [] }),
      query: (url) => { queryUrl = url; return lateQuery.promise; },
    });
    const view = render(<ServiceNetworkTopology {...props} />);
    await ready();
    select('목적지 분류', 'INTER_AZ');
    fireEvent.click(screen.getByRole('button', { name: '네트워크 조회' }));
    await waitFor(() => expect(http.queries()).toHaveLength(1));
    const oldRequests = [...http.requests];
    view.rerender(<ServiceNetworkTopology {...props} account="123456789012" />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('region', { name: '적용된 네트워크 조회' })).toBeNull();
    expect(http.requests).toHaveLength(3);
    expect(oldRequests.every(({ signal }) => signal?.aborted)).toBe(true);
    view.rerender(<ServiceNetworkTopology {...props} />);
    await ready();
    await act(async () => {
      lateService.resolve(json(snapshot));
      lateQuery.resolve(json(observation(queryUrl)));
    });
    expect(screen.queryByRole('region', { name: '적용된 네트워크 조회' })).toBeNull();
    expect(screen.getByTestId('e2e-network-edge-count').textContent).toBe('0');
    search('checkout-service');
    expect(screen.queryByRole('button', { name: '선택: checkout-service' })).toBeNull();
  });

  it('clears a focused connection when a new query reuses positional flow IDs', async () => {
    const next = deferred<Response>();
    let count = 0;
    let nextUrl!: URL;
    serve({ query: (url) => {
      if (++count === 1) return json(observation(url));
      nextUrl = url;
      return next.promise;
    } });
    render(<ServiceNetworkTopology {...props} />);
    await ready();
    select('목적지 분류', 'INTER_AZ');
    fireEvent.click(screen.getByRole('button', { name: '네트워크 조회' }));
    await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    search('10.0.1.10 ↔ 10.0.2.20');
    fireEvent.click(screen.getByRole('button', { name: /선택:.*10\.0\.1\.10.*10\.0\.2\.20/ }));
    const detail = screen.getByRole('region', { name: '선택한 노드 상세' });
    expect(within(detail).getByText('8 KB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '네트워크 조회' }));
    expect(screen.queryByRole('region', { name: '선택한 노드 상세' })).toBeNull();
    expect(screen.getByTestId('e2e-network-edge-count').textContent).toBe('0');
    await act(async () => { next.resolve(json(observation(nextUrl))); });
    await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    expect(screen.queryByRole('region', { name: '선택한 노드 상세' })).toBeNull();
  });

  it('refreshes sources and invokes the parent without running or accepting an old network query', async () => {
    const pending = deferred<Response>();
    let queryUrl!: URL;
    const http = serve({ query: (url) => { queryUrl = url; return pending.promise; } });
    let refreshes = 0;
    let backs = 0;
    render(<ServiceNetworkTopology {...props} onRefresh={() => { refreshes += 1; }} onBack={() => { backs += 1; }} />);
    await ready();
    select('목적지 분류', 'INTER_AZ');
    fireEvent.click(screen.getByRole('button', { name: '네트워크 조회' }));
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    await ready();
    expect(refreshes).toBe(1);
    expect(http.requests.filter(({ url }) => url.pathname === '/api/nfm')).toHaveLength(2);
    expect(http.requests.filter(({ url }) => url.pathname === '/api/graph')).toHaveLength(2);
    expect(http.queries()).toHaveLength(1);
    expect(http.queries()[0].signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(json(observation(queryUrl))); });
    expect(screen.queryByRole('region', { name: '적용된 네트워크 조회' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '구성 흐름으로 돌아가기' }));
    expect(backs).toBe(1);
  });

  it.each([
    ['monitor=nfm-eks-shop&metric=ROUND_TRIP_TIME&category=INTER_AZ&range=1800', 'nfm-eks-shop', 'ROUND_TRIP_TIME', 'INTER_AZ', '1800'],
    ['monitor=nfm-paused&metric=garbage&category=INTERNET&range=86400', 'nfm-vpc-all', 'DATA_TRANSFERRED', 'ALL', '900'],
  ])('validates initial URL filters (%s) without querying automatically', async (params, monitor, metric, category, range) => {
    window.history.replaceState({}, '', `/topology?view=e2e&${params}`);
    const http = serve();
    render(<ServiceNetworkTopology {...props} />);
    await ready();
    for (const [label, value] of [['모니터', monitor], ['메트릭', metric], ['목적지 분류', category], ['조회 범위', range]]) {
      expect((screen.getByRole('combobox', { name: label }) as HTMLSelectElement).value).toBe(value);
    }
    expect(http.queries()).toHaveLength(0);
  });

  it('labels an empty successful query as no matching top contributors and leaves unknown windows unknown', async () => {
    serve({ query: (url) => json(observation(url, { rows: [], startTime: undefined, endTime: undefined, queriedAt: undefined })) });
    render(<ServiceNetworkTopology {...props} />);
    await ready();
    select('목적지 분류', 'INTER_AZ');
    fireEvent.click(screen.getByRole('button', { name: '네트워크 조회' }));
    const applied = await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    expect(within(applied).getByText(/조건에 맞는 상위 기여자가 없습니다/)).toBeTruthy();
    expect(within(applied).getByText(/관측 시각 알 수 없음/)).toBeTruthy();
    expect(applied.querySelector('time')).toBeNull();
    expect(screen.queryByText(/트래픽이 없습니다|트래픽 없음/)).toBeNull();
  });
});
