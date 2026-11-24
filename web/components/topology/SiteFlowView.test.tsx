// @vitest-environment jsdom
// SiteFlowView: the real loaders run (loadFlowInput, fetchEksIpMap, fetchTraceOverlay, buildSiteFlow) against a
// fetch stub keyed by URL; only the Cytoscape canvas is mocked (its props are captured).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LanguageProvider } from '@/components/shell/LanguageProvider';
import type { SiteFlow, SiteGap, SiteNode } from '@/lib/site-flow';

interface CanvasProps { flow: SiteFlow; theme: string; themeKey?: string; onSelect?: (n: SiteNode) => void }
const canvas = vi.hoisted(() => ({ props: null as CanvasProps | null, flows: [] as SiteFlow[] }));
vi.mock('@/components/topology/SiteFlowCanvas', () => ({
  default: (props: CanvasProps) => {
    canvas.props = props;
    if (canvas.flows.at(-1) !== props.flow) canvas.flows.push(props.flow);
    return <div data-testid="site-canvas" />;
  },
}));
const nav = vi.hoisted(() => ({ search: '', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}));
vi.mock('@/components/ui/DetailPanel', () => ({
  default: (p: { title?: string; data: Record<string, unknown> | null; actions?: React.ReactNode; onClose: () => void }) => (
    <div role="dialog" aria-label={`detail:${p.title}`}>
      <pre data-testid="detail-data">{JSON.stringify(p.data)}</pre>
      {p.actions}
    </div>
  ),
}));

import SiteFlowView, { BINDING_NOTICE, GAP_NOTICE, HighlightChain } from './SiteFlowView';
import { applyTerms } from '@/lib/i18n-terms';

// ---- synthetic estate: one host CloudFront → two NLBs → host cluster `shop` and member cluster `orders` ----
const REGION = 'ap-northeast-2', HOST_ID = '123456789012', MEMBER = '111111111111';
const HOST_ARN = `arn:aws:eks:${REGION}:${HOST_ID}:cluster/shop`;
const MEMBER_ARN = `arn:aws:eks:${REGION}:${MEMBER}:cluster/orders`;
const ENC_MEMBER = encodeURIComponent(MEMBER_ARN);
const HOST_VPC = 'vpc-0host', MEMBER_VPC = 'vpc-0member';
const WEB_NLB_DNS = 'web-nlb-0123.elb.ap-northeast-2.amazonaws.com';
const API_NLB_DNS = 'api-nlb-0456.elb.ap-northeast-2.amazonaws.com';
const WEB_NLB_ARN = `arn:aws:elasticloadbalancing:${REGION}:${HOST_ID}:loadbalancer/net/web-nlb/1`;
const API_NLB_ARN = `arn:aws:elasticloadbalancing:${REGION}:${MEMBER}:loadbalancer/net/api-nlb/2`;
const RDS_HOST = 'orders.cluster-abc.ap-northeast-2.rds.amazonaws.com';
const CACHE_HOST = 'shop-cache.abc.ng.0001.apne2.cache.amazonaws.com';
const HOST_PODS = [['10.0.1.10', 'front-7d9f-a'], ['10.0.1.11', 'front-7d9f-b']] as const;
const MEMBER_PODS = [['10.1.1.20', 'orders-api-5c6d-a']] as const;
const NOW = '2026-11-20T00:00:00.000Z';
const RUN = { status: 'succeeded', finished_at: NOW, last_success_at: NOW, row_count: 1 };

const inv = (account: string, id: string, data: Record<string, unknown>) =>
  ({ account_id: account, region: data.region ?? REGION, resource_id: id, captured_at: NOW, data });
const tg = (account: string, name: string, lb: string, vpc: string, ips: readonly string[]) =>
  inv(account, `arn:aws:elasticloadbalancing:${REGION}:${account === 'self' ? HOST_ID : account}:targetgroup/${name}/1`, {
    target_group_name: name, target_type: 'ip', region: REGION, vpc_id: vpc, load_balancer_arns: [lb],
    target_health_descriptions: ips.map((ip) => ({ Target: { Id: ip, Port: 8080 }, TargetHealth: { State: 'healthy' } })),
  });
const CF_DATA = {
  domain_name: 'd111.cloudfront.net', aliases: { Quantity: 1, Items: ['mall.example.com'] },
  origins: [{ Id: 'web', DomainName: WEB_NLB_DNS }, { Id: 'api', DomainName: API_NLB_DNS }],
  cache_behaviors: { Quantity: 1, Items: [{ PathPattern: '/api/*', TargetOriginId: 'api' }] },
  default_cache_behavior: { TargetOriginId: 'web' },
};
function inventory(): Record<string, unknown[]> {
  return {
    route53: [inv('self', 'mall.example.com. A', { name: 'mall.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'd111.cloudfront.net.' } }),
      inv('self', 'other.example.com. A', { name: 'other.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: `${WEB_NLB_DNS}.` } })],
    cloudfront: [inv('self', 'E1EXAMPLE', { ...CF_DATA, region: 'global' })],
    nlb: [inv('self', 'web-nlb', { arn: WEB_NLB_ARN, dns_name: WEB_NLB_DNS, scheme: 'internal', region: REGION, vpc_id: HOST_VPC }),
      inv(MEMBER, 'api-nlb', { arn: API_NLB_ARN, dns_name: API_NLB_DNS, scheme: 'internal', region: REGION, vpc_id: MEMBER_VPC })],
    target_group: [tg('self', 'web-tg', WEB_NLB_ARN, HOST_VPC, HOST_PODS.map(([ip]) => ip)),
      tg(MEMBER, 'api-tg', API_NLB_ARN, MEMBER_VPC, MEMBER_PODS.map(([ip]) => ip))],
  };
}
const cluster = (id: string, name: string, accountId: string, arn: string, vpcId: string, access = 'connected') =>
  ({ id, name, arn, accountId, region: REGION, vpcId, access });
const CLUSTERS = [cluster('shop', 'shop', HOST_ID, HOST_ARN, HOST_VPC), cluster(MEMBER_ARN, 'orders', MEMBER, MEMBER_ARN, MEMBER_VPC)];
const FLEET_URL = '/api/eks?accounts=__all__&regions=__all__&includeGlobal=1';
const FLEET = { clusters: CLUSTERS, errors: [{ accountId: 'self', region: '__all__', message: 'All-region discovery covers configured and registered regions only.' }] };
const pod = (namespace: string, workload: string) => ([ip, name]: readonly [string, string]) =>
  ({ name, namespace, podIP: ip, podIPs: [ip], workload, status: 'Running', uid: `uid-${name}`, node: 'n', restarts: 0, age: '1h' });
const PODS: Record<string, unknown[]> = { shop: HOST_PODS.map(pod('web', 'front')), [ENC_MEMBER]: MEMBER_PODS.map(pod('biz', 'orders-api')) };
const ent = (id: string, kind: string, label: string, clusterName: string | null, namespace: string | null) => ({
  id, kind, label, layers: ['trace'], evidenceRefs: [], claim: false, region: REGION, cluster: clusterName, namespace,
  ownerReason: null, vpc: null, sourceId: 'trace:1', spanCount: null, knownStatus: null, errors: null, durationSumMs: null,
});
const rel = (kind: string, source: string, target: string, spanCount?: number) =>
  ({ id: `${kind}:${source}->${target}`, source, target, kind, layer: 'trace', confidence: 'observed', evidenceRefs: [], ...(spanCount ? { spanCount } : {}) });
// Trace workloads carry the Deployment name (k8s.deployment.name), the same name podWorkload derives for pods
// (ReplicaSet hash stripped) and for db-refs: `front`, not `front-7d9f`.
const TRACE = {
  status: 'partial', snapshotId: '11111111-2222-4333-8444-555555555555', nextCursor: null, omitted: { entities: 0, relations: 0 },
  gaps: ['nfm:not_collected', 'kubernetes:live_ownership_unavailable'],
  sources: [{ sourceId: 'trace', generation: 'g1', status: 'ok', stale: false, retained: false, capped: false }],
  entities: [
    ent('s-front', 'service', 'front', 'shop', 'web'), ent('w-front', 'workload', 'web/front', 'shop', 'web'),
    ent('s-catalog', 'service', 'catalog', 'shop', 'web'), ent('w-catalog', 'workload', 'web/catalog', 'shop', 'web'),
    ent('s-orders', 'service', 'orders-api', 'orders', 'biz'), ent('w-orders', 'workload', 'biz/orders-api', 'orders', 'biz'),
    ent('d-orders', 'db', `postgresql:${RDS_HOST}/orders`, null, null),
  ],
  relations: [rel('runs_on', 's-front', 'w-front'), rel('runs_on', 's-catalog', 'w-catalog'), rel('runs_on', 's-orders', 'w-orders'),
    rel('calls', 's-front', 's-catalog', 12), rel('queries', 's-orders', 'd-orders', 4)],
};
const DB_REFS: Record<string, unknown> = {
  shop: { refs: [{ workload: { namespace: 'web', name: 'front' }, via: 'env', host: CACHE_HOST, kind: 'elasticache', resource: null }],
    secretRefs: [], truncated: false, partial: false, inventoryCapped: false, inventoryIncomplete: false },
  [ENC_MEMBER]: { refs: [{ workload: { namespace: 'biz', name: 'orders-api' }, via: 'env', host: RDS_HOST, kind: 'rds',
    resource: { type: 'rds_cluster', id: 'orders', region: REGION, accountId: MEMBER } }],
  secretRefs: [], truncated: false, partial: false, inventoryCapped: false, inventoryIncomplete: false },
};
const ACCOUNTS = { accounts: [{ accountId: HOST_ID, isHost: true }, { accountId: MEMBER, isHost: false }] };

type Handler = (url: string) => Response | Promise<Response> | undefined;
type Listed = ReturnType<typeof cluster>;
/** Scoped `/api/eks?` listing honoring `accounts`/`regions` like the server (host = `self` = bare id or HOST_ID). */
function listingFor(url: string, all: Listed[]) {
  const q = new URL(url, 'http://localhost').searchParams;
  const accounts = (q.get('accounts') ?? 'self').split(','), regions = (q.get('regions') ?? REGION).split(',');
  const owner = (c: Listed) => (c.accountId === HOST_ID ? 'self' : c.accountId);
  const clusters = all.filter((c) => (accounts.includes('__all__') || accounts.includes(owner(c)))
    && (regions.includes('__all__') || regions.includes(c.region)));
  return { clusters, errors: [], ...(accounts.length === 1 && regions.length === 1 && regions[0] !== '__all__' ? { region: regions[0] } : {}) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let calls: string[] = [];
function stubFetch(over: Handler = () => undefined, rows = inventory()) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const custom = over(url);
    if (custom) return custom;
    if (url === '/api/accounts') return json(ACCOUNTS);
    if (url === FLEET_URL) return json(FLEET);
    if (url.startsWith('/api/eks?')) return json(listingFor(url, CLUSTERS));
    const m = /^\/api\/eks\/([^/]+)\/(incluster\?kind=(\w+)|db-refs)$/.exec(url);
    if (m && m[3] === 'pods') return json({ kind: 'pods', rows: PODS[m[1]] ?? [], generatedAt: NOW });
    if (m && m[3]) return json({ kind: m[3], rows: [] });
    if (m) return DB_REFS[m[1]] ? json(DB_REFS[m[1]]) : json({ status: 'error' }, 502);
    if (url === '/api/topology?lens=service') return json(TRACE);
    const t = /^\/api\/inventory\/(\w+)\?/.exec(url)?.[1];
    if (t) return json({ rows: rows[t] ?? [], run: RUN, consistency: 'statement-snapshot' });
    return json({ status: 'error' }, 404);
  }));
}
const SCOPE = 'accounts=__all__&regions=__all__&includeGlobal=1';
const view = (search = 'view=site&host=mall.example.com', scope = SCOPE) => {
  nav.search = search;
  return render(<LanguageProvider><SiteFlowView inventoryScope={scope} /></LanguageProvider>);
};
const PENDING = '연결 근거(인벤토리·EKS·트레이스·데이터 저장소)를 불러오는 중…';
const settled = () => waitFor(() => { expect(screen.queryByText(PENDING)).toBeNull(); expect(canvas.props).not.toBeNull(); }, { timeout: 3000 });
const ids = () => canvas.props!.flow.nodes.map((n) => n.id);
const notices = () => screen.queryByRole('status', { name: '사이트 흐름 근거 상태' })?.textContent ?? '';
const wl = (arn: string, ref: string) => `wl:${arn}:${ref}`;

beforeEach(() => {
  canvas.props = null; canvas.flows = [];
  nav.push.mockReset(); nav.replace.mockReset();
  document.documentElement.setAttribute('data-theme', 'teal');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('SiteFlowView', () => {
  it('lists the inventory hosts and pushes ?host= when one is picked', async () => {
    stubFetch();
    view('view=site');
    const list = await screen.findByRole('list', { name: '호스트 목록' }, { timeout: 3000 });
    expect(within(list).getByText('mall.example.com')).toBeTruthy();
    fireEvent.click(within(list).getByText('mall.example.com'));
    expect(nav.push).toHaveBeenCalledWith('/topology?view=site&host=mall.example.com', { scroll: false });
    expect(canvas.props).toBeNull(); // no host → no canvas
  });

  it('host combobox: search, arrow keys and Enter choose a host (keyboard accessible)', async () => {
    stubFetch();
    view('view=site');
    await screen.findByRole('list', { name: '호스트 목록' }, { timeout: 3000 });
    const box = screen.getByRole('combobox', { name: '사이트 호스트' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'mall' } });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('mall.example.com')]);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0].id);
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 }); // IME composition confirm: no navigation
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(nav.push).toHaveBeenCalledWith('/topology?view=site&host=mall.example.com', { scroll: false });
  });

  it('composes host and member clusters: pods, traces and db-refs per bound cluster ARN', async () => {
    stubFetch();
    view();
    await settled();
    const f = canvas.props!.flow;
    expect(f.host).toBe('mall.example.com');
    expect(ids()).toEqual(expect.arrayContaining([
      'r53:mall.example.com. A', 'cf:E1EXAMPLE', wl(HOST_ARN, 'web/front'), wl(MEMBER_ARN, 'biz/orders-api'),
      wl(HOST_ARN, 'web/catalog'), `ds:rds_cluster:${MEMBER}:${REGION}:orders`, `ds:elasticache:${CACHE_HOST}`,
    ]));
    // Traced calls and configured db refs join on the same Deployment names the pod map produced.
    expect(f.edges.find((e) => e.source === wl(HOST_ARN, 'web/front') && e.target === wl(HOST_ARN, 'web/catalog')))
      .toMatchObject({ evidence: 'traced', calls: 12 });
    expect(f.edges.find((e) => e.source === wl(MEMBER_ARN, 'biz/orders-api') && e.target === `ds:rds_cluster:${MEMBER}:${REGION}:orders`)?.evidence)
      .toBe('traced');
    expect(f.edges.find((e) => e.source === wl(HOST_ARN, 'web/front') && e.target === `ds:elasticache:${CACHE_HOST}`)?.evidence).toBe('configured');
    expect(f.gaps).toEqual([]);
    // Fleet listing exactly as K8sMapView; the scoped EKS listing never asks for all regions.
    expect(calls).toContain(FLEET_URL);
    // One listing per account with only that account's regions (no accounts × regions product).
    const scoped = calls.filter((u) => u.startsWith('/api/eks?') && u !== FLEET_URL);
    expect(scoped.sort()).toEqual([`/api/eks?accounts=${MEMBER}&regions=${REGION}&includeGlobal=1`,
      `/api/eks?accounts=self&regions=${REGION}&includeGlobal=1`]);
    // Member pods are read by ARN id, host default-region ones by their listed bare id; db-refs likewise.
    expect(calls).toContain(`/api/eks/${ENC_MEMBER}/incluster?kind=pods`);
    expect(calls).toContain('/api/eks/shop/incluster?kind=pods');
    expect(calls).toContain(`/api/eks/${ENC_MEMBER}/db-refs`);
    expect(calls).toContain('/api/eks/shop/db-refs');
    // Inventory reads keep the page scope (no LB/TG row dropped by the narrowed EKS scope).
    expect(calls.filter((u) => u.startsWith('/api/inventory/')).every((u) => u.includes('regions=__all__'))).toBe(true);
  });

  it('passes the FULL live CloudFront rows (cache behaviors) to the builder', async () => {
    stubFetch();
    view();
    await settled();
    expect(ids()).toContain('cf:E1EXAMPLE/beh:0');
    expect(canvas.props!.flow.nodes.find((n) => n.id === 'cf:E1EXAMPLE/beh:0')?.label).toBe('/api/*');
  });

  it('keeps the canvas flow object stable across theme, combobox typing and opening a detail panel', async () => {
    stubFetch();
    view();
    await settled();
    const first = canvas.props!.flow;
    expect(canvas.props!.themeKey).toBe('teal');
    expect(canvas.props!.theme).toBe('light');
    act(() => {
      document.documentElement.setAttribute('data-theme', 'cobalt');
      window.dispatchEvent(new Event('awsops:themechange'));
    });
    await waitFor(() => expect(canvas.props!.themeKey).toBe('cobalt'));
    fireEvent.change(screen.getByRole('combobox', { name: '사이트 호스트' }), { target: { value: 'oth' } });
    act(() => canvas.props!.onSelect!(first.nodes.find((n) => n.id === 'cf:E1EXAMPLE')!));
    await screen.findByRole('dialog');
    expect(canvas.props!.flow).toBe(first);
  });

  it('builds the canvas flow once evidence lands (no false trace/db gaps while pending)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stubFetch((u) => (u === '/api/topology?lens=service' ? gate.then(() => json(TRACE)) as unknown as Response : undefined));
    view();
    await screen.findByTestId('site-canvas', {}, { timeout: 3000 });
    expect(screen.getByText(PENDING)).toBeTruthy();
    expect(notices()).not.toContain(GAP_NOTICE.trace_unavailable);
    expect(notices()).not.toContain(GAP_NOTICE.db_refs_partial);
    release();
    await settled();
    expect(canvas.props!.flow.gaps).toEqual([]);
    expect(canvas.flows).toHaveLength(2); // stage 1, then once with all evidence
  });

  it('shows the evidence-pending indicator until the host-account lookup settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stubFetch((u) => (u === '/api/accounts' ? gate.then(() => json(ACCOUNTS)) as unknown as Response : undefined));
    view();
    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/inventory/'))).toBe(true));
    expect(screen.getByText(PENDING)).toBeTruthy();
    expect(calls.some((u) => u.startsWith('/api/eks?') && u !== FLEET_URL)).toBe(false); // EKS scope waits for the host id
    release();
    await settled();
  });

  it('mirrors <hostId>|region coverage to the self key host inventory rows use (host id from /api/accounts)', async () => {
    // Explicit page regions over two accounts pass through as ONE listing; there fetchEksIpMap keys only bare-id
    // (host default-region) rows as `self`, so the ARN-listed host cluster in us-west-2 needs the /api/accounts id.
    const west = 'us-west-2', westArn = `arn:aws:eks:${west}:${HOST_ID}:cluster/west`;
    const westCluster = { ...cluster(westArn, 'west', HOST_ID, westArn, HOST_VPC), region: west };
    const listed = [westCluster, CLUSTERS[1]];
    const rows = inventory();
    rows.target_group = [inv('self', 'tg-west', { ...tg('self', 'web-tg', WEB_NLB_ARN, HOST_VPC, ['10.0.1.10']).data, region: west }),
      rows.target_group[1]];
    rows.nlb = [inv('self', 'web-nlb', { arn: WEB_NLB_ARN, dns_name: WEB_NLB_DNS, scheme: 'internal', region: west, vpc_id: HOST_VPC }),
      rows.nlb[1]];
    const westPods = { kind: 'pods', rows: [pod('web', 'front')(HOST_PODS[0])], generatedAt: NOW };
    const scope = `accounts=${encodeURIComponent(`${MEMBER},self`)}&regions=${encodeURIComponent(`${REGION},${west}`)}&includeGlobal=1`;
    const serve = (accounts: unknown) => stubFetch((u) => {
      if (u === '/api/accounts') return json(accounts);
      if (u === FLEET_URL) return json({ clusters: listed });
      if (u.startsWith('/api/eks?')) return json(listingFor(u, listed));
      if (u === `/api/eks/${encodeURIComponent(westArn)}/incluster?kind=pods`) return json(westPods);
      return undefined;
    }, rows);
    serve(ACCOUNTS);
    view('view=site&host=mall.example.com', scope);
    await settled();
    expect(calls).toContain(`/api/eks?${scope}`);
    expect(ids()).toContain(wl(westArn, 'web/front'));
    expect(ids()).toContain(wl(MEMBER_ARN, 'biz/orders-api'));
    // Without a resolvable host id the host ARN row is not recognized as `self`: its targets stay unresolved.
    cleanup(); canvas.props = null;
    serve({ accounts: [] });
    view('view=site&host=mall.example.com', scope);
    await settled();
    expect(ids()).not.toContain(wl(westArn, 'web/front'));
    expect(canvas.props!.flow.gaps).toContain('pods_unresolved');
  });

  it('two accounts with clusters in different regions: each listed in its own region, both resolve', async () => {
    const east = 'us-east-1', eastArn = `arn:aws:eks:${east}:${MEMBER}:cluster/orders`;
    const eastCluster = { ...cluster(eastArn, 'orders', MEMBER, eastArn, MEMBER_VPC), region: east };
    const listed = [CLUSTERS[0], eastCluster];
    const rows = inventory();
    rows.target_group = [rows.target_group[0], inv(MEMBER, 'api-tg', { ...tg(MEMBER, 'api-tg', API_NLB_ARN, MEMBER_VPC, ['10.1.1.20']).data, region: east })];
    rows.nlb = [rows.nlb[0], inv(MEMBER, 'api-nlb', { arn: API_NLB_ARN, dns_name: API_NLB_DNS, scheme: 'internal', region: east, vpc_id: MEMBER_VPC })];
    stubFetch((u) => {
      if (u === FLEET_URL) return json({ clusters: listed });
      // The server would 403 a member region outside its scan scope; only per-account listings are answered.
      if (u.startsWith('/api/eks?')) {
        const q = new URL(u, 'http://localhost').searchParams;
        return q.get('accounts')!.includes(',') ? json({ status: 'error', message: 'EKS region is not enabled' }, 403) : json(listingFor(u, listed));
      }
      if (u === `/api/eks/${encodeURIComponent(eastArn)}/incluster?kind=pods`) return json({ kind: 'pods', rows: MEMBER_PODS.map(pod('biz', 'orders-api')), generatedAt: NOW });
      if (u === `/api/eks/${encodeURIComponent(eastArn)}/db-refs`) return json(DB_REFS[ENC_MEMBER]);
      return undefined;
    }, rows);
    view();
    await settled();
    expect(calls.filter((u) => u.startsWith('/api/eks?') && u !== FLEET_URL).sort())
      .toEqual([`/api/eks?accounts=${MEMBER}&regions=${east}&includeGlobal=1`, `/api/eks?accounts=self&regions=${REGION}&includeGlobal=1`]);
    expect(ids()).toEqual(expect.arrayContaining([wl(HOST_ARN, 'web/front'), wl(eastArn, 'biz/orders-api')]));
    expect(canvas.props!.flow.gaps).not.toContain('pods_unresolved');
  });

  it('one failing per-account listing fails the whole pod map closed', async () => {
    stubFetch((u) => (u.startsWith(`/api/eks?accounts=${MEMBER}&`) ? json({ status: 'error' }, 403) : undefined));
    view();
    await settled();
    expect(ids()).not.toContain(wl(HOST_ARN, 'web/front'));
    expect(ids()).not.toContain(wl(MEMBER_ARN, 'biz/orders-api'));
    expect(canvas.props!.flow.gaps).toContain('pods_unresolved');
    expect(notices()).toContain(BINDING_NOTICE.cluster_unreadable);
  });

  it('a not-connected cluster blocks only its own network: other pods resolve, its target stays unresolved', async () => {
    const legacyArn = `arn:aws:eks:${REGION}:${MEMBER}:cluster/legacy`;
    const legacy = cluster(legacyArn, 'legacy', MEMBER, legacyArn, 'vpc-0legacy', 'no-entry');
    const listed = [...CLUSTERS, legacy];
    const rows = inventory();
    // A second TG behind the member NLB whose IP target lives in the blocked VPC.
    rows.target_group = [...rows.target_group, tg(MEMBER, 'legacy-tg', API_NLB_ARN, 'vpc-0legacy', ['10.9.9.9'])];
    stubFetch((u) => {
      if (u === FLEET_URL) return json({ ...FLEET, clusters: listed });
      if (u.startsWith('/api/eks?')) return json(listingFor(u, listed));
      return undefined;
    }, rows);
    view();
    await settled();
    expect(ids()).toEqual(expect.arrayContaining([wl(HOST_ARN, 'web/front'), wl(MEMBER_ARN, 'biz/orders-api')]));
    expect(canvas.props!.flow.gaps).toContain('pods_unresolved');
    expect(canvas.props!.flow.nodes.some((n) => n.kind === 'target' && n.id.includes('legacy-tg'))).toBe(true);
    expect(notices()).toContain(`${BINDING_NOTICE.binding_scope_blocked} legacy (${MEMBER} / ${REGION})`);
  });

  it('withheld bindings (all-region listing) → pods_unresolved with the reason', async () => {
    // No connected cluster can be derived from a failed fleet listing, so the page scope (all regions) is used.
    const hostScope = 'accounts=self&regions=__all__&includeGlobal=1';
    const rows = inventory();
    stubFetch((u) => {
      if (u === FLEET_URL) return json({ status: 'error' }, 502);
      if (u.startsWith('/api/eks?')) return json({ ...FLEET, clusters: [CLUSTERS[0]] });
      return undefined;
    }, { ...rows, target_group: [rows.target_group[0]], nlb: [rows.nlb[0]] });
    view('view=site&host=mall.example.com', hostScope);
    await settled();
    expect(calls).toContain(`/api/eks?${hostScope}`);
    expect(canvas.props!.flow.gaps).toContain('pods_unresolved');
    expect(notices()).toContain(GAP_NOTICE.pods_unresolved);
    expect(notices()).toContain(BINDING_NOTICE.binding_scope_partial);
    expect(ids()).not.toContain(wl(HOST_ARN, 'web/front'));
  });

  it('a listed cluster without a VPC withholds every pod (notice covers the unknown network)', async () => {
    const noVpc = CLUSTERS.map((c) => (c.name === 'shop' ? { ...c, vpcId: '' } : c));
    stubFetch((u) => (u.startsWith('/api/eks?') && u !== FLEET_URL ? json({ clusters: noVpc, errors: [] }) : undefined));
    view();
    await settled();
    expect(canvas.props!.flow.gaps).toContain('pods_unresolved');
    expect(notices()).toContain(BINDING_NOTICE.cluster_unreadable);
    expect(GAP_NOTICE.pods_unresolved).toContain('VPC');
  });

  it('a capped/failed inventory type the builder relies on → inventory_incomplete with the type', async () => {
    stubFetch((u) => (u.startsWith('/api/inventory/alb_listener_rule?') ? json({ status: 'error' }, 500) : undefined));
    view();
    await settled();
    expect(canvas.props!.flow.gaps).toContain('inventory_incomplete');
    expect(notices()).toContain(`${GAP_NOTICE.inventory_incomplete} (alb_listener_rule: failed)`);
  });

  it('discloses inventory issues on the host index too (no host picked)', async () => {
    stubFetch((u) => (u.startsWith('/api/inventory/alb_listener_rule?') ? json({ status: 'error' }, 500) : undefined));
    view('view=site');
    await screen.findByRole('list', { name: '호스트 목록' }, { timeout: 3000 });
    expect(notices()).toContain(`${GAP_NOTICE.inventory_incomplete} (alb_listener_rule: failed)`);
  });

  it('a missing sync record flags hop types (route53) but not optional enrichment types (s3)', async () => {
    stubFetch((u) => {
      const t = /^\/api\/inventory\/(\w+)\?/.exec(u)?.[1];
      if (t === 'route53' || t === 's3') return json({ rows: t === 'route53' ? inventory().route53 : [], run: null, consistency: 'statement-snapshot' });
      return undefined;
    });
    view();
    await settled();
    expect(canvas.props!.flow.gaps).toContain('inventory_incomplete');
    expect(notices()).toContain('(route53: unknown)');
    expect(notices()).not.toContain('s3: unknown');
  });

  it('keeps the detail panel open when evidence lands and the selected node still exists', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stubFetch((u) => (u === '/api/topology?lens=service' ? gate.then(() => json(TRACE)) as unknown as Response : undefined));
    view();
    await screen.findByTestId('site-canvas', {}, { timeout: 3000 });
    const stage1 = canvas.props!.flow;
    act(() => canvas.props!.onSelect!(stage1.nodes.find((n) => n.id === 'cf:E1EXAMPLE')!));
    await screen.findByRole('dialog', { name: 'detail:E1EXAMPLE' });
    release();
    await settled();
    expect(canvas.props!.flow).not.toBe(stage1);
    expect(screen.getByRole('dialog', { name: 'detail:E1EXAMPLE' })).toBeTruthy();
  });

  it('trace listing guard: an incomplete fleet listing refuses the trace join (incomplete_listing)', async () => {
    stubFetch((u) => (u === FLEET_URL ? json({ ...FLEET, truncated: true }) : undefined));
    view();
    await settled();
    expect(canvas.props!.flow.gaps).toContain('incomplete_listing');
    expect(ids()).not.toContain(wl(HOST_ARN, 'web/catalog'));
    expect(notices()).toContain(GAP_NOTICE.incomplete_listing);
  });

  it('trace name uniqueness is checked against the FLEET listing, not the scoped one (ambiguous_cluster)', async () => {
    // A same-named `orders` cluster in another account is outside the EKS scope but in the fleet listing.
    const twin = cluster(`arn:aws:eks:${REGION}:222222222222:cluster/orders`, 'orders', '222222222222', `arn:aws:eks:${REGION}:222222222222:cluster/orders`, 'vpc-0twin', 'no-entry');
    stubFetch((u) => (u === FLEET_URL ? json({ ...FLEET, clusters: [...CLUSTERS, twin] }) : undefined));
    view();
    await settled();
    expect(canvas.props!.flow.gaps).toContain('ambiguous_cluster');
    expect(canvas.props!.flow.edges.some((e) => e.source === wl(MEMBER_ARN, 'biz/orders-api') && e.evidence === 'traced')).toBe(false);
    // The host cluster's name is unique, so its trace calls still join.
    expect(ids()).toContain(wl(HOST_ARN, 'web/catalog'));
  });

  it('a failed db-refs read is partial for that cluster and names it', async () => {
    stubFetch((u) => (u === '/api/eks/shop/db-refs' ? json({ status: 'error' }, 502) : undefined));
    view();
    await settled();
    expect(canvas.props!.flow.gaps).toContain('db_refs_partial');
    expect(notices()).toContain(`${GAP_NOTICE.db_refs_partial} (shop (${HOST_ID} / ${REGION}))`);
    expect(ids()).toContain(`ds:rds_cluster:${MEMBER}:${REGION}:orders`); // the other cluster's refs still land
  });

  it('unknown host → host_not_found notice', async () => {
    stubFetch();
    view('view=site&host=nope.example.com');
    await waitFor(() => expect(notices()).toContain(GAP_NOTICE.host_not_found), { timeout: 3000 });
    expect(screen.queryByTestId('site-canvas')).toBeNull();
  });

  it('path input: debounced replace while typing, push on Enter (IME-safe), highlight + chain list', async () => {
    stubFetch();
    view('view=site&host=mall.example.com');
    await settled();
    const input = screen.getByRole('textbox', { name: '요청 경로' });
    fireEvent.change(input, { target: { value: '/api/orders' } });
    expect(nav.replace).not.toHaveBeenCalled();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/topology?view=site&host=mall.example.com&path=%2Fapi%2Forders', { scroll: false }));
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', nativeEvent: { isComposing: true }, keyCode: 229 });
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(nav.push).toHaveBeenCalledWith('/topology?view=site&host=mall.example.com&path=%2Fapi%2Forders', { scroll: false });
  });

  it('renders the highlighted chain as a text list under the canvas', async () => {
    stubFetch();
    view('view=site&host=mall.example.com&path=/api/orders');
    await settled();
    const f = canvas.props!.flow;
    expect(f.path).toBe('/api/orders');
    expect(f.highlight?.nodes).toEqual(expect.arrayContaining(['cf:E1EXAMPLE/beh:0', wl(MEMBER_ARN, 'biz/orders-api')]));
    const list = screen.getByRole('region', { name: '강조된 요청 경로' });
    const items = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('mall.example.com');
    expect(items).toEqual(expect.arrayContaining([expect.stringContaining('/api/*'), expect.stringContaining('orders-api')]));
    expect(items.some((t) => t?.includes('front'))).toBe(false);
  });

  it('labels inferred hops in the chain list', async () => {
    stubFetch();
    view('view=site&host=mall.example.com&path=/api/orders');
    await settled();
    const f = canvas.props!.flow;
    // Inferred ids come only from page→API route inference (route aggregation lands later), so the list
    // contract is checked on the exported list with an inferred id added.
    const withInferred = { ...f, highlight: { ...f.highlight!, inferred: [wl(HOST_ARN, 'web/catalog')] } };
    cleanup();
    render(<LanguageProvider><HighlightChain flow={withInferred} /></LanguageProvider>);
    const item = screen.getAllByRole('listitem').find((li) => li.textContent?.includes('catalog'));
    expect(item?.textContent).toContain('(추론)');
    expect(screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('(추론)'))).toHaveLength(1);
  });

  it('leaf click: infra node → DetailPanel with its inventory row; workload → K8s map link for that cluster', async () => {
    stubFetch();
    view();
    await settled();
    const f = canvas.props!.flow;
    act(() => canvas.props!.onSelect!(f.nodes.find((n) => n.id === 'cf:E1EXAMPLE')!));
    const cf = await screen.findByRole('dialog', { name: 'detail:E1EXAMPLE' });
    expect(within(cf).getByTestId('detail-data').textContent).toContain('d111.cloudfront.net');
    act(() => canvas.props!.onSelect!(f.nodes.find((n) => n.id === wl(MEMBER_ARN, 'biz/orders-api'))!));
    const link = await screen.findByRole('link', { name: 'K8s 맵에서 보기 →' });
    expect(link.getAttribute('href')).toBe(`/topology/infra?view=k8s&cluster=${ENC_MEMBER}`);
    act(() => canvas.props!.onSelect!(f.nodes.find((n) => n.id === wl(HOST_ARN, 'web/front'))!));
    await waitFor(() => expect(screen.getByRole('link', { name: 'K8s 맵에서 보기 →' }).getAttribute('href'))
      .toBe('/topology/infra?view=k8s&cluster=shop'));
  });

  it('member-only scope resolves member pods through the scoped listing', async () => {
    stubFetch((u) => {
      if (u.startsWith('/api/eks?') && u !== FLEET_URL) return json({ clusters: [CLUSTERS[1]], errors: [] });
      return undefined;
    }, { ...inventory(), target_group: [inventory().target_group[1]] });
    view('view=site&host=mall.example.com', `accounts=${MEMBER}&regions=__all__&includeGlobal=1`);
    await settled();
    expect(calls).toContain(`/api/eks?accounts=${MEMBER}&regions=${REGION}&includeGlobal=1`);
    expect(ids()).toContain(wl(MEMBER_ARN, 'biz/orders-api'));
  });
});

describe('SiteFlowView notices', () => {
  const GAPS: SiteGap[] = ['inventory_incomplete', 'pods_unresolved', 'trace_unavailable', 'ambiguous_cluster', 'incomplete_listing',
    'partial_snapshot', 'route_unavailable', 'db_refs_partial', 'host_not_found', 'behaviors_unavailable', 'route_ambiguous',
    'trace_unmapped', 'private_zone_only', 'rule_unresolved', 'path_unmatched'];
  it('has one distinct notice per SiteGap', () => {
    expect(Object.keys(GAP_NOTICE).sort()).toEqual([...GAPS].sort());
    expect(new Set(Object.values(GAP_NOTICE)).size).toBe(GAPS.length);
  });
  it.each(['en', 'zh', 'ja'] as const)('translates every gap and binding notice (%s)', (lang) => {
    for (const ko of [...Object.values(GAP_NOTICE), ...Object.values(BINDING_NOTICE)]) {
      const out = applyTerms(lang, ko);
      expect(out, ko).not.toBe(ko);
      expect(/[가-힣]/.test(out), ko).toBe(false);
    }
  });
});

