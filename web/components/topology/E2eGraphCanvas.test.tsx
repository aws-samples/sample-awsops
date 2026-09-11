// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import E2eGraphCanvas from './E2eGraphCanvas';
import type { E2eGraph } from '@/lib/e2e-topology-types';

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub); });
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
    unmatchedEndpoints: 1, ambiguousEndpoints: 0, observationsUnsupported: false },
};

describe('E2eGraphCanvas', () => {
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
});
