// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const vpc = { resource_id: 'vpc-aaaa1111', account_id: 'self', region: 'ap-northeast-2',
  data: { name: 'source-vpc', cidr_block: '10.1.0.0/16' } };
const inventory = { rows: [vpc], run: { status: 'succeeded' } };
const result = {
  source: { vpcId: vpc.resource_id, accountId: '111111111111', region: vpc.region },
  checkedAt: '2026-09-16T00:00:00Z',
  peerings: [{ id: 'pcx-aaaa1111', state: 'active',
    peer: { vpcId: 'vpc-bbbb2222', accountId: '222222222222', region: 'us-east-1', cidr: '10.2.0.0/16' } }],
  transitGateways: [{ id: 'tgw-aaaa1111', attachmentId: 'tgw-attach-aaaa1111', state: 'available',
    routeTableId: 'tgw-rtb-aaaa1111', peers: [{ vpcId: 'vpc-cccc3333', accountId: '111111111111',
      state: 'available', attachmentId: 'tgw-attach-bbbb2222', routeTableId: 'tgw-rtb-bbbb2222' }] }],
  incompleteSources: [],
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
  it('opens the scoped VPC picker on demand and shows peerings and shared TGW attachments', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      return reply(url.startsWith('/api/inventory') ? inventory : result);
    }));
    render(<VpcConnectivitySection />);
    expect(requests).toEqual([]);
    expect(screen.getByRole('link', { name: '리소스 그래프 열기' }).getAttribute('href')).toBe('/topology/infra');
    await open();
    await screen.findByText('pcx-aaaa1111');
    expect(screen.getByText('vpc-bbbb2222')).toBeTruthy();
    expect(screen.getByText('vpc-cccc3333')).toBeTruthy();
    expect(screen.getByText('동일 TGW에 연결된 VPC')).toBeTruthy();
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
    expect(screen.getByText(/계정·리전을 확인할 수 없는 VPC/)).toBeTruthy();
  });
});
