// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dcSend, cwSend } = vi.hoisted(() => ({ dcSend: vi.fn(), cwSend: vi.fn() }));
vi.mock('@aws-sdk/client-direct-connect', async (original) => ({
  ...await original<typeof import('@aws-sdk/client-direct-connect')>(),
  DirectConnectClient: class { send = dcSend; },
}));
vi.mock('@aws-sdk/client-cloudwatch', async (original) => ({
  ...await original<typeof import('@aws-sdk/client-cloudwatch')>(),
  CloudWatchClient: class { send = cwSend; },
}));
vi.mock('@/lib/db', () => ({
  getPool: () => ({ query: async () => ({ rows: [{ region: 'ap-northeast-2' }] }) }),
}));
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ lang: 'ko', tt: (s: string) => s, t: (s: string) => s }),
}));
// Keep the real API aggregation, KPI tiles and checklist; canvas/chart layout is unrelated.
vi.mock('@/components/dx/DxTopology', () => ({ default: () => null }));
vi.mock('@/components/charts/DonutBreakdown', () => ({ default: () => null }));
vi.mock('@/components/charts/HBarList', () => ({ default: () => null }));

import { dxAnalysis, _resetDxCacheForTests } from '@/lib/dx';
import { assessResiliency, buildDxTopology } from '@/lib/dx-topology';
import DirectConnectPage from './page';

beforeEach(() => { dcSend.mockReset(); cwSend.mockReset(); _resetDxCacheForTests(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function renderApi(states: (string | undefined)[], metrics: (number | null)[], status = 'Complete') {
  dcSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'DescribeConnectionsCommand': return { connections: states.map((state, i) => ({
        connectionId: `dxcon-${i}`, connectionName: `connection-${i}`, connectionState: state,
        region: 'ap-northeast-2', location: 'SEL1', bandwidth: '1Gbps',
      })) };
      case 'DescribeVirtualInterfacesCommand': return { virtualInterfaces: [] };
      case 'DescribeDirectConnectGatewaysCommand': return { directConnectGateways: [] };
      case 'DescribeLagsCommand': return { lags: [] };
      default: throw new Error(`Unexpected DX command: ${cmd.constructor.name}`);
    }
  });
  cwSend.mockImplementation(async (cmd: { constructor: { name: string } }) =>
    cmd.constructor.name === 'ListMetricsCommand' ? { Metrics: [] } : {
      MetricDataResults: metrics.flatMap((value, i) =>
        value == null ? [] : [{ Id: `cs_i${i}`, Values: [value], StatusCode: status }]),
    });
  const data = await dxAnalysis(3600);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
  render(createElement(DirectConnectPage));
  return data;
}

async function downTile() {
  return (await screen.findByText('다운 감지 (배포된 커넥션·VIF)')).closest('.rounded-lg')!;
}

describe('DX API totals and rendered health share the same scope', () => {
  it('does not count deleting/deleted/unknown metadata as deployed failures beside a healthy connection', async () => {
    const data = await renderApi(['available', 'deleting', 'deleted', 'unknown'], [1, null, null, null]);
    expect(data.totals.connectionsDown).toBe(0);
    expect(data.connections.map(c => c.down)).toEqual([false, false, false, false]);
    const assessment = assessResiliency(data);
    expect(assessment.connectionHealthCoverage).toMatchObject({
      assessed: 1, excluded: 3, down: 0, excludedObservedDown: 0,
    });
    expect(assessment.checks[0].ok).toBe(true);
    const tile = await downTile();
    expect(within(tile).getByText('0')).toBeTruthy();
    expect(tile.textContent).toContain('1/4');
    expect(tile.textContent).toContain('제외 · 미평가 3');
    expect(within(tile).getByText('0').className).toContain('text-brand-700');
    expect((await screen.findByText(/배포된 커넥션 정상/)).textContent).toContain('1/4');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([false, true])('preserves excluded metric-down evidence separately (deployed down=%s)', async deployedDown => {
    const data = await renderApi(
      ['available', 'deleting', 'unknown', ...(deployedDown ? ['down'] : [])],
      [1, 0, 0, ...(deployedDown ? [null] : [])],
    );
    expect(data.totals.connectionsDown).toBe(deployedDown ? 1 : 0);
    const assessment = assessResiliency(data);
    expect(assessment.connectionHealthCoverage).toMatchObject({
      down: deployedDown ? 1 : 0, excluded: 2, excludedObservedDown: 2,
    });
    expect(assessment.checks[0].ok).toBe(!deployedDown);
    const observed = assessment.checks.find(c => c.label.startsWith('제외·미평가 커넥션의 기간 내 다운 관측'))!;
    expect(observed).toMatchObject({ ok: false, severity: 'critical', detail: '2' });
    const tile = await downTile();
    expect(within(tile).getByText(deployedDown ? '1' : '0')).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('다운 관측');
    expect(alert.textContent).toContain('2');
    expect(alert.textContent).toContain('현재 배포 장애 판정 아님');
    expect(alert.className).toContain('negative');
    const check = screen.getByText('제외·미평가 커넥션의 기간 내 다운 관측 (현재 배포 장애 판정 아님)');
    expect(check.className).toContain('rose');
  });

  it.each([null, 0, 1])('never certifies an all-excluded unknown fleet (metric=%s)', async metric => {
    const data = await renderApi(['unknown'], [metric]);
    expect(data.totals.connectionsDown).toBe(0);
    expect(assessResiliency(data).checks[0].ok).toBeNull();
    const tile = await downTile();
    expect(within(tile).getByText('—')).toBeTruthy();
    expect(within(tile).getByText('—').className).toContain('text-brand-700');
    const health = await screen.findByText(/배포된 커넥션 정상/);
    expect(health.textContent).toContain('확인 불가');
    expect(health.textContent).toContain('0/1');
    if (metric === 0) expect(screen.getByRole('alert').textContent).toContain('다운 관측');
    else expect(screen.queryByRole('alert')).toBeNull();
  });
});


it.each(['PartialData', 'InternalError', 'Forbidden'])('partial query %s cannot certify an up graph path', async status => {
  const data = await renderApi(['available'], [1], status);
  expect(data.metricsDegradedRegions).toContain('ap-northeast-2');
  expect(data.connections[0].stateMetricMin).toBeNull();
  expect(assessResiliency(data).checks[0].ok).toBeNull();
  expect(buildDxTopology(data).nodes.find(n => n.id === 'dxcon-0')?.state).toBe('none');
  expect((await screen.findByText(/배포된 커넥션 정상/)).textContent).toContain('확인 불가');
});

it.each(['PartialData', 'InternalError', 'Forbidden'])('partial query %s retains a positive down observation', async status => {
  const data = await renderApi(['available'], [0], status);
  expect(data.metricsDegradedRegions).toContain('ap-northeast-2');
  expect(data.connections[0].stateMetricMin).toBe(0);
  expect(data.totals.connectionsDown).toBe(1);
  expect(assessResiliency(data).checks[0].ok).toBe(false);
  expect(buildDxTopology(data).nodes.find(n => n.id === 'dxcon-0')?.state).toBe('down');
  expect(within(await downTile()).getByText('1')).toBeTruthy();
});
