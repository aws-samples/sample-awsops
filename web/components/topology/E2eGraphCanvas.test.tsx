// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ReactFlow, getNodesBounds, getViewportForBounds, type ReactFlowProps } from '@xyflow/react';
import E2eGraphCanvas from './E2eGraphCanvas';
import { LanguageProvider } from '@/components/shell/LanguageProvider';
import { buildFlowGraph } from '@/lib/flow-topology';
import { buildE2eGraph, selectE2eGraph } from '@/lib/e2e-topology';
import type { E2eGraph, E2eNode } from '@/lib/e2e-topology-types';
import { applyTerms } from '@/lib/i18n-terms';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

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
  summary: { configuredNodes: 0, serviceNodes: 1, networkFlows: 1, correlatedEndpoints: 1,
    unmatchedEndpoints: 1, ambiguousEndpoints: 0, observationsUnsupported: false,
    configurationComplete: true, servicesComplete: true,
    networkRead: { status: 'partial', failedCategories: ['INTER_VPC'], unknownWindowCategories: [] } },
};

function renderConnection(flow: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  const nodes = graph.nodes.map(node => node.id === 'f1'
    ? { ...node, meta: { ...node.meta, ...meta, flow: { ...(node.meta.flow as object), ...flow } } } : node);
  return render(<E2eGraphCanvas graph={{ ...graph, nodes }} />);
}

async function select(label: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: label } });
  fireEvent.click(await screen.findByRole('button', { name: `선택: ${label}` }));
  return within(screen.getByRole('region', { name: '선택한 노드 상세' }));
}

describe('E2eGraphCanvas', () => {
  it.each(['ko', 'en', 'zh', 'ja'] as const)('names the actual context control in the %s guide', lang => {
    const label = applyTerms(lang, '참고 정보 (캐시된 구성·경유 구성요소)');
    const path = lang === 'ko' ? '../../../docs-site/docs/resources/topology.md'
      : `../../../docs-site/i18n/${lang}/docusaurus-plugin-content-docs/current/resources/topology.md`;
    localStorage.setItem('awsops-lang', lang);
    try {
      render(<LanguageProvider><E2eGraphCanvas graph={graph} /></LanguageProvider>);
      expect(screen.getByRole('checkbox', { name: label, exact: true })).toBeTruthy();
      const guide = readSource(path);
      expect(guide).toContain(`**${label}**`);
      expect(guide.split(label).length - 1).toBeGreaterThanOrEqual(2);
    } finally { localStorage.clear(); }
  });
  it('qualifies real builder endpoint labels and retains service-only identities', async () => {
    const built = buildE2eGraph({
      account: 'self', configured: { nodes: [], edges: [] }, services: null,
      network: [{ metric: 'DATA_TRANSFERRED', unit: 'Bytes', category: 'INTER_AZ',
        monitor: 'fixture', cluster: 'fixture', rangeSec: 60, rows:
        ['shop', 'payments'].map(podNamespace => ({
          local: { podNamespace, podName: 'web-1' }, remote: { serviceName: 'external-api' },
          value: 1, unit: 'Bytes', category: 'INTER_AZ',
        })) }],
    });
    render(<E2eGraphCanvas graph={built} />);
    await screen.findByTitle('shop/web-1');
    await screen.findByTitle('payments/web-1');
    expect(await screen.findAllByTitle('external-api')).toHaveLength(2);
  });
  it.each([false, true])('discloses incomplete sources even without service nodes (hasServices=%s)', async hasServices => {
    const configured = buildFlowGraph({ tg: [{ resource_id: 'tg-one', target_type: 'ip',
      target_health_descriptions: [{ Target: { Id: '10.0.1.1', Port: 80 } }] }] });
    const built = buildE2eGraph({ account: 'self', configured,
      services: hasServices ? { nodes: [{ id: 'service', kind: 'service', label: 'service', meta: {} }], edges: [], captured_at: null } : null,
      configurationComplete: false, servicesComplete: false, network: [],
    });
    render(<E2eGraphCanvas graph={built} />);
    expect(screen.getByText('구성 근거를 확인할 수 없어 연결을 보류했습니다.')).toBeTruthy();
    expect(screen.getByText('서비스 근거의 완전성·신선도를 확인할 수 없어 워크로드 식별을 보류했습니다.')).toBeTruthy();
    await waitFor(() => {
      const props = vi.mocked(ReactFlow).mock.lastCall?.[0];
      const target = built.nodes.find(node => node.kind === 'target')!;
      expect(props?.nodes.find(node => node.id === target.id)?.data.label).toBeTruthy();
      expect(screen.getAllByText(/구성 · 식별 보류/).length).toBeGreaterThan(0);
    });
  });
  it('keeps omittedCategories label-only and safely counts missing or prototype-like labels', () => {
    const nodes = ['', '__proto__'].flatMap((category, i) => [
      { ...graph.nodes[1], id: `local-${i}` }, { ...graph.nodes[2], id: `remote-${i}` },
      { ...graph.nodes[3], id: `flow-${i}`, meta: { ...graph.nodes[3].meta, category } },
    ]);
    const edges = [0, 1].flatMap(i => ['local', 'remote'].map(side => ({
      id: `${side}-${i}`, source: `${side}-${i}`, target: `flow-${i}`,
      evidence: 'network' as const, relation: side, directed: false,
    })));
    const view = selectE2eGraph({ ...graph, nodes, edges }, { maxNodes: 1 });
    expect(view.omittedCategories).toEqual(['__proto__']);
    expect(view.omittedCategoryCounts['']).toBe(1);
    expect(view.omittedCategoryCounts.__proto__).toBe(1);
    expect(Object.getPrototypeOf(view.omittedCategoryCounts)).toBeNull();
  });
  it('keeps navigation controls without exposing the interaction unlock', async () => {
    render(<E2eGraphCanvas graph={graph} />);
    const controls = await screen.findByTestId('rf__controls');
    expect(controls.querySelector('.react-flow__controls-zoomin')).not.toBeNull();
    expect(controls.querySelector('.react-flow__controls-fitview')).not.toBeNull();
    expect(controls.querySelector('.react-flow__controls-interactive')).toBeNull();
  });
  it('keeps a completed empty network read distinct from missing observations', () => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [], edges: [],
      summary: { ...graph.summary, networkFlows: 0,
        networkRead: { status: 'complete', failedCategories: [], unknownWindowCategories: [] } },
    }} />);
    expect(screen.getByText('표시할 네트워크 관측이 없습니다.')).toBeTruthy();
    expect(screen.queryByText('네트워크 관측 데이터가 없어 연결 여부를 집계할 수 없습니다.')).toBeNull();
  });
  it('withholds correlation totals when the read is unsupported despite retained rows', () => {
    render(<E2eGraphCanvas graph={{ ...graph, summary: { ...graph.summary,
      networkRead: { status: 'unsupported', failedCategories: [], unknownWindowCategories: [] },
    }}} />);
    expect(screen.getByText('이 계정에서 네트워크 관측을 사용할 수 없습니다.')).toBeTruthy();
    expect(screen.queryByText(/미연결 관측/)).toBeNull();
  });
  it.each(['ko', 'en', 'zh', 'ja'] as const)('covers every canvas prose literal and label catalog in %s', lang => {
    const source = ts.createSourceFile('canvas.tsx',
      readSource('./E2eGraphCanvas.tsx'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const literals = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) && /[가-힣]/.test(node.text)) literals.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(literals.has('서비스 근거의 완전성·신선도를 확인할 수 없어 워크로드 식별을 보류했습니다.')).toBe(true);
    for (const literal of literals) {
      if (lang === 'ko') expect(applyTerms(lang, literal)).toBe(literal);
      else expect(applyTerms(lang, literal), literal).not.toBe(literal);
    }
  });
  it('fits the primary flow with both corroborated targets and workloads inside the actual canvas', async () => {
    const region = 'us-east-1', vpcId = 'vpc-demo', account = '000000000000';
    const names = ['frontend', 'orders'];
    const endpoint = (i: number) => ({ ip: `10.0.${i + 1}.10`, region, vpcId,
      podName: `${names[i]}-a`, podNamespace: 'shop' });
    const configured = buildFlowGraph({
      tg: names.map((name, i) => ({ resource_id: `tg-${name}`, region, account_id: account,
        vpc_id: vpcId, target_type: 'ip', target_health_descriptions: [{ Target: { Id: endpoint(i).ip, Port: 8080 } }] })),
      ipResolved: Object.fromEntries(names.map((name, i) => [`${region}|${vpcId}|${endpoint(i).ip}`, {
        label: name, resolved: 'eks', meta: { cluster: 'demo', namespace: 'shop', pod: `${name}-a` },
      }])),
    });
    const built = buildE2eGraph({
      account: 'self', hostAccountId: account, configured, configurationComplete: true, servicesComplete: true,
      services: { captured_at: '2026-09-11T12:00:00Z',
        nodes: names.flatMap(name => [
          { id: `svc:${name}`, kind: 'service', label: name, meta: { accountId: account, region } },
          { id: `workload:${name}`, kind: 'workload', label: `shop/${name}`, meta: {
            cluster: 'demo', namespace: 'shop', pods: [`${name}-a`], accountId: account, region,
          } },
        ]),
        edges: [{ source: 'svc:frontend', target: 'svc:orders', rel: 'calls' },
          ...names.map(name => ({ source: `svc:${name}`, target: `workload:${name}`, rel: 'runs_on' }))],
      },
      network: (['INTER_AZ', 'INTER_VPC', 'AMAZON_S3'] as const).map((category, i) => ({
        monitor: 'nfm-demo', cluster: 'demo', metric: 'DATA_TRANSFERRED', unit: 'Bytes', category, rangeSec: 900, capped: false,
        rows: [{ local: endpoint(0), remote: i ? { ip: `198.51.100.${i}`, region, vpcId: 'vpc-peer' } : endpoint(1),
          value: i ? 8388608 : 16777216, unit: 'Bytes', category, traversed: [], traversedIds: [] }],
      })),
    });
    expect(built.edges.filter(edge => edge.evidence === 'identity')).toHaveLength(8);
    render(<E2eGraphCanvas graph={built} />);
    await waitFor(() => expect(vi.mocked(ReactFlow).mock.lastCall?.[0].fitViewOptions?.nodes).toHaveLength(7));
    const props = vi.mocked(ReactFlow).mock.lastCall![0], options = props.fitViewOptions!;
    const ids = new Set(options.nodes!.map(node => node.id));
    const fitted = props.nodes!.filter(node => ids.has(node.id)).map(node => ({ ...node, width: 232, height: 76 }));
    expect(built.nodes.filter(node => ids.has(node.id) && node.kind === 'target')).toHaveLength(2);
    expect(built.nodes.filter(node => ids.has(node.id) && node.kind === 'workload')).toHaveLength(2);
    const bounds = getNodesBounds(fitted);
    for (const [width, height] of [[1294, 900], [1294, 478], [900, 478]]) {
      const viewport = getViewportForBounds(bounds, width, height, options.minZoom!, options.maxZoom!, options.padding);
      if (height === 900) expect(viewport.zoom).toBeGreaterThanOrEqual(0.7);
      expect(bounds.x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(0);
      expect((bounds.x + bounds.width) * viewport.zoom + viewport.x).toBeLessThanOrEqual(width);
      expect(bounds.y * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(0);
      expect((bounds.y + bounds.height) * viewport.zoom + viewport.y).toBeLessThanOrEqual(height);
    }
  });
  it.each(['2026-09-10T08:00:00Z', null])('separates genuine service capture from the legacy snapshot clock: %j', async captured_at => {
    const snapshot = '2026-09-11T10:00:00Z';
    const built = buildE2eGraph({
      account: 'self', configured: { nodes: [], edges: [] }, network: [],
      services: {
        nodes: [{ id: 'service', kind: 'svc', label: 'timed-service', captured_at },
          { id: 'db', kind: 'db', label: 'timed-database' }],
        edges: [{ source: 'service', target: 'db', rel: 'calls' }], captured_at: snapshot,
      },
    });
    render(<E2eGraphCanvas graph={built} />);
    const detail = await select('timed-service');
    const capture = detail.getByText('노드 수집 시각').nextElementSibling;
    expect(capture?.querySelector('time')?.dateTime ?? null).toBe(captured_at);
    const clocks = detail.getAllByText('스냅샷 표시 시각');
    expect(clocks).toHaveLength(2); // Node and service edge; neither fabricates edge capture.
    expect(clocks[0].nextElementSibling?.querySelector('time')?.dateTime).toBe(snapshot);
    expect(detail.getByText('스냅샷 표시 시각은 개별 노드·관계의 수집 시각이나 관측 구간이 아닙니다.')).toBeTruthy();
    for (const time of screen.getByRole('region', { name: '선택한 노드 상세' }).querySelectorAll('time')) {
      expect(time.textContent).toContain('UTC');
    }
    expect(built.summary.servicesComplete).toBe(false);
  });
  it('keeps an incomplete workload read visible on endpoint details', async () => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: graph.nodes.map(node => node.id === 'p1'
      ? { ...node, meta: { ...node.meta, workloadReadStatus: 'partial' } } : node) }} />);
    const detail = await select('shop/pod-a');
    expect(detail.getByText('workloadReadStatus').nextElementSibling?.textContent).toBe('partial');
  });
  it.each([false, true].flatMap(cached => ['2026-09-11T08:00:00Z', null].map(captured_at => ({ cached, captured_at }))))(
    'preserves target-group time as configuration evidence: %j', async ({ cached, captured_at }) => {
      const region = 'us-east-1', vpcId = 'vpc-app', ip = '10.0.1.10';
      const configured = buildFlowGraph({
        ownershipRead: { configurationOnly: cached },
        tg: [{ resource_id: 'tg', region, vpc_id: vpcId, captured_at, target_type: 'ip',
          target_health_descriptions: [{ Target: { Id: ip } }] }],
        ipResolved: { [`${region}|${vpcId}|${ip}`]: {
          label: 'configured-workload', resolved: 'eks', meta: { cluster: 'app' },
        } },
      });
      const built = buildE2eGraph({ account: 'self', configurationComplete: true, configured, services: null, network: [{
        monitor: 'monitor', cluster: null, metric: 'DATA_TRANSFERRED', category: 'INTER_AZ',
        rangeSec: 900, unit: 'Bytes', capped: false, rows: [{
          local: { ip, region, vpcId }, remote: {}, value: 1, unit: 'Bytes',
          category: 'INTER_AZ', traversed: [], traversedIds: [],
        }],
      }] });
      render(<E2eGraphCanvas graph={built} />);
      const card = (await screen.findByTitle('configured-workload')).closest('[data-e2e-kind="target"]') as HTMLElement;
      expect(within(card).queryByText('구성 · 식별 보류') !== null).toBe(cached);
      expect(card.querySelector('.lucide-circle-question-mark') !== null).toBe(cached);
      const detail = await select('configured-workload');
      expect(detail.getAllByText('대상 그룹 수집 시각')).toHaveLength(2);
      expect(detail.getByText('대상 그룹 구성의 시각이며 소유권 증거의 시각이 아닙니다.')).toBeTruthy();
      expect(detail.queryByText('capturedAt')).toBeNull();
      const regionEl = screen.getByRole('region', { name: '선택한 노드 상세' });
      expect(regionEl.querySelectorAll('time')).toHaveLength(captured_at ? 2 : 0);
      for (const time of regionEl.querySelectorAll('time')) {
        expect(time.dateTime).toBe(captured_at);
        expect(time.textContent).toContain('UTC');
      }
      if (cached) {
        expect(built.edges.filter(e => e.evidence === 'identity')).toHaveLength(0);
        expect(detail.getByText('eks_not_enumerated')).toBeTruthy();
      }
      fireEvent.click(screen.getByRole('checkbox', {
        name: cached ? '참고 정보 (캐시된 구성·경유 구성요소)' : '식별자 연결',
      }));
      expect((await select('configured-workload')).getAllByText('대상 그룹 수집 시각')).toHaveLength(1);
    });
  it('keeps unverified candidates separate from target identity', async () => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [...graph.nodes, {
      id: 'candidate-target', kind: 'target', layer: 'configuration', label: 'unresolved-target',
      meta: { resolved: 'ambiguous', ownership_evidence: 'scope_unverified', ownership_reason: 'region_missing',
        candidate: { label: 'possible-task', resolved: 'ecs',
          meta: { task: 'task-candidate', region: 'us-east-1' } } },
    }] }} />);
    const detail = await select('unresolved-target');
    expect(detail.getByText('scope_unverified')).toBeTruthy();
    expect(detail.getByText('region_missing')).toBeTruthy();
    const candidate = detail.getByRole('region', { name: '소유권 미확인 후보' });
    expect(within(candidate).getByText('possible-task')).toBeTruthy();
    expect(within(candidate).getByText('task-candidate')).toBeTruthy();
    expect(detail.getByText('현재 관계 필터에서 연결 근거가 없습니다.')).toBeTruthy();
  });
  it.each([false, true])('does not turn absent/unsupported observations into zero unmatched counts: %s', unsupported => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [], edges: [],
      summary: { ...graph.summary, networkFlows: 0, unmatchedEndpoints: 0, observationsUnsupported: unsupported } }} />);
    expect(screen.queryByText('미연결 관측 0')).toBeNull();
    expect(screen.getByText(unsupported ? '이 계정에서 네트워크 관측을 사용할 수 없습니다.' : '네트워크 관측 데이터가 없어 연결 여부를 집계할 수 없습니다.')).toBeTruthy();
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
      'ownership_unverified', 'e2e_correlation_blocked', 'true', '대상 그룹 수집 시각',
      '대상 그룹 구성의 시각이며 소유권 증거의 시각이 아닙니다.']) expect(detail.getByText(value)).toBeTruthy();
    const capturedTime = detail.getByText('대상 그룹 수집 시각').nextElementSibling?.querySelector('time');
    expect(capturedTime?.dateTime).toBe(captured);
    expect(capturedTime?.textContent).toContain('UTC');
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
    expect(screen.getByText(/표시 한도로 제한된 관측 \(분류별\):/).textContent).toContain('INTER_AZ');
  });
  it.each([
    ['ko', '로컬 엔드포인트', '네트워크 관측'], ['en', 'Local endpoint', 'Network observations'],
    ['zh', '本地端点', '网络观测'], ['ja', 'ローカルエンドポイント', 'ネットワーク観測'],
  ])('localizes generated labels in %s while preserving resource names in search and details', async (lang, local, network) => {
    localStorage.setItem('awsops-lang', lang);
    try {
      render(<LanguageProvider><E2eGraphCanvas graph={{ ...graph, nodes: [
        { ...graph.nodes[1], label: 'local_endpoint', labelKey: 'local_endpoint', meta: { endpoint: { podName: ' ' }, side: 'local' } },
        { ...graph.nodes[0], label: '로컬 엔드포인트' },
        { ...graph.nodes[0], id: 'raw-source-name', label: 'local_endpoint' },
        { ...graph.nodes[2], label: 'endpoint-resource-123', meta: { endpoint: {}, side: 'remote' } },
        { ...graph.nodes[3], label: 'network_observation', labelKey: 'network_observation', meta: { ...graph.nodes[3].meta, metric: '' } },
        { ...graph.nodes[1], id: 'service-endpoint', label: 'local_endpoint', labelKey: 'local_endpoint',
          meta: { endpoint: { podName: ' ', serviceName: 'payments-service' }, side: 'local' } },
      ] }} /></LanguageProvider>);
      const search = screen.getByRole('searchbox');
      fireEvent.change(search, { target: { value: local } });
      fireEvent.click((await screen.findAllByRole('button', { name: new RegExp(local) }))[0]);
      expect(screen.getByRole('heading', { name: local })).toBeTruthy();
      fireEvent.change(search, { target: { value: '로컬 엔드포인트' } });
      expect(screen.getAllByRole('button', { name: /로컬 엔드포인트/ }).length).toBeGreaterThan(0);
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
    renderConnection({ value });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout-flow' } });
    fireEvent.click(await screen.findByRole('button', { name: '선택: checkout-flow' }));
    const detail = screen.getByRole('region', { name: '선택한 노드 상세' });
    expect(within(detail).getByTestId('e2e-selected-metric').textContent).toBe('—');
    expect(detail.textContent).not.toMatch(/NaN|Infinity|-1 B/);
  });

  it('keeps traversed type context readable when an ID list is unavailable', async () => {
    renderConnection({ traversedIds: undefined });
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
    renderConnection({ traversed: [], traversedIds: [] }, { capped: true });
    const detail = await select('checkout-flow');
    expect(detail.getByText('상위 기여자 표본 상한에 도달했습니다. 전체 트래픽을 나타내지 않습니다.')).toBeTruthy();
    expect(detail.getByText('관측에 경유 구성요소 정보가 없습니다.')).toBeTruthy();
    expect(detail.queryByText(/순서를 보장하지 않습니다/)).toBeNull();
  });

  it('discloses cached record labels and confidence only while their evidence is enabled', async () => {
    const captured = '2026-09-11T12:00:00Z';
    render(<E2eGraphCanvas graph={{ ...graph, edges: [{ id: 'cached', source: 'p1', target: 's1',
      relation: 'configured-endpoint-match', evidence: 'context', directed: false,
      label: 'Cached configured endpoint record', meta: { confidence: 'observed', ownership: 'unverified',
        ownership_evidence: 'cached_configuration', targetCapturedAt: captured } }] }} />);
    const detail = await select('shop/pod-a');
    expect(detail.getByText('캐시된 구성 엔드포인트 기록')).toBeTruthy();
    expect(detail.getByText('confidence: observed')).toBeTruthy();
    for (const value of ['ownership: unverified', 'ownership_evidence: cached_configuration',
      '대상 그룹 구성의 시각이며 소유권 증거의 시각이 아닙니다.']) {
      expect(detail.getByText(value)).toBeTruthy();
    }
    const time = screen.getByRole('region', { name: '선택한 노드 상세' }).querySelector('time');
    expect(time?.dateTime).toBe(captured);
    expect(time?.textContent).toContain('UTC');
    fireEvent.click(screen.getByRole('checkbox', { name: '참고 정보 (캐시된 구성·경유 구성요소)' }));
    const filtered = await select('shop/pod-a');
    expect(filtered.queryByText('캐시된 구성 엔드포인트 기록')).toBeNull();
    expect(filtered.getByText('현재 관계 필터에서 연결 근거가 없습니다.')).toBeTruthy();
  });
  it.each([false, true])('does not report zero unlinked observations without usable network data (unsupported=%s)', unsupported => {
    render(<E2eGraphCanvas graph={{ ...graph,
      summary: { ...graph.summary, networkFlows: 0, unmatchedEndpoints: 0, observationsUnsupported: unsupported },
    }} />);
    expect(screen.queryByText('미연결 관측 0')).toBeNull();
    expect(screen.queryByText('관측 행의 로컬·원격을 각각 집계하며 고유 엔드포인트 수가 아닙니다.')).toBeNull();
    expect(screen.getByText(unsupported ? '이 계정에서 네트워크 관측을 사용할 수 없습니다.'
      : '네트워크 관측 데이터가 없어 연결 여부를 집계할 수 없습니다.')).toBeTruthy();
  });
  it('shows the matched pod and grouped pod evidence in selected workload details', async () => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [...graph.nodes, {
      id: 'workload', kind: 'workload', layer: 'service', label: 'pod-workload',
      meta: { cluster: 'shop', namespace: 'default', pod: 'pod-a', pods: ['pod-a', 'pod-b'] },
    }] }} />);
    const detail = await select('pod-workload');
    expect(detail.getByText('pod-a')).toBeTruthy();
    expect(detail.getByText('pod-a, pod-b')).toBeTruthy();
  });
  it('keeps the largest flow before display caps and names omitted observation categories', async () => {
    const observations = Array.from({ length: 120 }, (_, i) => {
      const id = String(i).padStart(3, '0');
      return {
        nodes: [
          { ...graph.nodes[1], id: `p${id}-local` },
          { ...graph.nodes[2], id: `p${id}-remote` },
          { ...graph.nodes[3], id: `f${id}`, label: `flow-${id}`, meta: {
            ...graph.nodes[3].meta, category: i === 119 ? 'INTER_VPC' : 'INTER_AZ',
            flow: { ...(graph.nodes[3].meta.flow as object), value: i === 119 ? 999999 : 1 },
          } },
        ],
        edges: [
          { ...graph.edges[1], id: `n${id}-local`, source: `p${id}-local`, target: `f${id}` },
          { ...graph.edges[2], id: `n${id}-remote`, source: `f${id}`, target: `p${id}-remote` },
        ],
      };
    });
    render(<E2eGraphCanvas graph={{ ...graph, nodes: observations.flatMap(o => o.nodes),
      edges: observations.flatMap(o => o.edges), summary: { ...graph.summary, networkFlows: 120 },
    }} />);
    await waitFor(() => {
      const props = vi.mocked(ReactFlow).mock.lastCall?.[0];
      expect(props?.fitViewOptions?.nodes).toEqual(expect.arrayContaining([{ id: 'f119' }]));
      expect(props?.nodesDraggable).toBe(false);
      expect(props?.nodesConnectable).toBe(false);
    });
    expect(screen.getByText('표시 한도로 제한된 관측 (분류별): INTER_AZ: 4')).toBeTruthy();
  });

  it('labels a still-visible partial observation as display-limited, not an absent category', async () => {
    const configs: E2eNode[] = Array.from({ length: 349 }, (_, i) => ({
      id: `config-${i}`, kind: 'origin', label: `needle-${i}`, layer: 'configuration', meta: {},
    }));
    render(<E2eGraphCanvas graph={{ ...graph,
      nodes: [...configs, graph.nodes[1], graph.nodes[2], { ...graph.nodes[3], label: 'needle-flow' }],
      edges: graph.edges.filter(edge => edge.evidence === 'network'),
    }} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'needle' } });
    await screen.findByText('표시 한도로 제한된 관측 (분류별): INTER_AZ: 1');
    const props = vi.mocked(ReactFlow).mock.lastCall?.[0];
    expect(props?.nodes.some(node => node.id === 'f1')).toBe(true);
    expect(props?.edges).toHaveLength(0);
  });

  it.each([
    { count: Infinity }, { count: Number.NaN }, { count: '25' }, { count: -1 }, { count: 25.5 },
    { membersTruncated: Infinity }, { membersTruncated: '5' },
    { membersTruncated: Number.MAX_SAFE_INTEGER },
  ])('keeps grouped details while refusing an unsafe remaining-member count: %j', async invalid => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [...graph.nodes, {
      id: 'invalid-count', kind: 'target', layer: 'configuration', label: 'grouped-count',
      meta: { count: 25, membersTruncated: 5, pod: 'borrowed-pod', namespace: 'borrowed-namespace',
        members: Array.from({ length: 20 }, (_, i) => `member-${i}`),
        memberIdentities: Array.from({ length: 20 }, (_, i) => ({
          id: `member-${i}`, namespace: 'ns', pod: `pod-${i}`,
        })), ...invalid },
    }] }} />);
    const detail = await select('grouped-count');
    expect(detail.queryByText('borrowed-pod')).toBeNull();
    expect(detail.queryByText('borrowed-namespace')).toBeNull();
    expect(detail.getAllByText('추가 멤버 수 미확인')).toHaveLength(2);
    expect(detail.queryByText(/Infinity|NaN/)).toBeNull();
    const identities = within(detail.getByText('memberIdentities').nextElementSibling as HTMLElement);
    expect(identities.getAllByRole('listitem')).toHaveLength(20);
  });
});
