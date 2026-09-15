// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ServiceNetworkTopology, { type ConfigurationStatus } from './ServiceNetworkTopology';
import type { FlowGraph } from '@/lib/flow-topology';
import { buildFlowGraph } from '@/lib/flow-topology';
import { buildTraceGraph } from '@/lib/trace-graph';
import * as e2e from '@/lib/e2e-topology';
import { projectGraphDetails } from '@/lib/graph-state';

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  window.history.replaceState({}, '', '/topology?view=e2e');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const configured: FlowGraph = {
  nodes: [{ id: 'front-door', kind: 'alb', label: 'configured-front-door' }], edges: [],
};
const configuration: ConfigurationStatus = {
  complete: true, loading: false, capturedAt: '2026-09-11T12:00:00Z', error: '', cappedTypes: [], failedTypes: [],
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
const completeCollection = {
  status: 'ok', stale: false, readStatus: 'ok', retainedPrevious: false,
  attempted_at: '2026-09-11T11:55:00Z', captured_at: '2026-09-11T11:55:00Z',
  windowStartMs: Date.parse('2026-09-11T10:55:00Z'), windowEndMs: Date.parse('2026-09-11T11:55:00Z'),
  nodeDrops: 0, edgeDrops: 0, orphanSpans: 0, invalidSpans: 0, unresolvedMessaging: 0,
  sources: [{ sourceId: 'tempo', status: 'ok', reasons: [],
    windowStartMs: Date.parse('2026-09-11T11:45:00Z'), windowEndMs: Date.parse('2026-09-11T12:00:00Z') }],
};
const snapshot = {
  class: 'trace', account: 'self', captured_at: '2026-09-11T11:55:00Z', collection: completeCollection,
  nodes: [{ id: 'checkout', kind: 'service', label: 'checkout-service', meta: {}, captured_at: '2026-09-11T11:56:00Z' }], edges: [],
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
function renderTopology(
  options: { nfm?: HttpHandler; service?: HttpHandler; query?: HttpHandler; host?: HttpHandler } = {},
  overrides: Partial<Parameters<typeof ServiceNetworkTopology>[0]> = {},
) {
  const requests: { url: URL; signal?: AbortSignal | null }[] = [];
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push({ url, signal: init?.signal });
    if (url.pathname === '/api/accounts') return Promise.resolve(options.host?.(url, init)
      ?? json({ accounts: [{ accountId: '111111111111', isHost: true }] }));
    if (url.pathname === '/api/nfm') return Promise.resolve(options.nfm?.(url, init) ?? json(status));
    if (url.pathname === '/api/graph' && url.searchParams.get('class') === 'trace') {
      return Promise.resolve(options.service?.(url, init) ?? json(snapshot));
    }
    if (url.pathname === '/api/nfm/query') return Promise.resolve(options.query?.(url, init) ?? json(observation(url)));
    throw new Error(`Unexpected HTTP request: ${url}`);
  }));
  const view = render(<ServiceNetworkTopology {...props} {...overrides} />);
  return { view, requests, queries: () => requests.filter(({ url }) => url.pathname === '/api/nfm/query') };
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

async function expectRejectedSnapshot(body: unknown, message?: string) {
  renderTopology({ service: () => json(body) });
  const alert = await within(screen.getByRole('region', { name: '서비스 소스' })).findByRole('alert');
  if (message) expect(alert.textContent).toContain(message);
  search('checkout-service');
  expect(screen.queryByRole('button', { name: '선택: checkout-service' })).toBeNull();
  await ready();
}

async function expectUnconfirmedSnapshot(body: unknown) {
  const compose = vi.spyOn(e2e, 'buildE2eGraph');
  renderTopology({ service: () => json(body) });
  search('checkout-service');
  expect(await screen.findByRole('button', { name: '선택: checkout-service' })).toBeTruthy();
  expect(compose.mock.lastCall?.[0].servicesComplete).toBe(false);
  expect(compose.mock.lastCall?.[0].services?.nodes).toHaveLength(1);
  const panel = within(screen.getByRole('region', { name: '서비스 소스' }));
  expect(await panel.findByText('일부 수집 메타데이터가 생략되어 범위가 불완전합니다.')).toBeTruthy();
  expect(panel.queryByText('올바르지 않은 서비스 수집 상태입니다.')).toBeNull();
  await ready();
  return compose.mock.lastCall?.[0].services as typeof snapshot;
}

describe('projected collection compatibility', () => {
  it.each(['sources', 'publishedSources'])('retains real projected unknown status and null evidence in %s', async key => {
    const details = projectGraphDetails({ ...completeCollection, retainedPrevious: true,
      [key]: [{ sourceId: 'tempo:unknown', status: 'future-status', itemCount: null,
        windowStartMs: null, windowEndMs: null, capturedAtMs: null, reasons: ['cap_reached'] }],
    });
    expect(details[key][0]).not.toHaveProperty('status');
    expect(details[key][0].itemCount).toBeNull();
    const data = await expectUnconfirmedSnapshot({ ...snapshot, collection: {
      ...completeCollection, ...details, status: 'partial',
    } });
    expect(data.collection[key as 'sources'][0]).toMatchObject({ sourceId: 'tempo:unknown', status: 'unknown' });
  });
  it.each(['itemCount', 'windowStartMs', 'capturedAtMs'])('does not turn projected null %s into complete evidence', async key => {
    const details = projectGraphDetails({ ...completeCollection,
      sources: [{ ...completeCollection.sources[0], [key]: null }],
    });
    expect(details.metadataTruncated).toBeUndefined();
    await expectUnconfirmedSnapshot({ ...snapshot, collection: { ...completeCollection, ...details } });
  });
  it('keeps other source fields when a producer timeline is impossible', async () => {
    const data = await expectUnconfirmedSnapshot({ ...snapshot, collection: { ...completeCollection,
      sources: [{ ...completeCollection.sources[0], attemptedAtMs: 2000, finishedAtMs: 1000 }],
    } });
    expect(data.collection.sources[0]).toMatchObject({ sourceId: 'tempo', status: 'ok' });
    expect(data.collection.sources[0]).not.toHaveProperty('attemptedAtMs');
    expect(data.collection.sources[0]).not.toHaveProperty('finishedAtMs');
  });
});

describe('ServiceNetworkTopology', () => {
  it.each([[true, {}, true], [false, {}, false], [true, { stale: true }, false],
    [true, { status: 'partial' }, false], [true, { readTruncated: true }, false],
    [true, { retainedPrevious: true }, false], [true, { sources: [] }, false],
    [true, { metadataTruncated: true }, false], [true, { nodeDrops: 1 }, false],
    ...['nodeDrops', 'edgeDrops', 'orphanSpans', 'invalidSpans', 'unresolvedMessaging']
      .map(key => [true, { [key]: undefined }, false] as const),
    [true, { sources: [{ ...completeCollection.sources[0], status: 'partial' }] }, false]] as const)
  ('requires trusted host and complete fresh service evidence: %j', async (known, quality, expected) => {
    const host = '111111111111', region = 'ap-northeast-2', vpcId = 'vpc-shop';
    const configured = buildFlowGraph({
      tg: [{ resource_id: 'tg', region, vpc_id: vpcId, account_id: 'self', target_type: 'ip',
        target_health_descriptions: [{ Target: { Id: '10.0.1.10', Port: 443 } }] }],
      ipResolved: { '10.0.1.10': { label: 'shop/web', resolved: 'eks',
        meta: { region, vpcId, cluster: 'app', namespace: 'shop', pod: 'web-1' } } },
    });
    const trace = buildTraceGraph([{ traceId: 't', spanId: 's', service: 'web', sourceId: 'tempo', kind: 'SERVER', startMs: 0, durationMs: 1,
      accountId: host, region, k8sCluster: 'app', k8sNamespace: 'shop', k8sPod: 'web-1', k8sDeployment: 'web' }], [], [], host);
    renderTopology({ host: () => json({ accounts: known ? [{ accountId: host, isHost: true }] : [] }),
      service: () => json({ ...trace, class: 'trace', account: 'self', captured_at: snapshot.captured_at, collection: { ...completeCollection, ...quality } }),
      query: url => { const result = observation(url); Object.assign(result.rows[0].local,
        { podName: 'web-1', podNamespace: 'shop' }); return json(result); },
    }, { configured });
      await ready(); select('목적지 분류', 'INTER_AZ');
      fireEvent.click(screen.getByRole('button', { name: '네트워크 조회' }));
      await screen.findByRole('region', { name: '적용된 네트워크 조회' });
      search('web-1'); fireEvent.click(await screen.findByRole('button', { name: '선택: shop/web-1' }));
      const detail = within(screen.getByRole('region', { name: '선택한 노드 상세' }));
      expect(Boolean(detail.queryByText('구성에서 확인된 Pod 식별자'))).toBe(expected);
  });
  it('preserves an all-failed network read instead of presenting successful absence', async () => {
    renderTopology({ query: () => json({ error: 'unavailable' }, 503) });
    fireEvent.click(await ready());
    await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    expect(screen.getByText('네트워크 관측 조회가 실패했습니다.')).toBeTruthy();
    expect(screen.queryByText('표시할 네트워크 관측이 없습니다.')).toBeNull();
  });
  it('loads independent sources concurrently but does not query NFM before an explicit click', async () => {
    const compose = vi.spyOn(e2e, 'buildE2eGraph');
    const service = deferred<Response>();
    const http = renderTopology({ service: () => service.promise });
    const button = await ready();
    expect(http.requests.map(({ url }) => url.pathname + url.search)).toEqual(['/api/nfm', '/api/graph?class=trace', '/api/accounts']);
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
    expect(compose.mock.lastCall?.[0].services?.nodes[0]).toMatchObject({ captured_at: snapshot.nodes[0].captured_at });
  });

  it.each([
    ['HTTP rejection', () => json({ status: 'error', message: 'private-auth-detail' }, 401), /로그인|세션/],
    ['200 error envelope', () => json({ ...status, monitors: [], error: 'private-role-arn' }), /소스를 불러오지 못했습니다/],
    ['malformed status', () => json({ monitors: 'broken', scopeCount: 0 }), /올바르지 않은/],
  ])('distinguishes %s from an unconfigured NFM source', async (_, nfm, error) => {
    const http = renderTopology({ nfm });
    const source = screen.getByRole('region', { name: 'NFM 소스' });
    expect(await within(source).findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(error));
    expect(document.body.textContent).not.toMatch(/private-auth-detail|private-role-arn/);
    expect(within(source).queryByText(/모니터가 없습니다/)).toBeNull();
    expect(http.queries()).toHaveLength(0);
    search('checkout-service');
    expect(await screen.findByRole('button', { name: '선택: checkout-service' })).toBeTruthy();
  });

  it('accepts a null error field in an otherwise successful source response', async () => {
    renderTopology({ nfm: () => json({ ...status, error: null }) });
    await ready();
    expect(within(screen.getByRole('region', { name: 'NFM 소스' })).queryByRole('alert')).toBeNull();
  });

  it.each(['class', 'account'])('rejects service snapshots with missing %s scope', async field => {
    const missing = { ...snapshot } as Record<string, unknown>;
    delete missing[field];
    renderTopology({ service: () => json(missing) });
    expect(await within(screen.getByRole('region', { name: '서비스 소스' })).findByRole('alert')).toBeTruthy();
    await ready();
  });

  it('preserves partial, stale and retained collection evidence from the service snapshot', async () => {
    renderTopology({ service: () => json({ ...snapshot, collection: {
      status: 'partial', stale: true, retainedPrevious: true,
      captured_at: snapshot.captured_at,
      sources: [{ sourceId: 'trace:tempo', status: 'error', itemCount: 0 }],
    } }) });
    const source = screen.getByRole('region', { name: '서비스 소스' });
    expect(await within(source).findByText(/부분 수집/)).toBeTruthy();
    expect(within(source).getByText(/이전 그래프/)).toBeTruthy();
    expect(within(source).getByText(/오래된 데이터/)).toBeTruthy();
  });

  it('keeps evidence preferences when a query replaces observation data', async () => {
    renderTopology();
    const button = await ready();
    const configurationLayer = screen.getByRole('checkbox', { name: '구성 관계' });
    fireEvent.click(configurationLayer);
    expect((configurationLayer as HTMLInputElement).checked).toBe(false);
    fireEvent.click(button);
    await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    expect((screen.getByRole('checkbox', { name: '구성 관계' }) as HTMLInputElement).checked).toBe(false);
  });

  it('discloses incomplete observation windows even when category requests succeeded', async () => {
    renderTopology({ query: url => json(observation(url, { startTime: null, endTime: null, queriedAt: null })) });
    fireEvent.click(await ready());
    const result = await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    expect(within(result).getByText(/부분 성공/)).toBeTruthy();
    expect(within(result).getByText('관측 구간이 미확인인 분류가 있어 부분 결과로 표시합니다.')).toBeTruthy();
    expect(within(result).queryByText(/^조회 완료/)).toBeNull();
    expect(within(result).getAllByText(/관측 시각 알 수 없음/).length).toBeGreaterThan(0);
  });

  it('accepts empty source arrays as unavailable observations, never as proof of zero traffic', async () => {
    renderTopology({
      nfm: () => json({ monitors: [], scopeCount: 0 }),
      service: () => json({ ...snapshot, nodes: [], edges: [], captured_at: null }),
    });
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
    renderTopology({ service });
    expect(await within(screen.getByRole('region', { name: '서비스 소스' })).findByRole('alert')).toBeTruthy();
    expect(await ready()).toBeTruthy();
    search('checkout-service');
    expect(screen.queryByRole('button', { name: '선택: checkout-service' })).toBeNull();
  });

  it('retains successful categories and reports bounded progress, failures, caps and original windows', async () => {
    const slow = deferred<Response>();
    let slowUrl!: URL;
    const http = renderTopology({ query: (url) => {
      const category = url.searchParams.get('category');
      if (category === 'INTER_AZ') return json({ message: 'category unavailable' }, 503);
      if (category === 'UNCLASSIFIED') { slowUrl = url; return slow.promise; }
      return json(observation(url, { capped: category === 'INTRA_AZ', ...(category === 'INTER_VPC' ? {
        startTime: '2026-09-11T10:45:00Z', endTime: '2026-09-11T11:00:00Z',
      } : {}) }));
    } });
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
    const http = renderTopology();
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
    const http = renderTopology({}, { account });
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
    const { view, ...http } = renderTopology({
      service: () => ++serviceCalls === 1 ? lateService.promise : json({ ...snapshot, nodes: [], edges: [] }),
      query: (url) => { queryUrl = url; return lateQuery.promise; },
    });
    await ready();
    select('목적지 분류', 'INTER_AZ');
    fireEvent.click(screen.getByRole('button', { name: '네트워크 조회' }));
    await waitFor(() => expect(http.queries()).toHaveLength(1));
    const oldRequests = [...http.requests];
    view.rerender(<ServiceNetworkTopology {...props} account="123456789012" />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('region', { name: '적용된 네트워크 조회' })).toBeNull();
    expect(http.requests).toHaveLength(4);
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
    renderTopology({ query: (url) => {
      if (++count === 1) return json(observation(url));
      nextUrl = url;
      return next.promise;
    } });
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
    let refreshes = 0;
    let backs = 0;
    const http = renderTopology({ query: (url) => { queryUrl = url; return pending.promise; } },
      { onRefresh: () => { refreshes += 1; }, onBack: () => { backs += 1; } });
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
    const http = renderTopology();
    await ready();
    for (const [label, value] of [['모니터', monitor], ['메트릭', metric], ['목적지 분류', category], ['조회 범위', range]]) {
      expect((screen.getByRole('combobox', { name: label }) as HTMLSelectElement).value).toBe(value);
    }
    expect(http.queries()).toHaveLength(0);
  });

  it('labels an empty successful query as no matching top contributors and leaves unknown windows unknown', async () => {
    renderTopology({ query: (url) => json(observation(url, { rows: [], startTime: undefined, endTime: undefined, queriedAt: undefined })) });
    await ready();
    select('목적지 분류', 'INTER_AZ');
    fireEvent.click(screen.getByRole('button', { name: '네트워크 조회' }));
    const applied = await screen.findByRole('region', { name: '적용된 네트워크 조회' });
    expect(within(applied).getByText(/조건에 맞는 상위 기여자가 없습니다/)).toBeTruthy();
    expect(within(applied).getByText(/관측 시각 알 수 없음/)).toBeTruthy();
    expect(applied.querySelector('time')).toBeNull();
    expect(screen.getByText('네트워크 관측 범위가 불완전합니다.')).toBeTruthy();
    expect(screen.queryByText(/트래픽이 없습니다|트래픽 없음/)).toBeNull();
  });
});

describe('canonical service metadata preservation', () => {
it('carries real trace-assembly losses through the HTTP collection envelope', async () => {
    const span = { sourceId: 'trace:fixture', traceId: 'trace', service: 'producer-service',
      kind: 'SERVER', startMs: Date.parse(snapshot.captured_at), durationMs: 1 };
    const produced = buildTraceGraph([
      { ...span, spanId: 'child', parentSpanId: 'not-collected' },
      { ...span, spanId: 'invalid', service: '' },
      { ...span, spanId: 'message', kind: 'PRODUCER', messagingSystem: 'sqs', messagingDestination: 'unqualified' },
    ], [], []);
    expect([produced.orphanSpans, produced.invalidSpans, produced.unresolvedMessaging]).toEqual([1, 1, 1]);
    renderTopology({ service: () => json({ ...snapshot, nodes: produced.nodes, edges: produced.edges, collection: {
      ...snapshot.collection, status: 'partial', attempted_at: new Date(snapshot.captured_at),
      captured_at: new Date(snapshot.captured_at), nodeDrops: 0, edgeDrops: 0, infraUnavailable: false,
      orphanSpans: produced.orphanSpans, invalidSpans: produced.invalidSpans,
      unresolvedMessaging: produced.unresolvedMessaging,
    } }) });
    const source = screen.getByRole('region', { name: '서비스 소스' });
    const alert = await within(source).findByRole('alert');
    for (const label of ['부모 또는 링크 미확인 스팬', '잘못된 스팬', '메시징 연결 미확인 스팬']) {
      expect(within(alert).getByText(`${label}: 1`).closest('details')).toBeNull();
    }
    expect(Array.from(alert.querySelectorAll('time'), time => time.dateTime)).toEqual([
      new Date(snapshot.collection.windowStartMs).toISOString(), new Date(snapshot.collection.windowEndMs).toISOString(),
      new Date(snapshot.captured_at).toISOString(), new Date(snapshot.captured_at).toISOString(),
      new Date(snapshot.collection.sources[0].windowStartMs).toISOString(), new Date(snapshot.collection.sources[0].windowEndMs).toISOString(),
    ]);
    search('producer-service');
    expect(screen.getByRole('button', { name: '선택: producer-service' })).toBeTruthy();
  });

it('keeps actual graph-cap and unavailable-infrastructure explanations through validation', async () => {
    renderTopology({ service: () => json({ ...snapshot, collection: {
      ...snapshot.collection, status: 'partial', nodeDrops: 2, edgeDrops: 3, orphanSpans: 0,
      invalidSpans: 0, unresolvedMessaging: 0, infraUnavailable: true,
    } }) });
    const panel = await within(screen.getByRole('region', { name: '서비스 소스' })).findByRole('alert');
    expect(panel.textContent).toContain('누락 노드: 2');
    expect(panel.textContent).toContain('누락 엣지: 3');
    expect(panel.textContent).toContain('인벤토리 정보를 사용할 수 없음');
    expect(panel.textContent).not.toContain('부모 또는 링크 미확인 스팬: 0');
  });

it.each([-1, 0.5, '2', null, Number.MAX_SAFE_INTEGER + 1])('preserves graph data with unconfirmed loss counts: %s', async orphanSpans => {
    await expectUnconfirmedSnapshot({ ...snapshot, collection: { ...snapshot.collection, orphanSpans } });
  });

it('preserves graph data with unconfirmed infrastructure availability', async () => {
    await expectUnconfirmedSnapshot({ ...snapshot, collection: { ...snapshot.collection, infraUnavailable: 'false' } });
  });

it('preserves real public collection clocks and keeps reasons in one bounded panel', async () => {
    renderTopology({ service: () => json({ ...snapshot, collection: {
      ...snapshot.collection, status: 'partial',
      sources: Array.from({ length: 48 }, (_, i) => ({
        sourceId: `trace:${i}`, status: 'partial', reasons: [`reason_${i}`], itemCount: i,
      })),
    } }) });
    const source = screen.getByRole('region', { name: '서비스 소스' });
    const panel = await within(source).findByRole('alert');
    expect(panel.querySelectorAll('time')).toHaveLength(4);
    expect(Array.from(panel.querySelectorAll('time'), time => time.dateTime)).toEqual([
      new Date(snapshot.collection.windowStartMs).toISOString(), new Date(snapshot.collection.windowEndMs).toISOString(),
      '2026-09-11T11:55:00Z', '2026-09-11T11:55:00Z',
    ]);
    const details = source.querySelector('details')!;
    expect(details).not.toBeNull();
    for (const i of [0, 47]) {
      const reason = within(source).getAllByText(`· reason_${i}`);
      expect(reason).toHaveLength(1);
      expect(details.contains(reason[0])).toBe(true);
    }
    search('checkout-service');
    expect(screen.getByRole('button', { name: '선택: checkout-service' })).toBeTruthy();
  });

it('preserves read failures and producer clocks independently of a saved collection result', async () => {
    const attempted = Date.parse('2026-09-11T11:56:00Z');
    const finished = Date.parse('2026-09-11T11:57:00Z');
    renderTopology({ service: () => json({ ...snapshot, nodes: [], edges: [], collection: {
      ...snapshot.collection, evidenceKind: 'trace', readStatus: 'unavailable', readReason: 'timeout',
      metadataTruncated: true, readTruncated: true, failureReason: 'state_read_failed',
      sourceAttempted: false, coverage: 'unknown',
      sources: [{ sourceId: 'trace:latest', status: 'partial', producerStatus: 'failed',
        attemptedAtMs: attempted, finishedAtMs: finished, reasons: ['incomplete_collection'] }],
    } }) });
    const source = screen.getByRole('region', { name: '서비스 소스' });
    const panel = await within(source).findByRole('alert');
    for (const text of [
      '그래프 조회 불가 — 수집 상태를 확인할 수 없습니다.',
      '그래프 조회 시간이 초과되었습니다. 다시 조회하세요.',
      '일부 수집 메타데이터가 생략되어 범위가 불완전합니다.',
      '그래프 조회 한도 — 반환된 범위가 불완전합니다.',
      '수집 메타데이터를 조회할 수 없습니다.',
      '실행 예산으로 원본 조회를 시도하지 않음',
      '선택한 계정 집합의 수집 범위 미확인',
      '원본 작업 상태: failed',
    ]) expect(within(panel).getByText(text)).toBeTruthy();
    const times = Array.from(panel.querySelectorAll('time'), time => time.dateTime);
    expect(times).toContain(new Date(attempted).toISOString());
    expect(times).toContain(new Date(finished).toISOString());
    expect(times).toContain(snapshot.captured_at);
    expect(await ready()).toBeTruthy();
  });

it.each([
    { readStatus: 'success' }, { readReason: 'permission' }, { metadataTruncated: 'false' },
    { sourceAttempted: 0 }, { coverage: 'complete' }, { evidenceKind: 'other' },
    { failureReason: 'constructor' }, { windowStartMs: 2000, windowEndMs: 1000 },
    { sources: [{ sourceId: 'trace', status: 'ok', producerStatus: 'success' }] },
    { sources: [{ sourceId: 'trace', status: 'ok', attemptedAtMs: '1000' }] },
  ])('withholds completeness for malformed read/producer metadata: %j', async fields => {
    await expectUnconfirmedSnapshot({ ...snapshot, collection: { ...snapshot.collection, ...fields } });
  });

it('validates optional provenance without replacing snapshot time or claiming current production availability', async () => {
    // Optional compatibility fixture: current trace producer emits root clocks, not these extra fields.
    renderTopology({ service: () => json({ ...snapshot, collection: {
      ...snapshot.collection, status: 'error', stale: true, retainedPrevious: true,
      evidenceKind: 'inventory', graphTruncated: true,
      sources: [{ sourceId: 'current-attempt', status: 'error', reasons: ['read_failed'], scope: 'aggregate',
        lastSuccessAtMs: Date.parse('2026-09-11T10:00:00Z') }],
      publishedSources: [{ sourceId: 'saved-source', status: 'partial', reasons: ['saved_cap'], scope: 'account',
        capturedAtMs: Date.parse('2026-09-11T09:00:00Z') }],
    } }) });
    const source = screen.getByRole('region', { name: '서비스 소스' });
    const panel = await within(source).findByRole('alert');
    expect(Array.from(panel.querySelectorAll('time'), time => time.dateTime)).toEqual([
      new Date(snapshot.collection.windowStartMs).toISOString(), new Date(snapshot.collection.windowEndMs).toISOString(),
      '2026-09-11T11:55:00Z', '2026-09-11T11:55:00Z', '2026-09-11T10:00:00.000Z', '2026-09-11T09:00:00.000Z',
    ]);
    expect(source.textContent).toContain('처리 한도 초과');
    const details = source.querySelector('details')!;
    expect(details.textContent).toContain('saved-source');
    expect(within(source).getAllByText(/saved_cap/)).toHaveLength(1);
    search('checkout-service');
    expect(screen.getByRole('button', { name: '선택: checkout-service' })).toBeTruthy();
  });

it.each([
    { attempted_at: [] }, { captured_at: 'invalid' }, { inputTruncated: 'false' }, { graphTruncated: 1 },
    { evidenceKind: {} }, { publishedSources: {} },
    ...[
      { scope: 'global' }, { capturedAtMs: -1 }, { lastSuccessAtMs: 'yesterday' },
      { reasons: [false] }, { status: 'constructor' },
      { windowStartMs: 'invalid' }, { windowEndMs: -1 }, { windowStartMs: 2000, windowEndMs: 1000 },
    ].map(bad => ({ publishedSources: [{ sourceId: 'saved', status: 'ok', ...bad }] })),
  ])('retains the graph without certifying malformed optional metadata: %j', async bad => {
    await expectUnconfirmedSnapshot({ ...snapshot, collection: { ...snapshot.collection, ...bad } });
  });

it.each([
    { class: undefined }, { account: undefined }, { class: 'flow' },
    { collection: [] }, { collection: { status: 'ok', stale: 'false' } },
    { collection: { status: 'constructor', stale: false } },
    { collection: { status: 'ok', stale: false, retainedPrevious: 'false' } },
    { collection: { status: 'ok', stale: false, sources: [{ sourceId: 'trace', status: 'partial', reasons: 'cap' }] } },
    { collection: { status: 'ok', stale: false, sources: [{ sourceId: 'trace', status: 'partial', reasons: [1] }] } },
    { collection: { status: 'ok', stale: false, sources: [{ sourceId: 'trace', status: 'ok', itemCount: -1 }] } },
  ])('rejects unproven scope but retains graph rows with unknown metadata: %j', async bad => {
    if (Object.hasOwn(bad, 'collection')) await expectUnconfirmedSnapshot({ ...snapshot, ...bad });
    else await expectRejectedSnapshot({ ...snapshot, ...bad });
  });

it('keeps source query windows from the real producer envelope', async () => {
    renderTopology();
    const source = screen.getByRole('region', { name: '서비스 소스' });
    expect(await within(source).findByText(/원본 조회 시작/)).toBeTruthy();
    const times = Array.from(source.querySelectorAll('time'), time => time.dateTime);
    expect(times).toContain(new Date(snapshot.collection.sources[0].windowStartMs).toISOString());
    expect(times).toContain(new Date(snapshot.collection.sources[0].windowEndMs).toISOString());
  });
});


describe('service root coverage and capture contract', () => {
  it.each([{ from: 'service-subgraph' }, { capped: true }])('keeps valid %j data without certifying full workload membership', async fields => {
    const compose = vi.spyOn(e2e, 'buildE2eGraph');
    renderTopology({ service: () => json({ ...snapshot, ...fields }) });
    await waitFor(() => expect(compose.mock.lastCall?.[0].services?.captured_at).toBe(snapshot.captured_at));
    expect(compose.mock.lastCall?.[0].servicesComplete).toBe(false);
    expect(compose.mock.lastCall?.[0].services).toMatchObject(fields);
    search('checkout-service');
    expect(await screen.findByRole('button', { name: '선택: checkout-service' })).toBeTruthy();
  });
  it.each([{ from: 1 }, { capped: 'false' }, { nodes: [{ ...snapshot.nodes[0], captured_at: 'invalid' }] },
    { nodes: [{ ...snapshot.nodes[0], captured_at: 123 }] }])('rejects malformed root/row provenance: %j', async fields => {
    await expectRejectedSnapshot({ ...snapshot, ...fields });
  });
});
