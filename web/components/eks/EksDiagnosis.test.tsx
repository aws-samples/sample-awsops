// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import EksDiagnosis from './EksDiagnosis';
import type { EksMetricStatus } from '@/lib/eks-metrics-types';

vi.mock('@/components/inventory/metrics/DiagnosisGuide', () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function showQuality(clusterStatus: EksMetricStatus, nodeStatus: EksMetricStatus = clusterStatus) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.includes('/metrics') ? {
      accountId: '222222222222', region: 'us-west-2',
      controlPlane: { p99Get: 0.42 }, cluster: { nodeCount: null },
      nodes: nodeStatus === 'ok' || nodeStatus === 'partial' ? { 'member-node': { cpu: 17 } } : {},
      sources: {
        controlPlane: { status: 'ok' }, cluster: { status: clusterStatus }, nodes: { status: nodeStatus },
      },
    } : { rows: [] },
  })));
  return render(<EksDiagnosis cluster="arn:aws:eks:us-west-2:222222222222:cluster/shared" />);
}

it('shows member read denial instead of suggesting that Container Insights is not installed', async () => {
  showQuality('denied');
  await screen.findAllByText(/조회 거부/);
  expect(screen.queryByText(/Container Insights 미감지/)).toBeNull();
  expect(screen.queryByText(/설치/)).toBeNull();
  expect(screen.getByText(/222222222222/)).toBeTruthy();
  expect(screen.getByText(/us-west-2/)).toBeTruthy();
  expect(screen.getByText('420 ms')).toBeTruthy();
});

it('keeps successful source values visible beside an unavailable source', async () => {
  showQuality('unavailable', 'ok');
  await screen.findByText(/CloudWatch 조회 실패/);
  expect(screen.getByText('420 ms')).toBeTruthy();
  expect(screen.getByText('member-node')).toBeTruthy();
  expect(screen.queryByText(/설치/)).toBeNull();
});

it('does not suggest installation when metric result envelopes are unavailable', async () => {
  showQuality('unavailable', 'unavailable');
  await screen.findAllByText(/CloudWatch 조회 실패/);
  expect(screen.queryByText(/조회는 성공했지만 선택 기간의 지표가 없습니다/)).toBeNull();
  expect(screen.queryByText(/설치/)).toBeNull();
});

it('only suggests checking installation after both Container Insights queries successfully return no data', async () => {
  showQuality('no-data');
  await screen.findByText(/조회는 성공했지만 선택 기간의 지표가 없습니다/);
  expect(screen.getByText(/설치 상태를 확인/)).toBeTruthy();
  expect(screen.queryByText(/미설치|미감지/)).toBeNull();
});

it('does not suggest installation if cluster no-data is accompanied by node denial', async () => {
  showQuality('no-data', 'denied');
  await screen.findAllByText(/조회 거부/);
  expect(screen.queryByText(/설치/)).toBeNull();
});

it('discloses partial data while retaining its usable values', async () => {
  showQuality('ok', 'partial');
  await screen.findByText(/일부 데이터/);
  expect(screen.getByText('member-node')).toBeTruthy();
  expect(screen.queryByText(/설치/)).toBeNull();
});

it('does not interpret a legacy response without quality metadata as missing installation', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.includes('/metrics') ? { controlPlane: {}, cluster: {}, nodes: {} } : { rows: [] },
  })));
  render(<EksDiagnosis cluster="shared" />);
  await screen.findByText(/조회 상태 미확인/);
  expect(screen.queryByText(/설치/)).toBeNull();
});

it('clears host metrics and Kubernetes rows when changing to a namesake member', async () => {
  const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes(encodeURIComponent(ARN))) return new Promise(() => {});
    return { ok: true, json: async () => url.includes('/metrics')
      ? { controlPlane: {}, cluster: {}, nodes: { 'host-metric-node': {} } }
      : { rows: url.includes('kind=nodes') ? [{ name: 'host-kube-node', status: 'Ready' }] : [] } };
  });
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<EksDiagnosis cluster="shared" />);
  await screen.findByText('host-metric-node');
  await screen.findByText('host-kube-node');
  rerender(<EksDiagnosis cluster={ARN} />);
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.includes(encodeURIComponent(ARN)))).toHaveLength(4));
  expect(screen.queryByText('host-metric-node')).toBeNull();
  expect(screen.queryByText('host-kube-node')).toBeNull();
});
