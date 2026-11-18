// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ServiceDetailPanel from './ServiceDetailPanel';
import type { GNode, ServiceDetail } from '@/lib/k8s-service-graph';
import type { NodeRow, PodRow } from '@/lib/eks-resources';

afterEach(cleanup);

const pod = (over: Partial<PodRow> & Pick<PodRow, 'name'>): PodRow => ({
  namespace: 'prod', status: 'Running', node: 'node-a', restarts: 0, age: '1h', cpuRequest: 0, memRequest: 0, diskRequest: 0, ...over,
});
const nodeRow = (over: Partial<NodeRow> & Pick<NodeRow, 'name'>): NodeRow => ({
  status: 'Ready', roles: '', version: 'v1.31', instanceType: 'm7g.large', zone: 'apne2-a', age: '9d',
  cpuCapacity: 4, cpuAllocatable: 4, memCapacity: 16384, memAllocatable: 15000, diskCapacity: 0, diskAllocatable: 0, ...over,
});
const gnode = (id: string, kind: GNode['kind'], label: string, namespace: string | null = 'prod'): GNode =>
  ({ id, kind, label, namespace, meta: {} });

const service = { ...gnode('svc:prod/api', 'service', 'api'), sub: 'ClusterIP · 172.20.0.10' };
const detail: ServiceDetail = {
  pods: [
    pod({ name: 'api-1', status: 'Running', restarts: 0, node: 'node-a' }),
    pod({ name: 'api-2', status: 'CrashLoopBackOff', restarts: 7, node: 'node-b' }),
  ],
  nodes: [
    { ...nodeRow({ name: 'node-a' }), readyText: 'Ready' },
    { ...nodeRow({ name: 'node-b', status: 'running', source: 'aws-api' }), readyText: 'running · Ready unknown' },
  ],
  callers: [gnode('gw:prod/web', 'gateway', 'web-ingress')],
  callees: [gnode('svc:prod/pay', 'service', 'payments')],
  datastores: [gnode('ds:rds_cluster:111111111111:ap-northeast-2:orders', 'datastore', 'orders', null)],
  secretRefs: ['api-key', 'db-password'],
};

describe('ServiceDetailPanel', () => {
  it('lists Pods with status, restarts and node', () => {
    render(<ServiceDetailPanel detail={detail} service={service} onClose={() => {}} />);
    const panel = screen.getByRole('complementary', { name: '서비스 상세' });
    expect(within(panel).getByText('api')).toBeTruthy();
    const pods = within(panel).getByRole('table', { name: 'Pod 목록' });
    const row = within(pods).getByText('api-2').closest('tr')!;
    expect(within(row).getByText('CrashLoopBackOff')).toBeTruthy();
    expect(within(row).getByText('7')).toBeTruthy();
    expect(within(row).getByText('node-b')).toBeTruthy();
  });

  it('lists Nodes with their ready text, including "Ready unknown" for EC2-view rows', () => {
    render(<ServiceDetailPanel detail={detail} service={service} onClose={() => {}} />);
    const nodes = screen.getByRole('table', { name: '노드' });
    expect(within(within(nodes).getByText('node-a').closest('tr')!).getByText('Ready')).toBeTruthy();
    expect(within(within(nodes).getByText('node-b').closest('tr')!).getByText('running · Ready unknown')).toBeTruthy();
  });

  it('shows callers, callees and datastores', () => {
    render(<ServiceDetailPanel detail={detail} service={service} onClose={() => {}} />);
    expect(within(screen.getByRole('list', { name: '호출 주체' })).getByText('web-ingress')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: '호출 대상' })).getByText('payments')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: '데이터 저장소' })).getByText('orders')).toBeTruthy();
  });

  it('shows Secret references as name-only badges', () => {
    render(<ServiceDetailPanel detail={detail} service={service} onClose={() => {}} />);
    expect(screen.getByText('Secret 참조: db-password')).toBeTruthy();
    expect(screen.getByText('Secret 참조: api-key')).toBeTruthy();
  });

  it('shows an empty marker for empty sections and no Secret badges', () => {
    const empty: ServiceDetail = { pods: [], nodes: [], callers: [], callees: [], datastores: [], secretRefs: [] };
    render(<ServiceDetailPanel detail={empty} service={service} onClose={() => {}} />);
    expect(screen.getAllByText('없음').length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText(/Secret 참조/)).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('closes from the close button and on Escape', () => {
    const onClose = vi.fn();
    render(<ServiceDetailPanel detail={detail} service={service} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    fireEvent.keyDown(screen.getByRole('complementary', { name: '서비스 상세' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
