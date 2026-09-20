// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import VpcConnectivitySection from './VpcConnectivitySection';

const state = vi.hoisted(() => ({
  scope: { accounts: ['self'], regions: '__all__', includeGlobal: true },
}));
vi.mock('@/lib/account-context', async (original) => ({
  ...await original<typeof import('@/lib/account-context')>(),
  useActiveScope: () => [state.scope, vi.fn(), true],
}));
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ tt: (s: string) => s }),
}));
// Graph geometry is exercised in the pure builder and real-browser checks.
vi.mock('@/components/topology/VpcConnectionGraph', () => ({ default: () => null }));

const vpc = { resource_id: 'vpc-aaaa1111', account_id: 'self', region: 'ap-northeast-2',
  data: { name: 'source-vpc', cidr_block: '10.1.0.0/16' } };
const inventory = { rows: [vpc], run: { status: 'succeeded' } };
const result = {
  source: { vpcId: vpc.resource_id, accountId: '111111111111', ownerId: '111111111111', region: vpc.region },
  checkedAt: '2026-09-16T00:00:00Z',
  peerings: [{ id: 'pcx-aaaa1111', state: 'active',
    peer: { vpcId: 'vpc-bbbb2222', accountId: '222222222222', region: 'us-east-1', cidr: '10.2.0.0/16' } }],
  transitGateways: [{ id: 'tgw-aaaa1111', attachmentId: 'tgw-attach-aaaa1111', state: 'available',
    routeTableId: 'tgw-rtb-aaaa1111', associationState: 'associated', peers: [{ vpcId: 'vpc-cccc3333', accountId: '111111111111',
      state: 'available', attachmentId: 'tgw-attach-bbbb2222', routeTableId: 'tgw-rtb-bbbb2222', associationState: 'associated' }] }],
  incompleteSources: [], limitations: [] as string[],
};
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'VPC 간 연결 보기' }));
  await screen.findByRole('option', { name: /source-vpc/ });
  fireEvent.click(screen.getByRole('button', { name: '연결 조회' }));
}
beforeEach(() => {
  state.scope = { accounts: ['self'], regions: '__all__', includeGlobal: true };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('VpcConnectivitySection', () => {
  it('opens the topology selector and queries an exact scoped deep link', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      return reply(url.startsWith('/api/inventory') ? inventory : result);
    }));
    render(<VpcConnectivitySection topology initialVpc="self/ap-northeast-2/vpc-aaaa1111" />);
    await screen.findByText('pcx-aaaa1111');
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1], 'https://example.com').searchParams.get('vpcId')).toBe('vpc-aaaa1111');
    expect(screen.queryByRole('button', { name: 'VPC 간 연결 보기' })).toBeNull();
  });

  it('never guesses an account or region for an ambiguous VPC link', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      return reply({ ...inventory, rows: [vpc, { ...vpc, region: 'us-east-1' }] });
    }));
    render(<VpcConnectivitySection topology initialVpc="vpc-aaaa1111" />);
    await screen.findByText('연결을 조회할 VPC를 계정·리전과 함께 선택하세요.');
    expect(requests).toHaveLength(1);
    expect(screen.queryByText('pcx-aaaa1111')).toBeNull();
  });

  it('shows unqueried state when opening the VPC graph without a source', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { requests.push(url); return reply(inventory); }));
    render(<VpcConnectivitySection topology />);
    await screen.findByRole('combobox', { name: '기준 VPC' });
    expect(screen.getByText('VPC를 선택한 뒤 연결 조회를 누르면 연결선이 표시됩니다.')).toBeTruthy();
    expect(requests).toHaveLength(1);
  });

  it.each(['222222222222', null])('explains incomplete shared/unknown ownership (%s) without claiming no connections', async ownerId => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.startsWith('/api/inventory') ? inventory : {
      ...result, source: { ...result.source, ownerId }, peerings: [], transitGateways: [],
      limitations: [ownerId ? 'shared-vpc' : 'owner-unknown'],
    })));
    render(<VpcConnectivitySection />);
    await open();
    await screen.findByText(/VPC 소유 계정:/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/VPC 소유 계정:/)).toBeTruthy();
    expect(screen.getByText(ownerId ? '공유 VPC의 전체 연결은 소유 계정에서 확인하세요.' : '소유 계정이 미확인이므로 연결 목록의 완전성을 판단할 수 없습니다.')).toBeTruthy();
    expect(screen.queryByText('조회 범위에서 VPC 연결이 발견되지 않았습니다.')).toBeNull();
  });

  it('rejects a legacy response that has no ownership disclosure instead of claiming absence', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.startsWith('/api/inventory') ? inventory : {
      ...result, source: { ...result.source, ownerId: undefined }, peerings: [], transitGateways: [],
    })));
    render(<VpcConnectivitySection />);
    await open();
    await screen.findByRole('alert');
    expect(screen.queryByText('조회 범위에서 VPC 연결이 발견되지 않았습니다.')).toBeNull();
  });

  it('opens the scoped VPC picker on demand and shows peerings and shared TGW attachments', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      return reply(url.startsWith('/api/inventory') ? inventory : result);
    }));
    render(<VpcConnectivitySection />);
    expect(requests).toEqual([]);
    expect(screen.getByRole('link', { name: '리소스 그래프 열기' }).getAttribute('href')).toBe('/topology/infra?view=vpc');
    await open();
    await screen.findByText('pcx-aaaa1111');
    expect(screen.getByText('vpc-bbbb2222')).toBeTruthy();
    expect(screen.getByText('vpc-cccc3333')).toBeTruthy();
    expect(screen.getByText('동일 TGW의 VPC 어태치먼트 기록')).toBeTruthy();
    expect(screen.getByText(/실제 통신 가능 여부는/)).toBeTruthy();
    const query = new URL(requests[1], 'https://example.com').searchParams;
    expect(Object.fromEntries(query)).toEqual({ account: 'self', region: 'ap-northeast-2', vpcId: 'vpc-aaaa1111' });
  });

  it('does not turn partial empty reads into proof that no connections exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.startsWith('/api/inventory')
      ? inventory : { ...result, peerings: [], transitGateways: [], incompleteSources: ['peering-requester', 'tgw-peers'] })));
    render(<VpcConnectivitySection />);
    await open();
    await screen.findByRole('alert');
    expect(screen.queryByText('조회 범위에서 VPC 연결이 발견되지 않았습니다.')).toBeNull();
    expect(screen.getByText(/일부 연결 정보를 확인하지 못했습니다/)).toBeTruthy();
  });

  it('clears old data immediately and ignores late responses when scope changes', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/inventory')) return reply(inventory);
      return new Promise<Response>(r => { resolve = r; });
    }));
    const view = render(<VpcConnectivitySection />);
    await open();
    state.scope = { accounts: ['222222222222'], regions: '__all__', includeGlobal: true };
    view.rerender(<VpcConnectivitySection />);
    resolve(reply(result));
    await waitFor(() => expect(screen.queryByText('pcx-aaaa1111')).toBeNull());
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: 'VPC 간 연결 보기' })).toBeTruthy();
  });

  it('rejects mismatched response identity and offers retry after a failed read', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/inventory')) return reply(inventory);
      calls++;
      return reply(calls === 1 ? { ...result, source: { ...result.source, region: 'us-east-1' } } : result);
    }));
    render(<VpcConnectivitySection />);
    await open();
    await screen.findByRole('alert');
    expect(screen.queryByText('pcx-aaaa1111')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '연결 조회' }));
    await screen.findByText('pcx-aaaa1111');
  });

  it('discloses the VPC picker cap and rejects rows without scoped identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ ...inventory,
      rows: [...Array.from({ length: 499 }, (_, i) => ({ ...vpc, resource_id: `vpc-${i.toString(16).padStart(8, '0')}` })),
        { ...vpc, account_id: undefined }],
    })));
    render(<VpcConnectivitySection />);
    fireEvent.click(screen.getByRole('button', { name: 'VPC 간 연결 보기' }));
    await screen.findByText(/목록 상한/);
    expect(screen.getAllByRole('option')).toHaveLength(499);
    expect(screen.getByText(/미확인이거나 지원하지 않는 VPC/)).toBeTruthy();
  });

  it('labels pending/deleted records and transitional route-table associations without drawing a live peering arrow', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.startsWith('/api/inventory') ? inventory : {
      ...result, peerings: [{ ...result.peerings[0], state: 'pending-acceptance' }],
      transitGateways: [{ ...result.transitGateways[0], state: 'deleted', associationState: 'disassociating',
        peers: [{ ...result.transitGateways[0].peers[0], state: 'failed', associationState: null }] }],
    })));
    render(<VpcConnectivitySection />);
    await open();
    const peering = (await screen.findByText('pcx-aaaa1111')).closest('article')!;
    expect(within(peering).getByText('연결 대기·종료 기록 (현재 연결 미확인)')).toBeTruthy();
    expect(peering.querySelector('svg')).toBeNull();
    expect(screen.queryByText('활성 연결 기록')).toBeNull();
    expect(screen.queryByText(/^연결된 TGW 라우트 테이블:/)).toBeNull();
    expect(screen.getByText(/TGW 라우트 테이블 연결 기록:.*disassociating/)).toBeTruthy();
  });

  it('keeps a reduced-info pending peering visible with unknown fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.startsWith('/api/inventory') ? inventory : {
      ...result, peerings: [{ id: 'pcx-aaaa1111', state: 'pending-acceptance',
        peer: { vpcId: null, accountId: null, region: null, cidr: null } }], transitGateways: [],
    })));
    render(<VpcConnectivitySection />);
    await open();
    await screen.findByText('pcx-aaaa1111');
    expect(screen.getByText('미확인 · 미확인')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not call a retained association current when its attachment is deleted', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.startsWith('/api/inventory') ? inventory : {
      ...result, peerings: [], transitGateways: [{ ...result.transitGateways[0], state: 'deleted', peers: [] }],
    })));
    render(<VpcConnectivitySection />);
    await open();
    await screen.findByText('tgw-aaaa1111');
    expect(screen.queryByText(/^연결된 TGW 라우트 테이블:/)).toBeNull();
  });

  it('discloses shared TGW visibility separately from a failed read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.startsWith('/api/inventory') ? inventory : {
      ...result, limitations: ['shared-tgw'],
    })));
    render(<VpcConnectivitySection />);
    await open();
    await screen.findByText('공유 TGW는 조회 계정에서 볼 수 있는 어태치먼트만 표시합니다.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('excludes regions the API cannot accept before offering a VPC selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ ...inventory, rows: [
      vpc, { ...vpc, region: 'cn-north-1' }, { ...vpc, region: 'us-central-9' },
    ] })));
    render(<VpcConnectivitySection />);
    fireEvent.click(screen.getByRole('button', { name: 'VPC 간 연결 보기' }));
    await screen.findByRole('option', { name: /source-vpc/ });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText(/미확인이거나 지원하지 않는 VPC/)).toBeTruthy();
  });
});
