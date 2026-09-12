// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { DxAnalysis, DxConnectionRow, DxVifRow, DxGatewayRow } from '@/lib/dx';
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ lang: 'ko', tt: (s: string) => s, t: (s: string) => s }),
}));
// These unchanged canvas/chart panels need a browser layout; the real checklist and page stay mounted.
vi.mock('@/components/dx/DxTopology', () => ({ default: () => null }));
vi.mock('@/components/charts/DonutBreakdown', () => ({ default: () => null }));
vi.mock('@/components/charts/HBarList', () => ({ default: () => null }));
import DirectConnectPage from './page';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const conn = (o: Partial<DxConnectionRow>): DxConnectionRow => ({
  id: 'dxcon-1', name: 'c1', state: 'available', region: 'ap-northeast-2', location: 'SEL1',
  bandwidth: '1Gbps', bandwidthBps: 1e9, vlan: null, partnerName: null, awsDevice: null,
  jumboFrameCapable: false, macSecCapable: false, encryptionMode: null, portEncryptionStatus: null,
  hasLogicalRedundancy: null, lagId: null, vifCount: 0, stateMetricMin: 1, down: false, ...o,
});
const vif = (o: Partial<DxVifRow>): DxVifRow => ({
  id: 'dxvif-1', name: 'v1', type: 'private', state: 'available', region: 'ap-northeast-2',
  connectionId: 'dxcon-1', vlan: 100, mtu: 1500, jumboFrameCapable: false,
  asn: 65000, amazonSideAsn: 64512, addressFamily: 'ipv4', amazonAddress: null, customerAddress: null,
  attachedTo: null, attachmentType: null, siteLinkEnabled: false,
  bgpPeers: [], bgpPeersUp: 1, bgpPeersTotal: 1,
  bpsIngress: null, bpsEgress: null, peakBpsIngress: null, peakBpsEgress: null,
  ppsIngress: null, ppsEgress: null, peakUtilizationPct: null, bgpStatusMin: 1,
  prefixesAccepted: null, prefixesAdvertised: null, routes: [], routesTruncated: false,
  routesAvailable: true, down: false, ...o,
});
const gw = (o: Partial<DxGatewayRow>): DxGatewayRow => ({
  id: 'dxgw-1', name: 'gw1', state: 'available', amazonSideAsn: 64512, ownerAccount: '1',
  associations: [], vifCount: 0, associationsAvailable: true, unassociated: false, ...o,
});

describe('Direct Connect evidence presentation', () => {
  it('labels unknown checklist results and never shows an all-clear for an unidentified site', async () => {
    const data: DxAnalysis = {
      connections: [conn({ stateMetricMin: null }), conn({ id: 'c2', location: '?', stateMetricMin: null })],
      vifs: [vif({ attachedTo: 'dxgw-1', bgpPeersTotal: 0, bgpPeersUp: 0, bgpStatusMin: null })],
      gateways: [gw({ associationsAvailable: false })],
      locations: [
        { location: 'SEL1', region: 'ap-northeast-2', connections: 1, bandwidthBps: 1e9 },
        { location: '?', region: 'ap-northeast-2', connections: 1, bandwidthBps: 1e9 },
      ],
      degradedRegions: [], metricsDegradedRegions: ['ap-northeast-2'], gatewaysDegraded: false,
      totals: { connections: 2, connectionsDown: 0, vifs: 1, vifsDown: 0, bgpPeersDown: 0,
        gateways: 1, gatewaysUnassociated: 0, gatewaysAssociationsUnknown: 1,
        totalBandwidthBps: 2e9, locations: 2, maxUtilizationPct: null, singleLocation: false },
      rangeSec: 86400,
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    render(createElement(DirectConnectPage));
    const health = await screen.findByText(/배포된 커넥션 정상 \(기간 내 다운 없음\)/);
    expect(health.textContent).toContain('확인 불가');
    expect(screen.getByText(/모든 VIF·BGP 정상/).textContent).toContain('확인 불가');
    expect(screen.getByText(/미연결 DX Gateway 없음/).textContent).toContain('확인 불가');
    expect(screen.queryByText('확인된 배포 커넥션이 2개 이상 로케이션에 분산되어 있습니다')).toBeNull();
  });
});

const pageData = (connections: DxConnectionRow[]): DxAnalysis => ({
  connections, vifs: [], gateways: [], locations: [],
  degradedRegions: [], metricsDegradedRegions: [], gatewaysDegraded: false, rangeSec: 3600,
  // Deliberately legacy server totals: the page must derive known sites consistently.
  totals: { connections: connections.length, connectionsDown: 0, vifs: 0, vifsDown: 0,
    bgpPeersDown: 0, gateways: 0, gatewaysUnassociated: 0, gatewaysAssociationsUnknown: 0,
    totalBandwidthBps: 0, locations: 2, maxUtilizationPct: null, singleLocation: false },
});

describe('known locations across owned and hosted connections', () => {
  it.each(['deleted', 'rejected', 'ordering', 'requested', 'pending', 'deleting', 'unknown', 'other', '', undefined])(
    'does not use a %s connection to certify a second deployed site', async state => {
      const data = pageData([conn({}), conn({ id: 'c2', state, location: 'SEL2' })]);
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
      render(createElement(DirectConnectPage));
      await screen.findByText(/배포된 커넥션 정상/);
      expect(screen.queryByText('확인된 배포 커넥션이 2개 이상 로케이션에 분산되어 있습니다')).toBeNull();
      expect(screen.getByText(/배포된 커넥션이 단일 로케이션에 있습니다/)).toBeTruthy();
      expect(screen.getAllByText(/제외 · 미평가.*1/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/모든 커넥션 정상/)).toBeNull();
    },
  );

  it('labels an unknown-only fleet unassessed, with no healthy or empty-fleet claim', async () => {
    const data = pageData([conn({ state: 'unknown' })]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    render(createElement(DirectConnectPage));
    const health = await screen.findByText(/배포된 커넥션 정상/);
    expect(health.textContent).toContain('확인 불가');
    expect(health.textContent).toContain('0/1');
    expect(screen.getAllByText(/제외 · 미평가.*1/).length).toBeGreaterThan(0);
    expect(screen.getByText('배포 확인된 커넥션 없음')).toBeTruthy();
    expect(screen.queryByText('커넥션 없음')).toBeNull();
    expect(screen.queryByText(/SLA 95%/)).toBeNull();
  });

  it.each([null, 'partner'])('does not certify an unknown site (%s) as site two', async partnerName => {
    const data = pageData([conn({}), conn({ id: 'c2', partnerName, location: '?' })]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    render(createElement(DirectConnectPage));
    await screen.findByText(/배포된 커넥션 정상/);
    expect(screen.queryByText('확인된 배포 커넥션이 2개 이상 로케이션에 분산되어 있습니다')).toBeNull();
    expect(screen.getAllByText(/확인 불가/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/배포된 커넥션이 단일 로케이션에 있습니다/)).toBeNull();
  });

  it.each([null, 'partner'])('keeps two verified sites plus unknown %s visible without hiding coverage', async partnerName => {
    const data = pageData([conn({}), conn({ id: 'c2', location: 'SEL2' }),
      conn({ id: 'c3', partnerName, location: '?' })]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    render(createElement(DirectConnectPage));
    expect(await screen.findByText('확인된 배포 커넥션이 2개 이상 로케이션에 분산되어 있습니다')).toBeTruthy();
    expect(screen.getAllByText(/확인 불가/).length).toBeGreaterThan(0);
    const locations = screen.getByText('확인된 배포 커넥션이 2개 이상 로케이션에 분산되어 있습니다').parentElement!;
    expect(within(locations).queryByText('?', { selector: 'td' })).toBeNull();
  });

  it('labels a health pass as deployed scope and discloses excluded provisioning rows', async () => {
    const data = pageData([conn({}), conn({ id: 'c2', state: 'pending', stateMetricMin: null })]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    render(createElement(DirectConnectPage));
    const health = await screen.findByText(/배포된 커넥션 정상/);
    expect(health.textContent).toContain('1/2');
    expect(health.textContent).not.toContain('확인 불가 ·');
    expect(screen.queryByText(/모든 커넥션 정상/)).toBeNull();
  });
});
