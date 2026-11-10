// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ lang: 'en', tt: (s: string) => s }),
}));
// Exercise the real page labels, filtering and navigation without a layout-dependent canvas.
vi.mock('next/dynamic', () => ({
  default: () => ({ nodes, onNodeClick }: any) => <div>
    {nodes.map((node: any) => <button key={node.id} style={node.style} data-y={node.position.y}
      onClick={() => onNodeClick(null, node)}>{node.data.label}</button>)}
  </div>,
}));
vi.mock('@xyflow/react', () => ({ Background: () => null, Controls: () => null, Position: {}, MarkerType: { ArrowClosed: 'arrowclosed' } }));
import ServiceMapPage from './page';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockReset(); });

it('labels queue attribution as unverified telemetry and never navigates it into AWS inventory', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    nodes: [{ id: 'queue:1', kind: 'queue', label: 'orders', meta: {
      environment: 'prod', sourceId: 'tempo:1', identityProvenance: 'aws_verified',
      claimedAccountId: '111122223333', claimedRegion: 'us-east-1',
      infra_ref: 'inventory:queue', cluster: 'claimed-cluster',
    } }], edges: [], captured_at: null,
  }) })));
  render(<ServiceMapPage />);
  const queue = await screen.findByRole('button', { name: /queue: orders/ });
  expect(queue.textContent).toContain('Telemetry claim');
  expect(queue.textContent).toContain('AWS identity unverified');
  expect(queue.textContent).toContain('claimedAccountId: 111122223333');
  expect(queue.textContent).toContain('claimedRegion: us-east-1');
  fireEvent.click(queue);
  expect(push).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: '인프라 리소스 보기 →' })).toBeNull();
  expect(screen.queryByRole('link', { name: '클러스터 요청 흐름 →' })).toBeNull();
  expect(screen.getByText('identityProvenance')).toBeTruthy();
});

it('shows absent queue claims without substituting legacy reporter metadata', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    nodes: [{ id: 'queue:1', kind: 'queue', label: 'orders', meta: {
      claimedAccountId: null, claimedRegion: null, accountId: '444455556666', region: 'us-west-2',
    } }], edges: [], captured_at: null,
  }) })));
  render(<ServiceMapPage />);
  const queue = await screen.findByRole('button', { name: /queue: orders/ });
  expect(queue.textContent).toContain('claimedAccountId: —');
  expect(queue.textContent).toContain('claimedRegion: —');
  expect(queue.textContent).toContain('AWS identity unverified');
  expect(queue.textContent).not.toContain('444455556666');
});

it('reserves enough layout height for adjacent queue cards and their claim text', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    nodes: ['one', 'two'].map(id => ({ id, kind: 'queue', label: id, meta: {} })),
    edges: [], captured_at: null,
  }) })));
  render(<ServiceMapPage />);
  const first = await screen.findByRole('button', { name: /queue: one/ });
  const second = screen.getByRole('button', { name: /queue: two/ });
  const height = Number.parseFloat(first.style.height);
  expect(height).toBeGreaterThan(100);
  expect(Math.abs(Number(first.dataset.y) - Number(second.dataset.y))).toBeGreaterThanOrEqual(height);
});

it('starts with a readable service path and explicitly restores workload context and other services', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    nodes: [
      { id: 'a', kind: 'service', label: 'checkout', meta: { sourceId: 'tempo:1' } },
      { id: 'b', kind: 'service', label: 'unrelated', meta: { sourceId: 'tempo:2' } },
      { id: 'db', kind: 'db', label: 'orders-db' },
      { id: 'w', kind: 'workload', label: 'shop/checkout' },
    ],
    edges: [{ source: 'a', target: 'db', rel: 'queries' }, { source: 'b', target: 'db', rel: 'queries' },
      { source: 'a', target: 'w', rel: 'runs_on' }], captured_at: null,
  }) })));
  render(<ServiceMapPage />);
  expect(await screen.findByRole('button', { name: /service: checkout/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /service: unrelated/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /workload: shop\/checkout/ })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: '워크로드 표시' }));
  expect(screen.getByRole('button', { name: /workload: shop\/checkout/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '전체 그래프' }));
  expect(screen.getByRole('button', { name: /service: unrelated/ })).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: '서비스 검색' }), { target: { value: 'no-match' } });
  expect(screen.queryByRole('button', { name: /service: checkout/ })).toBeNull();
  expect(screen.getByText('검색 결과가 없습니다.')).toBeTruthy();
});

it('keeps same-name queues distinguishable by broker and source on their cards', async () => {
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({nodes:['one','two'].map(id=>({id,kind:'queue',label:'orders',meta:{environment:'prod',cluster:'shop',broker:`broker-${id}`,sourceId:`source-${id}`}})),edges:[],captured_at:null})})));
 render(<ServiceMapPage />);
 const cards=await screen.findAllByRole('button',{name:/queue: orders/});
 expect(cards[0].textContent).toContain('broker-one');
 expect(cards[0].textContent).toContain('source-one');
 expect(cards[0].textContent).toContain('prod');
 expect(cards[1].textContent).toContain('broker-two');
 expect(cards[1].textContent).toContain('source-two');
});
it('bounds a whole service map and reports display omissions',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({nodes:Array.from({length:400},(_,i)=>({id:String(i),kind:'service',label:`service-${i}`})),edges:[],captured_at:null})})));
 render(<ServiceMapPage />);
 await screen.findByRole('button',{name:/service: service-0/});
 fireEvent.click(screen.getByRole('button',{name:'전체 그래프'}));
 expect(screen.getAllByRole('button',{name:/service: service-/})).toHaveLength(350);
 expect(screen.getByText(/표시 한도에 따라 생략/).textContent).toContain('50');
});
