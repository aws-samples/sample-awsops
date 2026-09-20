// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import type { DxConnectionRow } from '@/lib/dx';

vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ tt: (s: string) => s }),
}));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => 'light' }));
// Only replace the third-party canvas layout; DxTopology builds and renders its real labels.
vi.mock('next/dynamic', () => ({
  default: () => ({ nodes, onNodeClick }: {
    nodes: Node[]; edges: Edge[]; onNodeClick: (event: unknown, node: Node) => void;
  }) => <div>{nodes.map(n => (
    <button key={n.id} aria-label={n.id} style={n.style} onClick={e => onNodeClick(e, n)}>
      {n.data.label as ReactNode}
    </button>
  ))}</div>,
}));
import DxTopology from './DxTopology';

afterEach(cleanup);

function connection(state: string, metric: number | null): DxConnectionRow {
  return {
    id: 'dxcon-fixture', name: 'Fixture connection', state, stateMetricMin: metric,
    down: state === 'down' || metric === 0, region: 'ap-northeast-2', location: 'SEL1',
    bandwidth: '1Gbps', bandwidthBps: 1e9, partnerName: null, awsDevice: null,
    lagId: 'dxlag-fixture', vlan: null, vifCount: 0, hasLogicalRedundancy: null,
    jumboFrameCapable: false, macSecCapable: false, encryptionMode: null, portEncryptionStatus: null,
  };
}

describe('rendered DX topology evidence labels', () => {
  it.each(['pending', 'ordering', 'requested', 'available'])(
    'shows a %s member without metrics as unknown/unassessed, never up', state => {
      const row = connection(state, null);
      const selected = vi.fn();
      render(createElement(DxTopology, { data: { connections: [row], vifs: [], gateways: [] }, onNodeSelect: selected }));
      const lag = screen.getByRole('button', { name: 'dxlag-fixture' });
      expect(lag.textContent).toContain('0/1 up');
      expect(lag.textContent).toContain(state === 'available' ? '확인 불가 1' : '미평가 1');
      expect(screen.queryByText('LAG · 1/1 up')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: row.id }));
      expect(selected.mock.calls[0][0].row).toEqual(row);
    },
  );

  it('keeps excluded metric-zero evidence visible with period and deployment context', () => {
    render(createElement(DxTopology, {
      data: { connections: [connection('deleting', 0)], vifs: [], gateways: [] },
    }));
    const lag = screen.getByRole('button', { name: 'dxlag-fixture' });
    expect(lag.textContent).toContain('0/1 up');
    expect(lag.textContent).toContain('미평가 1');
    expect(lag.textContent).toContain('기간 내 DOWN 관측 1');
    expect(lag.querySelector('[title="현재 배포 장애 판정 아님"]')).toBeTruthy();
  });
});
