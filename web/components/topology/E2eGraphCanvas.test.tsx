// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReactFlow, type ReactFlowProps } from '@xyflow/react';
import E2eGraphCanvas from './E2eGraphCanvas';
import { LanguageProvider } from '@/components/shell/LanguageProvider';
import { buildFlowGraph } from '@/lib/flow-topology';
import { buildE2eGraph } from '@/lib/e2e-topology';
import type { E2eGraph } from '@/lib/e2e-topology-types';

// Observe our viewport contract while keeping React Flow and graph selection real.
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual, ReactFlow: vi.fn((props: ReactFlowProps) => <actual.ReactFlow {...props} />) };
});
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('ResizeObserver', ResizeObserverStub); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const graph: E2eGraph = {
  nodes: [
    { id: 's1', kind: 'service', label: 'checkout', layer: 'service', meta: {} },
    { id: 'p1', kind: 'endpoint', label: 'shop/pod-a', layer: 'network', meta: {} },
    { id: 'p2', kind: 'endpoint', label: 'shop/pod-b', layer: 'network', meta: {} },
    { id: 'f1', kind: 'connection', label: 'checkout-flow', layer: 'network', meta: {
      metric: 'DATA_TRANSFERRED', unit: 'Bytes', monitor: 'nfm-eks-demo', rangeSec: 900,
      category: 'INTER_AZ', startTime: '2026-09-11T11:45:00Z', endTime: '2026-09-11T12:00:00Z',
      flow: { local: { ip: '10.0.1.1' }, remote: { ip: '10.0.2.1' },
        value: 8192, unit: 'Bytes', category: 'INTER_AZ', targetPort: 443,
        snatIp: '192.0.2.1', traversed: ['NAT'], traversedIds: ['NAT:nat-demo'] },
    } },
  ],
  edges: [
    { id: 'i1', source: 's1', target: 'p1', evidence: 'identity', relation: 'identity', directed: false },
    { id: 'n1', source: 'p1', target: 'f1', evidence: 'network', relation: 'network', directed: false },
    { id: 'n2', source: 'f1', target: 'p2', evidence: 'network', relation: 'network', directed: false },
  ],
  summary: { configurationComplete: true, networkRead: { status: 'complete', failedCategories: [], unknownWindowCategories: [] }, configuredNodes: 0, serviceNodes: 1, networkFlows: 1, correlatedEndpoints: 1,
    unmatchedEndpoints: 1, ambiguousEndpoints: 0, observationsUnsupported: false },
};

async function select(label: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: label } });
  fireEvent.click(await screen.findByRole('button', { name: `선택: ${label}` }));
  return within(screen.getByRole('region', { name: '선택한 노드 상세' }));
}

describe('E2eGraphCanvas', () => {
  it.each([false, true])('does not turn absent/unsupported observations into zero unmatched counts: %s', unsupported => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [], edges: [],
      summary: { ...graph.summary, networkFlows: 0, unmatchedEndpoints: 0, observationsUnsupported: unsupported } }} />);
    expect(screen.queryByText('미연결 관측 0')).toBeNull();
    expect(screen.getByText(unsupported ? '이 계정에서 네트워크 관측을 사용할 수 없습니다.' : '표시할 네트워크 관측이 없습니다.')).toBeTruthy();
  });
  it('exposes the configured and workload Pod evidence used by identity links', async () => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [
      { id: 't', kind: 'target', layer: 'configuration', label: 'target', meta: { pod: 'web-2', namespace: 'shop', resolved: 'eks' } },
      { id: 'w', kind: 'workload', layer: 'service', label: 'deployment', meta: { pods: ['web-1', 'web-2'] } },
    ], edges: [{ id: 'identity', source: 't', target: 'w', evidence: 'identity', relation: 'same-identity',
      meta: { cluster: 'app', namespace: 'shop', pod: 'web-2' } }] }} />);
    expect((await select('target')).getByText('web-2')).toBeTruthy();
    const workload = await select('deployment');
    expect(workload.getByText('web-1, web-2')).toBeTruthy();
    expect(workload.getByText('app / shop / web-2')).toBeTruthy();
  });
  it.each([[2, false], [2, true], [25, false]] as const)('discloses grouped producer identities and ownership: count=%s countOnly=%s', async (count, countOnly) => {
    const captured = '2026-09-11T12:00:00Z';
    const pods = Array.from({ length: count }, (_, i) => ({
      id: `10.0.1.${i + 1}`, pod: `web-${i + 1}`, namespace: i === 0 ? 'shop' : 'payments',
    }));
    const configured = buildFlowGraph({
      tg: [{ resource_id: 'tg-web', target_type: 'ip', region: 'us-east-1', vpc_id: 'vpc-app', captured_at: captured,
        target_health_descriptions: pods.map(({ id }) => ({ Target: { Id: id, Port: 80 } })) }],
      ipResolved: Object.fromEntries(pods.map(({ id, pod, namespace }) => [id, { label: 'deployment', resolved: 'eks',
        meta: { cluster: 'app', region: 'us-east-1', vpcId: 'vpc-app', pod, namespace } }])),
      ownershipRead: { configurationOnly: true },
    });
    const target = configured.nodes.find(node => node.kind === 'target')!;
    target.meta = { ...target.meta, ambiguity: 'ownership_unverified', e2e_correlation_blocked: true };
    if (countOnly) delete target.meta.members;
    render(<E2eGraphCanvas graph={buildE2eGraph({ account: 'self', configured, services: null, network: [] })} />);
    const detail = await select(`deployment ×${count}`);
    expect(detail.queryByText('web-1')).toBeNull();
    expect(detail.queryByText('shop')).toBeNull();
    for (const value of ['여러 타깃을 묶은 구성 기록입니다.', '10.0.1.1 · shop/web-1', '10.0.1.2 · payments/web-2',
      'ownership_evidence', 'cached_configuration', 'ownership_reason', 'eks_not_enumerated', 'ambiguity',
      'ownership_unverified', 'e2e_correlation_blocked', 'true', 'targetCapturedAt', new Date(captured).toLocaleString(),
      '타깃 그룹의 수집 시각이며 소유권 확인 시각이 아닙니다.']) expect(detail.getByText(value)).toBeTruthy();
    expect(detail.getByText('count').nextElementSibling?.textContent).toBe(String(count));
    const identities = within(detail.getByText('memberIdentities').nextElementSibling as HTMLElement);
    expect(identities.getAllByRole('listitem')).toHaveLength(Math.min(count, 20));
    if (count > 20) {
      expect(identities.getByText('+5 멤버 더 있음')).toBeTruthy();
      expect(detail.getByText('membersTruncated').nextElementSibling?.textContent).toBe('5');
    }
  });
  it('focuses a late-ID top contributor before display caps and names omitted categories', async () => {
    const flows = Array.from({ length: 121 }, (_, i) => {
      const id = i === 120 ? 'z-peak' : `a-${i}`;
      return { ...graph.nodes[3], id, meta: { ...graph.nodes[3].meta,
        category: i === 120 ? 'UNCLASSIFIED' : 'INTER_AZ',
        flow: { ...(graph.nodes[3].meta.flow as object), value: i === 120 ? 1e9 : 1 } } };
    });
    const nodes = flows.flatMap(flow => [flow, ...['local', 'remote'].map(side => ({
      ...graph.nodes[1], id: `${flow.id}-${side}`,
    }))]);
    const edges = flows.flatMap(flow => ['local', 'remote'].map(side => ({
      id: `${flow.id}-${side}`, source: `${flow.id}-${side}`, target: flow.id,
      evidence: 'network' as const, relation: side, directed: false,
    })));
    render(<E2eGraphCanvas graph={{ ...graph, nodes, edges, summary: { ...graph.summary, networkFlows: 121 } }} />);
    await waitFor(() => expect(vi.mocked(ReactFlow).mock.lastCall?.[0].fitViewOptions?.nodes)
      .toContainEqual({ id: 'z-peak' }));
    expect(screen.getByText(/생략된 관측 분류:/).textContent).toContain('INTER_AZ');
  });
  it.each([
    ['ko', '로컬 엔드포인트', '네트워크 관측'], ['en', 'Local endpoint', 'Network observations'],
    ['zh', '本地端点', '网络观测'], ['ja', 'ローカルエンドポイント', 'ネットワーク観測'],
  ])('localizes generated labels in %s while preserving resource names in search and details', async (lang, local, network) => {
    localStorage.setItem('awsops-lang', lang);
    try {
      render(<LanguageProvider><E2eGraphCanvas graph={{ ...graph, nodes: [
        { ...graph.nodes[1], label: 'local_endpoint', labelKey: 'local_endpoint', meta: { endpoint: { podName: ' ' }, side: 'local' } },
        { ...graph.nodes[0], label: 'local_endpoint' },
        { ...graph.nodes[2], label: 'endpoint-resource-123', meta: { endpoint: {}, side: 'remote' } },
        { ...graph.nodes[3], label: 'network_observation', labelKey: 'network_observation', meta: { ...graph.nodes[3].meta, metric: '' } },
        { ...graph.nodes[1], id: 'service-endpoint', label: 'local_endpoint', labelKey: 'local_endpoint',
          meta: { endpoint: { podName: ' ', serviceName: 'payments-service' }, side: 'local' } },
      ] }} /></LanguageProvider>);
      const search = screen.getByRole('searchbox');
      fireEvent.change(search, { target: { value: local } });
      fireEvent.click((await screen.findAllByRole('button', { name: new RegExp(local) }))[0]);
      expect(screen.getByRole('heading', { name: local })).toBeTruthy();
      fireEvent.change(search, { target: { value: 'local_endpoint' } });
      expect(screen.getAllByRole('button', { name: /local_endpoint/ }).length).toBeGreaterThan(0);
      fireEvent.change(search, { target: { value: 'endpoint-resource-123' } });
      fireEvent.click(screen.getByRole('button', { name: /endpoint-resource-123/ }));
      expect(screen.getByRole('heading', { name: 'endpoint-resource-123' })).toBeTruthy();
      fireEvent.change(search, { target: { value: network } });
      expect(screen.getByRole('button', { name: new RegExp(network) })).toBeTruthy();
      fireEvent.change(search, { target: { value: 'payments-service' } });
      fireEvent.click(screen.getByRole('button', { name: /payments-service/ }));
      expect(screen.getByRole('heading', { name: 'payments-service' })).toBeTruthy();
    } finally { localStorage.clear(); }
  });
  it('provides an honest empty state instead of a blank canvas', () => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [], edges: [] }} />);
    expect(screen.getByText('표시할 관계 데이터가 없습니다.')).toBeTruthy();
  });

  it('lets a searched network connection expose its metric, window and NAT evidence', async () => {
    render(<E2eGraphCanvas graph={graph} />);
    fireEvent.change(screen.getByRole('searchbox', { name: '서비스 또는 리소스 검색' }), { target: { value: 'checkout-flow' } });
    fireEvent.click(await screen.findByRole('button', { name: '선택: checkout-flow' }));
    const detail = screen.getByRole('region', { name: '선택한 노드 상세' });
    expect(within(detail).getByText('8 KB')).toBeTruthy();
    expect(within(detail).getByText('192.0.2.1')).toBeTruthy();
    expect(within(detail).getByText('NAT:nat-demo')).toBeTruthy();
    expect(within(detail).getByText(/순서를 보장하지 않습니다/)).toBeTruthy();
  });

  it('filters network relations without changing the underlying observation graph', async () => {
    render(<E2eGraphCanvas graph={graph} />);
    await waitFor(() => expect(screen.getByTestId('e2e-network-edge-count').textContent).toBe('2'));
    fireEvent.click(screen.getByRole('checkbox', { name: '네트워크 관측' }));
    expect(screen.getByTestId('e2e-network-edge-count').textContent).toBe('0');
    expect(graph.edges).toHaveLength(3);
  });

  it('clears a hidden selection instead of stranding the enabled observation layers', async () => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [...graph.nodes,
      { id: 'isolated', kind: 'service', layer: 'service', label: 'isolated-service', meta: {} }] }} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'isolated-service' } });
    fireEvent.click(await screen.findByRole('button', { name: '선택: isolated-service' }));
    expect(screen.getByRole('region', { name: '선택한 노드 상세' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '서비스 관측' }));
    expect(screen.queryByRole('region', { name: '선택한 노드 상세' })).toBeNull();
    expect(screen.getByTestId('e2e-network-edge-count').textContent).toBe('2');
    fireEvent.click(screen.getByRole('checkbox', { name: '서비스 관측' }));
    expect(screen.queryByRole('region', { name: '선택한 노드 상세' })).toBeNull();
  });

  it('searches only eligible layers and tolerates cyclic source metadata', async () => {
    const meta: Record<string, unknown> = { owner: 'cyclic-owner' };
    meta.self = meta;
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [...graph.nodes,
      { id: 'configuration-only', kind: 'alb', layer: 'configuration', label: 'config-only', meta }] }} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cyclic-owner' } });
    expect(await screen.findByRole('button', { name: '선택: config-only' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '구성 관계' }));
    expect(screen.queryByRole('button', { name: '선택: config-only' })).toBeNull();
  });

  it.each([NaN, Infinity, -1])('shows an unavailable metric instead of rendering invalid value %s', async value => {
    const nodes = graph.nodes.map(node => node.id === 'f1'
      ? { ...node, meta: { ...node.meta, flow: { ...(node.meta.flow as object), value } } } : node);
    render(<E2eGraphCanvas graph={{ ...graph, nodes }} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout-flow' } });
    fireEvent.click(await screen.findByRole('button', { name: '선택: checkout-flow' }));
    const detail = screen.getByRole('region', { name: '선택한 노드 상세' });
    expect(within(detail).getByText('—')).toBeTruthy();
    expect(detail.textContent).not.toMatch(/NaN|Infinity|-1 B/);
  });

  it('keeps traversed type context readable when an ID list is unavailable', async () => {
    const nodes = graph.nodes.map(node => node.id === 'f1'
      ? { ...node, meta: { ...node.meta, flow: { ...(node.meta.flow as object), traversedIds: undefined } } } : node);
    render(<E2eGraphCanvas graph={{ ...graph, nodes }} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout-flow' } });
    fireEvent.click(await screen.findByRole('button', { name: '선택: checkout-flow' }));
    expect(within(screen.getByRole('region', { name: '선택한 노드 상세' })).getByText('NAT')).toBeTruthy();
  });

  it('discloses inferred service relations in selected evidence', async () => {
    render(<E2eGraphCanvas graph={{ ...graph,
      nodes: [...graph.nodes, { id: 's2', kind: 'service', layer: 'service', label: 'downstream', meta: {} }],
      edges: [...graph.edges, { id: 'inferred', source: 's1', target: 's2', relation: 'CALLS',
        evidence: 'service', directed: true, meta: { confidence: 'inferred' } }],
    }} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout' } });
    fireEvent.click(await screen.findByRole('button', { name: '선택: checkout' }));
    expect(within(screen.getByRole('region', { name: '선택한 노드 상세' })).getByText('추정 관계')).toBeTruthy();
  });

  it('keeps capped hub evidence, bounds details to 20 and discloses both omission counts', async () => {
    const services = Array.from({ length: 55 }, (_, i) => ({
      id: `s${i}`, kind: 'service', layer: 'service' as const, label: `service-${i}`, meta: {},
    }));
    const hub: E2eGraph = { ...graph,
      nodes: [{ id: 'hub', kind: 'alb', layer: 'configuration', label: 'config-hub', meta: {} }, ...services],
      edges: [
        ...services.slice(0, 20).flatMap(source => services.slice(20).map(target => ({
          id: `${source.id}-${target.id}`, source: source.id, target: target.id,
          evidence: 'service' as const, relation: 'calls', directed: true,
        }))),
        ...services.slice(0, 25).map(target => ({
          id: `hub-${target.id}`, source: 'hub', target: target.id,
          evidence: 'configuration' as const, relation: 'configured', directed: true,
        })),
      ],
    };
    render(<E2eGraphCanvas graph={hub} />);
    const detail = await select('config-hub');
    expect(detail.getAllByRole('listitem')).toHaveLength(20);
    expect(detail.getByText('+5 관계 더 있음')).toBeTruthy();
    expect(detail.getByText('캔버스에서 생략된 관계: 25')).toBeTruthy();
    expect(detail.queryByText('현재 관계 필터에서 연결 근거가 없습니다.')).toBeNull();
    await waitFor(() => expect(vi.mocked(ReactFlow).mock.lastCall?.[0].edges).toHaveLength(700));
  });

  it.each<{ readings: [string, string, number][]; expected: number }>([
    { readings: [['DATA_TRANSFERRED', 'Bytes', 1], ['DATA_TRANSFERRED', 'Bytes', 9]], expected: 1 },
    { readings: [['ROUND_TRIP_TIME', 'Milliseconds', 9999], ['DATA_TRANSFERRED', 'Bytes', 10]], expected: 1 },
    { readings: [['TIMEOUTS', 'Count', 2], ['ROUND_TRIP_TIME', 'Milliseconds', 9999], ['TIMEOUTS', 'Count', 3]], expected: 2 },
    { readings: [['DATA_TRANSFERRED', 'Bytes', 2], ['DATA_TRANSFERRED', 'Count', 9999], ['DATA_TRANSFERRED', 'Bytes', 3]], expected: 2 },
    { readings: [['ROUND_TRIP_TIME', 'Milliseconds', 2], ['ROUND_TRIP_TIME', 'Seconds', 9999], ['ROUND_TRIP_TIME', 'Milliseconds', 3]], expected: 2 },
    { readings: [['DATA_TRANSFERRED', 'Bytes', Infinity], ['DATA_TRANSFERRED', 'Bytes', NaN], ['DATA_TRANSFERRED', 'Bytes', -1], ['DATA_TRANSFERRED', 'Bytes', 0]], expected: 3 },
  ])('ranks main flow only inside the preferred metric and unit group: %j', async ({ readings, expected }) => {
    const nodes = readings.map(([metric, unit, value], i) => ({
      ...graph.nodes[3], id: `f${i}`, meta: { metric, unit,
        flow: { ...(graph.nodes[3].meta.flow as object), unit, value } },
    }));
    render(<E2eGraphCanvas graph={{ ...graph, nodes, edges: [] }} />);
    await waitFor(() => expect(vi.mocked(ReactFlow).mock.lastCall?.[0].fitViewOptions?.nodes)
      .toEqual([{ id: `f${expected}` }]));
  });

  it('shows per-row counts, withheld identity reasons and endpoint diagnostic fields', async () => {
    render(<E2eGraphCanvas graph={{ ...graph,
      summary: { ...graph.summary, unmatchedEndpoints: 40, ambiguousEndpoints: 2 },
      nodes: graph.nodes.map(node => node.id === 'p1' ? { ...node, label: 'endpoint-detail', meta: {
        correlation: 'ambiguous', correlationReason: 'workload_scope_unverified',
        endpoint: { podNamespace: 'shop', instanceId: 'i-demo', az: 'us-east-1a', subnetId: 'subnet-demo', serviceName: 'payments' },
      } } : node),
    }} />);
    expect(screen.getByText('미연결 관측 40')).toBeTruthy();
    expect(screen.getByText('식별 보류 관측 2')).toBeTruthy();
    expect(screen.getByText('관측 행의 로컬·원격을 각각 집계하며 고유 엔드포인트 수가 아닙니다.')).toBeTruthy();
    expect(screen.queryByText(/식별자 중복/)).toBeNull();
    const detail = await select('endpoint-detail');
    for (const value of ['식별 보류', 'workload_scope_unverified', 'shop', 'i-demo', 'us-east-1a', 'subnet-demo', 'payments']) {
      expect(detail.getByText(value)).toBeTruthy();
    }
    expect(detail.getByText('워크로드 범위를 확인할 수 없어 구성 기록 연결도 보류했습니다.')).toBeTruthy();
  });

  it('discloses the source sample cap and an unknown traversed list', async () => {
    const nodes = graph.nodes.map(node => node.id === 'f1' ? { ...node, meta: { ...node.meta, capped: true,
      flow: { ...(node.meta.flow as object), traversed: [], traversedIds: [] } } } : node);
    render(<E2eGraphCanvas graph={{ ...graph, nodes }} />);
    const detail = await select('checkout-flow');
    expect(detail.getByText('상위 기여자 표본 상한에 도달했습니다. 전체 트래픽을 나타내지 않습니다.')).toBeTruthy();
    expect(detail.getByText('관측에 경유 구성요소 정보가 없습니다.')).toBeTruthy();
    expect(detail.queryByText(/순서를 보장하지 않습니다/)).toBeNull();
  });

  it('discloses cached record labels and confidence only while their evidence is enabled', async () => {
    const captured = '2026-09-11T12:00:00Z';
    render(<E2eGraphCanvas graph={{ ...graph, edges: [{ id: 'cached', source: 'p1', target: 's1',
      relation: 'configured-endpoint-match', evidence: 'context', directed: false,
      label: 'cached_configured_endpoint_record', labelKey: 'cached_configured_endpoint_record', meta: { confidence: 'observed', ownership: 'unverified',
        ownership_evidence: 'cached_configuration', targetCapturedAt: captured } }] }} />);
    const detail = await select('shop/pod-a');
    expect(detail.getByText('캐시된 구성 엔드포인트 기록')).toBeTruthy();
    expect(detail.getByText('confidence: observed')).toBeTruthy();
    for (const value of ['ownership: unverified', 'ownership_evidence: cached_configuration',
      `targetCapturedAt: ${new Date(captured).toLocaleString()}`, '타깃 그룹의 수집 시각이며 소유권 확인 시각이 아닙니다.']) {
      expect(detail.getByText(value)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('checkbox', { name: '문맥 연결' }));
    const filtered = await select('shop/pod-a');
    expect(filtered.queryByText('캐시된 구성 엔드포인트 기록')).toBeNull();
    expect(filtered.getByText('현재 관계 필터에서 연결 근거가 없습니다.')).toBeTruthy();
  });
});
