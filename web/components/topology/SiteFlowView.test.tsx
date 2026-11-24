// @vitest-environment jsdom
// SiteFlowView: the real loaders run (loadFlowInput, fetchEksIpMap, fetchTraceOverlay, buildSiteFlow) against a
// fetch stub keyed by URL; only the Cytoscape canvas is mocked (its props are captured).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
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

import SiteFlowView, { BINDING_NOTICE, GAP_NOTICE, HighlightChain, ROUTE_NOTICE } from './SiteFlowView';
import { applyTerms } from '@/lib/i18n-terms';
import { parseSiteRoutes, useClusterEvidence, withHostAlias } from './useSiteFlowData';
import type { Fleet } from '@/lib/eks-fleet';
import type { RouteHop } from '@/lib/trace-routes';

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
const THIRD = '222222222222';
/** Per-account fleet listing URL (`/api/eks?accounts=<id>&regions=__all__`). */
const fleetUrl = (account: string) => `/api/eks?accounts=${account}&regions=__all__`;
const isFleet = (u: string) => /^\/api\/eks\?accounts=(self|\d{12})&regions=__all__$/.test(u);
const NOTE = { accountId: 'self', region: '__all__', message: 'All-region discovery covers configured and registered regions only.' };
const FLEET = { clusters: CLUSTERS, errors: [NOTE] };
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
const ACCOUNTS = { accounts: [{ accountId: HOST_ID, isHost: true, enabled: true }, { accountId: MEMBER, isHost: false, enabled: true },
  { accountId: THIRD, isHost: false, enabled: true }, { accountId: '333333333333', isHost: false, enabled: false }] };

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
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
/** One account's all-region fleet listing (with the reason-less discovery note the server adds). */
/** The host's scan is always wildcard, so its listing carries the all-region note; members' only when `*`. */
const fleetOf = (url: string, all: Listed[], wildcard: string[] = ['self']) => {
  const account = new URL(url, 'http://localhost').searchParams.get('accounts')!;
  return json({ ...listingFor(url, all), errors: wildcard.includes(account) ? [{ ...NOTE, accountId: account }] : [] });
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let calls: string[] = [];
function stubFetch(over: Handler = () => undefined, rows = inventory()) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    const custom = over(url, init);
    if (custom) return custom;
    if (url === '/api/accounts') return json(ACCOUNTS);
    if (url === '/api/eks/registrations') return json({ clusters: [] }); // no registered cluster beyond the listings
    if (isFleet(url)) return fleetOf(url, CLUSTERS);
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
    // Fleet: one all-region listing per enabled registered account (host as `self`), merged; disabled ones skipped.
    expect(calls.filter(isFleet).sort()).toEqual([fleetUrl(MEMBER), fleetUrl(THIRD), fleetUrl('self')]);
    expect(calls).not.toContain('/api/eks?accounts=__all__&regions=__all__&includeGlobal=1');
    // One listing per account with only that account's regions (no accounts × regions product).
    const scoped = calls.filter((u) => u.startsWith('/api/eks?') && !isFleet(u));
    expect(scoped.some((u) => u.includes('regions=__all__'))).toBe(false); // the scoped EKS reads never ask for all regions
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
    expect(calls.some((u) => u.startsWith('/api/eks?') && !isFleet(u))).toBe(false); // EKS scope waits for the host id
    release();
    await settled();
  });

  it('explicit regions: the host is listed on its own (self), so its ARN-listed clusters key as `self` with or without the host id', async () => {
    // fetchEksIpMap keys host rows as `self` only on bare-id rows or a self-only listing; the per-account derivation
    // always lists the host alone, so the us-west-2 host ARN row resolves even when /api/accounts names no host.
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
      if (isFleet(u)) return fleetOf(u, listed);
      if (u.startsWith('/api/eks?')) return json(listingFor(u, listed));
      if (u === `/api/eks/${encodeURIComponent(westArn)}/incluster?kind=pods`) return json(westPods);
      return undefined;
    }, rows);
    serve(ACCOUNTS);
    view('view=site&host=mall.example.com', scope);
    await settled();
    expect(calls).not.toContain(`/api/eks?${scope}`);
    expect(calls).toContain(`/api/eks?accounts=self&regions=${encodeURIComponent(`${REGION},${west}`)}&includeGlobal=1`);
    expect(calls).toContain(`/api/eks?accounts=${MEMBER}&regions=${REGION}&includeGlobal=1`);
    expect(ids()).toContain(wl(westArn, 'web/front'));
    expect(ids()).toContain(wl(MEMBER_ARN, 'biz/orders-api'));
    cleanup(); canvas.props = null;
    serve({ accounts: [] }); // no host row: the host stays `self` through its wildcard fleet listing
    view('view=site&host=mall.example.com', scope);
    await settled();
    expect(ids()).toContain(wl(westArn, 'web/front'));
    // The host-id mirror stays as defense in depth for any listing that reports the numeric host id.
    expect(withHostAlias([`${HOST_ID}|${west}`, `${MEMBER}|${REGION}`], HOST_ID))
      .toEqual([`${HOST_ID}|${west}`, `${MEMBER}|${REGION}`, `self|${west}`].sort());
    expect(withHostAlias([`${HOST_ID}|${west}`], null)).toEqual([`${HOST_ID}|${west}`]);
  });

  it('two accounts with clusters in different regions: the member in its own region, the wildcard host in all of R', async () => {
    const east = 'us-east-1', eastArn = `arn:aws:eks:${east}:${MEMBER}:cluster/orders`;
    const eastCluster = { ...cluster(eastArn, 'orders', MEMBER, eastArn, MEMBER_VPC), region: east };
    const listed = [CLUSTERS[0], eastCluster];
    const rows = inventory();
    rows.target_group = [rows.target_group[0], inv(MEMBER, 'api-tg', { ...tg(MEMBER, 'api-tg', API_NLB_ARN, MEMBER_VPC, ['10.1.1.20']).data, region: east })];
    rows.nlb = [rows.nlb[0], inv(MEMBER, 'api-nlb', { arn: API_NLB_ARN, dns_name: API_NLB_DNS, scheme: 'internal', region: east, vpc_id: MEMBER_VPC })];
    stubFetch((u) => {
      if (isFleet(u)) return fleetOf(u, listed);
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
    expect(calls.filter((u) => u.startsWith('/api/eks?') && !isFleet(u)).sort())
      .toEqual([`/api/eks?accounts=${MEMBER}&regions=${east}&includeGlobal=1`,
        `/api/eks?accounts=self&regions=${encodeURIComponent(`${REGION},${east}`)}&includeGlobal=1`]);
    expect(ids()).toEqual(expect.arrayContaining([wl(HOST_ARN, 'web/front'), wl(eastArn, 'biz/orders-api')]));
    expect(canvas.props!.flow.gaps).not.toContain('pods_unresolved');
  });

  it('explicit page regions over two accounts: one listing per account in (its fleet regions ∩ R), never accounts × R', async () => {
    // The member has clusters only in us-east-1 and its scan scope lacks ap-northeast-2: an accounts × regions
    // listing (or any member listing that asks for ap-northeast-2) 403s, so it must never be requested.
    const east = 'us-east-1', eastArn = `arn:aws:eks:${east}:${MEMBER}:cluster/orders`;
    const eastCluster = { ...cluster(eastArn, 'orders', MEMBER, eastArn, MEMBER_VPC), region: east };
    const listed = [CLUSTERS[0], eastCluster];
    const rows = inventory();
    rows.target_group = [rows.target_group[0], inv(MEMBER, 'api-tg', { ...tg(MEMBER, 'api-tg', API_NLB_ARN, MEMBER_VPC, ['10.1.1.20']).data, region: east })];
    rows.nlb = [rows.nlb[0], inv(MEMBER, 'api-nlb', { arn: API_NLB_ARN, dns_name: API_NLB_DNS, scheme: 'internal', region: east, vpc_id: MEMBER_VPC })];
    const scope = `accounts=${encodeURIComponent(`${MEMBER},self`)}&regions=${encodeURIComponent(`${REGION},${east}`)}&includeGlobal=1`;
    stubFetch((u) => {
      if (isFleet(u)) return fleetOf(u, listed);
      if (u.startsWith('/api/eks?')) {
        const q = new URL(u, 'http://localhost').searchParams;
        const denied = q.get('accounts')!.includes(',') || (q.get('accounts') === MEMBER && q.get('regions')!.includes(REGION));
        return denied ? json({ status: 'error', message: 'EKS region is not enabled for this account' }, 403) : json(listingFor(u, listed));
      }
      if (u === `/api/eks/${encodeURIComponent(eastArn)}/incluster?kind=pods`) return json({ kind: 'pods', rows: MEMBER_PODS.map(pod('biz', 'orders-api')), generatedAt: NOW });
      if (u === `/api/eks/${encodeURIComponent(eastArn)}/db-refs`) return json(DB_REFS[ENC_MEMBER]);
      return undefined;
    }, rows);
    view('view=site&host=mall.example.com', scope);
    await settled();
    expect(calls).not.toContain(`/api/eks?${scope}`);
    expect(calls.filter((u) => u.startsWith('/api/eks?') && !isFleet(u)).sort())
      .toEqual([`/api/eks?accounts=${MEMBER}&regions=${east}&includeGlobal=1`,
        `/api/eks?accounts=self&regions=${encodeURIComponent(`${REGION},${east}`)}&includeGlobal=1`]);
    expect(ids()).toEqual(expect.arrayContaining([wl(HOST_ARN, 'web/front'), wl(eastArn, 'biz/orders-api')]));
    expect(canvas.props!.flow.gaps).not.toContain('pods_unresolved');
    expect(notices()).not.toContain(BINDING_NOTICE.cluster_unreadable);
  });

  it('explicit page regions with no cluster in R: only wildcard accounts are listed there; with none, the page scope is kept', async () => {
    const west = 'us-west-2', scope = `accounts=${MEMBER}&regions=${west}&includeGlobal=1`;
    stubFetch();
    view('view=site&host=mall.example.com', scope);
    await settled();
    // The host's scan is a wildcard (its fleet listing carries the note), so it is listed in R and can veto there.
    expect(calls.filter((u) => u.startsWith('/api/eks?') && !isFleet(u))).toEqual([`/api/eks?accounts=self&regions=${west}&includeGlobal=1`]);
    cleanup(); canvas.props = null;
    stubFetch((u) => (isFleet(u) ? fleetOf(u, CLUSTERS, []) : undefined)); // no wildcard account: nothing to list
    view('view=site&host=mall.example.com', scope);
    await settled();
    expect(calls.filter((u) => u.startsWith('/api/eks?') && !isFleet(u))).toEqual([`/api/eks?${scope}`]);
  });

  it('one failing per-account listing fails the whole pod map closed', async () => {
    stubFetch((u) => (!isFleet(u) && u.startsWith(`/api/eks?accounts=${MEMBER}&`) ? json({ status: 'error' }, 403) : undefined));
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
      if (isFleet(u)) return fleetOf(u, listed);
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
    // A complete fleet with no connected cluster in scope derives nothing, so the page scope (all regions) is used;
    // its listing carries the all-region discovery note.
    const hostScope = 'accounts=self&regions=__all__&includeGlobal=1';
    const rows = inventory();
    stubFetch((u) => {
      // The host's fleet listing sees `shop` unconnected; the page-scope EKS read (its own URL) carries the note.
      if (u === fleetUrl('self')) return fleetOf(u, [{ ...CLUSTERS[0], access: 'unknown' }]);
      if (isFleet(u)) return fleetOf(u, []);
      if (u === `/api/eks?${hostScope}`) return json({ ...FLEET, clusters: [CLUSTERS[0]] });
      return undefined;
    }, { ...rows, target_group: [rows.target_group[0]], nlb: [rows.nlb[0]] });
    view('view=site&host=mall.example.com', hostScope);
    await settled();
    // The fleet listing (no includeGlobal) and the page-scope EKS read are separate requests.
    expect(calls.filter((u) => u === fleetUrl('self'))).toHaveLength(1);
    expect(calls.filter((u) => u === `/api/eks?${hostScope}`)).toHaveLength(1);
    expect(canvas.props!.flow.gaps).toContain('pods_unresolved');
    expect(notices()).toContain(GAP_NOTICE.pods_unresolved);
    expect(notices()).toContain(BINDING_NOTICE.binding_scope_partial);
    expect(ids()).not.toContain(wl(HOST_ARN, 'web/front'));
  });

  it.each([
    ['truncated', () => json({ clusters: [CLUSTERS[1]], truncated: true })],
    ['failed', () => json({ status: 'error' }, 502)],
    ['errored', () => json({ clusters: [CLUSTERS[1]], errors: [{ accountId: MEMBER, region: REGION, message: 'x', reason: 'denied' }] })],
  ])('one account\'s %s fleet listing makes the merged fleet incomplete: the EKS read fails closed', async (_l, fleet) => {
    stubFetch((u) => (u === fleetUrl(MEMBER) ? fleet() : undefined));
    view();
    await settled();
    expect(calls.filter((u) => u.startsWith('/api/eks?') && !isFleet(u))).toEqual([]);
    expect(ids()).not.toContain(wl(HOST_ARN, 'web/front'));
    expect(ids()).not.toContain(wl(MEMBER_ARN, 'biz/orders-api'));
    expect(canvas.props!.flow.gaps).toContain('pods_unresolved');
    expect(notices()).toContain(BINDING_NOTICE.binding_fleet_incomplete);
  });

  it('a failed /api/accounts makes the fleet incomplete (no per-account guess): pods fail closed', async () => {
    stubFetch((u) => (u === '/api/accounts' ? json({ status: 'error' }, 500) : undefined));
    view();
    await settled();
    expect(calls.filter(isFleet)).toEqual([]);
    expect(ids()).not.toContain(wl(HOST_ARN, 'web/front'));
    expect(notices()).toContain(BINDING_NOTICE.binding_fleet_incomplete);
  });

  it('a malformed /api/accounts body makes the fleet incomplete', async () => {
    stubFetch((u) => (u === '/api/accounts' ? json({ accounts: [{ accountId: 'nope', isHost: true }] }) : undefined));
    view();
    await settled();
    expect(calls.filter(isFleet)).toEqual([]);
    expect(notices()).toContain(BINDING_NOTICE.binding_fleet_incomplete);
  });

  it('bounds the per-account fleet requests to 4 in flight', async () => {
    const many = { accounts: [{ accountId: HOST_ID, isHost: true, enabled: true },
      ...Array.from({ length: 7 }, (_, i) => ({ accountId: `44444444440${i}`, isHost: false, enabled: true }))] };
    let inFlight = 0, peak = 0;
    stubFetch((u) => {
      if (u === '/api/accounts') return json(many);
      if (isFleet(u)) {
        inFlight++; peak = Math.max(peak, inFlight);
        return new Promise<Response>((r) => setTimeout(() => { inFlight--; r(fleetOf(u, CLUSTERS) as Response); }, 5));
      }
      return undefined;
    });
    view();
    await settled();
    expect(calls.filter(isFleet)).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('bounds the per-account scoped EKS listings to 4 in flight', async () => {
    const members = Array.from({ length: 7 }, (_, i) => `55555555550${i}`);
    const many = { accounts: [{ accountId: HOST_ID, isHost: true, enabled: true },
      ...members.map((accountId) => ({ accountId, isHost: false, enabled: true }))] };
    let inFlight = 0, peak = 0;
    stubFetch((u) => {
      if (u === '/api/accounts') return json(many);
      if (isFleet(u)) return fleetOf(u, CLUSTERS, ['self', ...members]); // every account is a wildcard scan: listed in all of R
      if (u.startsWith('/api/eks?')) {
        inFlight++; peak = Math.max(peak, inFlight);
        return new Promise<Response>((r) => setTimeout(() => { inFlight--; r(json(listingFor(u, CLUSTERS))); }, 5));
      }
      return undefined;
    });
    view();
    await settled();
    expect(calls.filter((u) => u.startsWith('/api/eks?') && !isFleet(u))).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('the 30 s load deadline cutting the EKS read is disclosed as its own reason, not as an unreadable cluster', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    /** Never answers; rejects like fetch once the request is aborted. */
    const hang = (init?: RequestInit) => new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    stubFetch((u, init) => (u.startsWith('/api/eks?') && !isFleet(u) ? hang(init) : undefined));
    view();
    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/eks?') && !isFleet(u))).toBe(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    await settled();
    expect(canvas.props!.flow.gaps).toContain('pods_unresolved');
    expect(notices()).toContain(BINDING_NOTICE.binding_deadline);
    expect(notices()).not.toContain(BINDING_NOTICE.cluster_unreadable);
    expect(notices()).not.toContain(BINDING_NOTICE.binding_fleet_incomplete);
  });

  it('the deadline cutting the fleet read is disclosed as the deadline, not as an incomplete fleet', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch((u, init) => (u === fleetUrl(MEMBER) ? new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }) : undefined));
    view();
    await waitFor(() => expect(calls).toContain(fleetUrl(MEMBER)));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    await settled();
    expect(notices()).toContain(BINDING_NOTICE.binding_deadline);
    expect(notices()).not.toContain(BINDING_NOTICE.binding_fleet_incomplete);
  });

  it('a genuinely failed EKS read that settled before the deadline keeps its own reason', async () => {
    stubFetch((u) => (!isFleet(u) && u.startsWith(`/api/eks?accounts=${MEMBER}&`) ? json({ status: 'error' }, 403) : undefined));
    view();
    await settled();
    expect(notices()).toContain(BINDING_NOTICE.cluster_unreadable);
    expect(notices()).not.toContain(BINDING_NOTICE.binding_deadline);
  });

  it('a refresh whose loads all fail clears the previous flow (no stale pod attributions next to the failure)', async () => {
    let fail = false;
    stubFetch((u) => (fail && u.startsWith('/api/inventory/') ? json({ status: 'error' }, 500) : undefined));
    view();
    await settled();
    expect(ids()).toContain(wl(MEMBER_ARN, 'biz/orders-api'));
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(screen.getByText(/로드 실패:/)).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByTestId('site-canvas')).toBeNull();
    expect(screen.queryByRole('region', { name: '강조된 요청 경로' })).toBeNull();
  });

  it('refresh keeps the traced calls and datastores on screen until the new evidence commits, then swaps', async () => {
    let release: (() => void) | null = null;
    let hold = false;
    stubFetch((u) => (hold && u === `/api/eks/${ENC_MEMBER}/db-refs`
      ? new Promise<Response>((r) => { release = () => r(json(DB_REFS[ENC_MEMBER])); }) : undefined));
    view();
    await settled();
    const ds = `ds:rds_cluster:${MEMBER}:${REGION}:orders`;
    const traced = () => canvas.props!.flow.edges.some((e) => e.source === wl(HOST_ARN, 'web/front') && e.target === wl(HOST_ARN, 'web/catalog') && e.evidence === 'traced');
    expect(ids()).toContain(ds);
    expect(traced()).toBe(true);
    const count = (u: string) => calls.filter((c) => c === u).length;
    hold = true;
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    // The reload's evidence read has started (new inventory + fleet landed) but has not committed yet.
    await waitFor(() => expect(count(`/api/eks/${ENC_MEMBER}/db-refs`)).toBe(2), { timeout: 3000 });
    await waitFor(() => expect(count('/api/eks/shop/db-refs')).toBe(2));
    for (const f of canvas.flows.slice(1)) {
      expect(f.nodes.map((n) => n.id)).toContain(ds); // never rebuilt without the datastore
      expect(f.edges.some((e) => e.evidence === 'traced')).toBe(true); // nor without the traced calls
    }
    expect(ids()).toContain(ds);
    expect(traced()).toBe(true);
    act(() => release!());
    await settled();
    expect(ids()).toContain(ds);
    expect(traced()).toBe(true);
  });

  it('a cluster evidence read that never settles is cut at 30 s and disclosed (trace and datastore gaps)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    const never = () => new Promise<Response>(() => {}); // ignores abort, like a stuck connection
    stubFetch((u) => (u === '/api/topology?lens=service' || u === '/api/eks/shop/db-refs' ? never() : undefined));
    view();
    await waitFor(() => expect(calls).toContain('/api/eks/shop/db-refs'), { timeout: 3000 });
    expect(screen.getByText(PENDING)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    await settled();
    expect(canvas.props!.flow.gaps).toEqual(expect.arrayContaining(['trace_unavailable', 'db_refs_partial']));
    expect(notices()).toContain(GAP_NOTICE.trace_unavailable);
    expect(notices()).toContain(`${GAP_NOTICE.db_refs_partial} (shop (${HOST_ID} / ${REGION}))`);
  });

  it('refresh re-runs every load and re-reads cluster evidence (no cached trace/db-refs reused)', async () => {
    let failMember = true;
    stubFetch((u) => (!isFleet(u) && u.startsWith(`/api/eks?accounts=${MEMBER}&`) && failMember ? json({ status: 'error' }, 403) : undefined));
    view();
    await settled();
    expect(notices()).toContain(BINDING_NOTICE.cluster_unreadable);
    const count = (u: string) => calls.filter((c) => c === u).length;
    expect(count('/api/accounts')).toBe(1);
    expect(count('/api/eks/shop/db-refs')).toBe(0); // no binding → no evidence read yet
    failMember = false;
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    expect(screen.getByTestId('site-canvas')).toBeTruthy(); // the current flow stays on screen while reloading
    expect(screen.getByText(PENDING)).toBeTruthy();
    await waitFor(() => expect(ids()).toContain(wl(MEMBER_ARN, 'biz/orders-api')), { timeout: 3000 });
    await settled();
    expect(count('/api/accounts')).toBe(2);
    expect(count(fleetUrl('self'))).toBe(2);
    expect(count('/api/eks/shop/db-refs')).toBe(1);
    expect(notices()).not.toContain(BINDING_NOTICE.cluster_unreadable);
    // A second refresh re-reads the evidence too: the per-ARN cache does not survive a reload.
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(count('/api/eks/shop/db-refs')).toBe(2), { timeout: 3000 });
    expect(count(`/api/eks/${ENC_MEMBER}/db-refs`)).toBe(2);
    await settled();
    expect(ids()).toContain(wl(MEMBER_ARN, 'biz/orders-api'));
  });

  it('a not-connected cluster of another account in a resolved region vetoes a shared VPC', async () => {
    // Host `shop` (connected, ap-northeast-2, VPC V). Member: connected `orders` in us-east-1 and a NOT-connected
    // `legacy` in ap-northeast-2 inside the same (RAM-shared) VPC V. The member must be listed in ap-northeast-2 too.
    const east = 'us-east-1', eastArn = `arn:aws:eks:${east}:${MEMBER}:cluster/orders`;
    const legacyArn = `arn:aws:eks:${REGION}:${MEMBER}:cluster/legacy`;
    const listed = [CLUSTERS[0], { ...cluster(eastArn, 'orders', MEMBER, eastArn, MEMBER_VPC), region: east },
      cluster(legacyArn, 'legacy', MEMBER, legacyArn, HOST_VPC, 'no-entry')];
    const rows = inventory();
    rows.target_group = [rows.target_group[0], inv(MEMBER, 'api-tg', { ...tg(MEMBER, 'api-tg', API_NLB_ARN, MEMBER_VPC, ['10.1.1.20']).data, region: east })];
    rows.nlb = [rows.nlb[0], inv(MEMBER, 'api-nlb', { arn: API_NLB_ARN, dns_name: API_NLB_DNS, scheme: 'internal', region: east, vpc_id: MEMBER_VPC })];
    stubFetch((u) => {
      if (isFleet(u)) return fleetOf(u, listed);
      if (u.startsWith('/api/eks?')) return json(listingFor(u, listed));
      if (u === `/api/eks/${encodeURIComponent(eastArn)}/incluster?kind=pods`) return json({ kind: 'pods', rows: MEMBER_PODS.map(pod('biz', 'orders-api')), generatedAt: NOW });
      if (u === `/api/eks/${encodeURIComponent(eastArn)}/db-refs`) return json(DB_REFS[ENC_MEMBER]);
      return undefined;
    }, rows);
    view();
    await settled();
    expect(calls.filter((u) => u.startsWith('/api/eks?') && !isFleet(u)).sort()).toEqual([
      `/api/eks?accounts=${MEMBER}&regions=${encodeURIComponent(`${REGION},${east}`)}&includeGlobal=1`,
      `/api/eks?accounts=self&regions=${encodeURIComponent(`${REGION},${east}`)}&includeGlobal=1`]);
    expect(ids()).not.toContain(wl(HOST_ARN, 'web/front')); // V is blocked by `legacy`
    expect(ids()).toContain(wl(eastArn, 'biz/orders-api'));
    expect(canvas.props!.flow.gaps).toContain('pods_unresolved');
    expect(notices()).toContain(`${BINDING_NOTICE.binding_scope_blocked} legacy (${MEMBER} / ${REGION})`);
  });

  it('an UNSELECTED account\'s not-connected cluster in the selected account\'s shared VPC still vetoes it', async () => {
    // Page scope = the member only. THIRD is enabled but not selected; its not-connected `shadow` cluster sits in the
    // member's (RAM-shared) VPC, so the member pods there cannot be attributed: selection limits what is shown, not
    // which clusters can veto.
    const shadowArn = `arn:aws:eks:${REGION}:${THIRD}:cluster/shadow`;
    const listed = [...CLUSTERS, cluster(shadowArn, 'shadow', THIRD, shadowArn, MEMBER_VPC, 'no-entry')];
    stubFetch((u) => {
      if (isFleet(u)) return fleetOf(u, listed);
      if (u.startsWith('/api/eks?')) return json(listingFor(u, listed));
      return undefined;
    }, { ...inventory(), target_group: [inventory().target_group[1]] });
    view('view=site&host=mall.example.com', `accounts=${MEMBER}&regions=__all__&includeGlobal=1`);
    await settled();
    expect(calls).toContain(`/api/eks?accounts=${THIRD}&regions=${REGION}&includeGlobal=1`);
    expect(ids()).not.toContain(wl(MEMBER_ARN, 'biz/orders-api'));
    expect(canvas.props!.flow.gaps).toContain('pods_unresolved');
    expect(notices()).toContain(`${BINDING_NOTICE.binding_scope_blocked} shadow (${THIRD} / ${REGION})`);
  });

  it('an UNSELECTED account\'s CONNECTED cluster in R resolves a shared-VPC target to its pod (qualified binding)', async () => {
    // Page scope = the member only. THIRD is enabled but not selected; its connected `cart` cluster runs the pod behind
    // a member target group in the member's (RAM-shared) VPC. Selection decides R and which targets are shown, not
    // which clusters can own them, so the target resolves to THIRD's workload and its evidence is read.
    const cartArn = `arn:aws:eks:${REGION}:${THIRD}:cluster/cart`, encCart = encodeURIComponent(cartArn);
    const listed = [...CLUSTERS, cluster(cartArn, 'cart', THIRD, cartArn, MEMBER_VPC)];
    const rows = inventory();
    rows.target_group = [rows.target_group[1], tg(MEMBER, 'cart-tg', API_NLB_ARN, MEMBER_VPC, ['10.1.1.30'])];
    stubFetch((u) => {
      if (isFleet(u)) return fleetOf(u, listed);
      if (u.startsWith('/api/eks?')) return json(listingFor(u, listed));
      if (u === `/api/eks/${encCart}/incluster?kind=pods`) return json({ kind: 'pods', rows: [pod('shop', 'cart')(['10.1.1.30', 'cart-6b7c-a'])], generatedAt: NOW });
      if (u === `/api/eks/${encCart}/db-refs`) return json({ refs: [], secretRefs: [], truncated: false, partial: false, inventoryCapped: false, inventoryIncomplete: false });
      return undefined;
    }, rows);
    view('view=site&host=mall.example.com', `accounts=${MEMBER}&regions=__all__&includeGlobal=1`);
    await settled();
    expect(calls).toContain(`/api/eks?accounts=${THIRD}&regions=${REGION}&includeGlobal=1`);
    // A workload node exists only for an observed binding whose label matches the pod map (a qualified binding).
    expect(ids()).toEqual(expect.arrayContaining([wl(cartArn, 'shop/cart'), wl(MEMBER_ARN, 'biz/orders-api')]));
    expect(calls).toContain(`/api/eks/${encCart}/db-refs`);
    expect(canvas.props!.flow.gaps).not.toContain('pods_unresolved');
    expect(notices()).not.toContain(BINDING_NOTICE.binding_scope_blocked);
  });

  it('lists a wildcard-scan member (all-region note) in ALL resolved regions, so an unlisted cluster there can veto', async () => {
    // The member's fleet listing covers only its configured/registered regions (us-east-1) and carries the note;
    // an explicit ap-northeast-2 listing reveals a not-connected cluster in the host's (RAM-shared) VPC.
    const east = 'us-east-1', eastArn = `arn:aws:eks:${east}:${MEMBER}:cluster/orders`;
    const hiddenArn = `arn:aws:eks:${REGION}:${MEMBER}:cluster/hidden`;
    const eastCluster = { ...cluster(eastArn, 'orders', MEMBER, eastArn, MEMBER_VPC), region: east };
    const fleet = [CLUSTERS[0], eastCluster];
    const scoped = [...fleet, cluster(hiddenArn, 'hidden', MEMBER, hiddenArn, HOST_VPC, 'no-entry')];
    stubFetch((u) => {
      if (isFleet(u)) return fleetOf(u, fleet, ['self', MEMBER]);
      if (u.startsWith('/api/eks?')) return json(listingFor(u, scoped));
      return undefined;
    });
    view();
    await settled();
    expect(calls).toContain(`/api/eks?accounts=${MEMBER}&regions=${encodeURIComponent(`${REGION},${east}`)}&includeGlobal=1`);
    expect(ids()).not.toContain(wl(HOST_ARN, 'web/front'));
    expect(notices()).toContain(`${BINDING_NOTICE.binding_scope_blocked} hidden (${MEMBER} / ${REGION})`);
    // Without the note the member is listed only where its fleet clusters are, and the hidden cluster stays unseen.
    cleanup(); canvas.props = null;
    stubFetch((u) => {
      if (isFleet(u)) return fleetOf(u, fleet);
      if (u.startsWith('/api/eks?')) return json(listingFor(u, scoped));
      return undefined;
    });
    view();
    await settled();
    expect(calls).toContain(`/api/eks?accounts=${MEMBER}&regions=${east}&includeGlobal=1`);
    expect(ids()).toContain(wl(HOST_ARN, 'web/front'));
  });

  it('a registered account row without a boolean `enabled` makes the fleet incomplete', async () => {
    stubFetch((u) => (u === '/api/accounts'
      ? json({ accounts: [{ accountId: HOST_ID, isHost: true, enabled: true }, { accountId: MEMBER, isHost: false }] }) : undefined));
    view();
    await settled();
    expect(calls.filter(isFleet)).toEqual([]);
    expect(notices()).toContain(BINDING_NOTICE.binding_fleet_incomplete);
  });

  it('dedupes the host listed both as `self` and by its numeric id (no spurious ambiguous_cluster)', async () => {
    const both = { accounts: [...ACCOUNTS.accounts, { accountId: HOST_ID, isHost: false, enabled: true }] };
    stubFetch((u) => {
      if (u === '/api/accounts') return json(both);
      // The server canonicalizes the host's numeric id to `self`.
      if (u === fleetUrl(HOST_ID)) return fleetOf(fleetUrl('self'), CLUSTERS);
      return undefined;
    });
    view();
    await settled();
    expect(calls).toContain(fleetUrl(HOST_ID));
    expect(calls).toContain(fleetUrl('self'));
    expect(canvas.props!.flow.gaps).not.toContain('ambiguous_cluster');
    expect(canvas.props!.flow.edges.find((e) => e.source === wl(HOST_ARN, 'web/front') && e.target === wl(HOST_ARN, 'web/catalog'))?.evidence)
      .toBe('traced');
  });

  it('lists an account whose only clusters in a resolved region are not connected', async () => {
    const third = '222222222222', idleArn = `arn:aws:eks:${REGION}:${third}:cluster/idle`;
    const listed = [...CLUSTERS, cluster(idleArn, 'idle', third, idleArn, 'vpc-0idle', 'entry-only'),
      { ...cluster(`arn:aws:eks:eu-west-1:${third}:cluster/far`, 'far', third, `arn:aws:eks:eu-west-1:${third}:cluster/far`, 'vpc-0far', 'no-entry'), region: 'eu-west-1' }];
    stubFetch((u) => {
      if (isFleet(u)) return fleetOf(u, listed);
      if (u.startsWith('/api/eks?')) return json(listingFor(u, listed));
      return undefined;
    });
    view();
    await settled();
    // eu-west-1 has no connected cluster, so it is not a resolved region and is not requested.
    expect(calls).toContain(`/api/eks?accounts=${third}&regions=${REGION}&includeGlobal=1`);
    expect(calls.some((u) => u.includes('eu-west-1'))).toBe(false);
    expect(ids()).toEqual(expect.arrayContaining([wl(HOST_ARN, 'web/front'), wl(MEMBER_ARN, 'biz/orders-api')]));
    expect(notices()).toContain(`${BINDING_NOTICE.binding_scope_blocked} idle (${third} / ${REGION})`);
  });

  it('a listed cluster without a VPC withholds every pod (notice covers the unknown network)', async () => {
    const noVpc = CLUSTERS.map((c) => (c.name === 'shop' ? { ...c, vpcId: '' } : c));
    stubFetch((u) => (u.startsWith('/api/eks?') && !isFleet(u) ? json({ clusters: noVpc, errors: [] }) : undefined));
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

  it.each(['cloudfront_vpc_origin', 'apigatewayv2_api'])('a never-synced hop type (%s) → inventory_incomplete', async (type) => {
    stubFetch((u) => (/^\/api\/inventory\/(\w+)\?/.exec(u)?.[1] === type
      ? json({ rows: [], run: null, consistency: 'statement-snapshot' }) : undefined));
    view();
    await settled();
    expect(canvas.props!.flow.gaps).toContain('inventory_incomplete');
    expect(notices()).toContain(`${GAP_NOTICE.inventory_incomplete} (${type}: unknown)`);
  });

  it.each(['apigatewayv2_route', 'vpc_endpoint'])('a never-synced enrichment type (%s) adds no inventory gap', async (type) => {
    stubFetch((u) => (/^\/api\/inventory\/(\w+)\?/.exec(u)?.[1] === type
      ? json({ rows: [], run: null, consistency: 'statement-snapshot' }) : undefined));
    view();
    await settled();
    expect(notices()).not.toContain(`${type}: unknown`);
    expect(notices()).not.toContain(`${GAP_NOTICE.inventory_incomplete} (`); // no inventory issue listed at all
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

  it('trace name uniqueness also counts registered clusters outside every listing (ambiguous_cluster)', async () => {
    // THIRD (non-wildcard) registered an `orders` cluster in us-west-2, outside its configured regions: no listing shows it.
    const twin = `arn:aws:eks:us-west-2:${THIRD}:cluster/orders`;
    stubFetch((u) => (u === '/api/eks/registrations' ? json({ clusters: [
      { id: 'shop', name: 'shop', accountId: HOST_ID, region: REGION },
      { id: MEMBER_ARN, name: 'orders', accountId: MEMBER, region: REGION },
      { id: twin, name: 'orders', accountId: THIRD, region: 'us-west-2' },
    ] }) : undefined));
    view();
    await settled();
    expect(canvas.props!.flow.gaps).toContain('ambiguous_cluster');
    expect(notices()).toContain(GAP_NOTICE.ambiguous_cluster);
    // Pod bindings are unaffected (the listed clusters still decide scope and vetoes).
    expect(ids()).toContain(wl(MEMBER_ARN, 'biz/orders-api'));
  });

  it('a failed registrations read fails the fleet closed', async () => {
    stubFetch((u) => (u === '/api/eks/registrations' ? json({ status: 'error' }, 503) : undefined));
    view();
    await settled();
    expect(notices()).toContain(BINDING_NOTICE.binding_fleet_incomplete);
  });

  it('trace listing guard: an incomplete fleet fails the EKS read closed, so no trace join is attempted', async () => {
    // Explicit page regions also derive from the fleet: no listing, no workloads, no trace snapshot read, no traced edge
    // (the overlay's own `incomplete_listing` refusal stays as defense in depth).
    const scope = `accounts=__all__&regions=${REGION}&includeGlobal=1`;
    stubFetch((u) => (isFleet(u) ? json({ ...listingFor(u, CLUSTERS), truncated: true }) : undefined));
    view('view=site&host=mall.example.com', scope);
    await settled();
    expect(calls.filter((u) => u.startsWith('/api/eks?') && !isFleet(u))).toEqual([]);
    expect(calls).not.toContain('/api/topology?lens=service');
    expect(ids()).not.toContain(wl(HOST_ARN, 'web/front'));
    expect(canvas.props!.flow.edges.some((e) => e.evidence === 'traced')).toBe(false);
    expect(notices()).toContain(BINDING_NOTICE.binding_fleet_incomplete);
  });

  it('trace name uniqueness is checked against the FLEET listing, not the scoped one (ambiguous_cluster)', async () => {
    // A same-named `orders` cluster in another account is outside the EKS scope but in the fleet listing.
    const twin = cluster(`arn:aws:eks:${REGION}:222222222222:cluster/orders`, 'orders', '222222222222', `arn:aws:eks:${REGION}:222222222222:cluster/orders`, 'vpc-0twin', 'no-entry');
    stubFetch((u) => (isFleet(u) ? fleetOf(u, [...CLUSTERS, twin]) : undefined));
    view();
    await settled();
    expect(canvas.props!.flow.gaps).toContain('ambiguous_cluster');
    expect(canvas.props!.flow.edges.some((e) => e.source === wl(MEMBER_ARN, 'biz/orders-api') && e.evidence === 'traced')).toBe(false);
    // The host cluster's name is unique, so its trace calls still join.
    expect(ids()).toContain(wl(HOST_ARN, 'web/catalog'));
  });

  it('cluster evidence: 8 bound clusters are read at most 4 at a time, then commit together', async () => {
    const arns = Array.from({ length: 8 }, (_, i) => `arn:aws:eks:${REGION}:${MEMBER}:cluster/c${i}`);
    const fleet: Fleet = { clusters: [], names: arns, incomplete: false, wildcard: [] };
    let inFlight = 0, peak = 0;
    const held: (() => void)[] = [];
    const started: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/topology?lens=service') return json({ status: 'error' }, 404); // trace disabled: settles at once
      if (/^\/api\/eks\/[^/]+\/db-refs$/.test(url)) {
        started.push(url);
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => held.push(r));
        inFlight--;
        return json({ refs: [], secretRefs: [], truncated: false, partial: false, inventoryCapped: false, inventoryIncomplete: false });
      }
      return json({ status: 'error' }, 404);
    }));
    const { result } = renderHook(() => useClusterEvidence(arns, fleet));
    await waitFor(() => expect(started).toHaveLength(4));
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toHaveLength(4); // the other 4 wait for a free lane
    expect(result.current.pending).toBe(true);
    // Release reads as they arrive until every cluster was read.
    await waitFor(() => {
      while (held.length) held.shift()!();
      expect(started).toHaveLength(8);
    });
    await waitFor(() => { while (held.length) held.shift()!(); expect(result.current.pending).toBe(false); });
    expect(peak).toBe(4);
    expect(result.current.dbRefs.map((d) => d.cluster)).toEqual(arns);
    expect(result.current.failedDbRefs).toEqual([]);
  });

  it('a failed db-refs read is partial for that cluster and names it', async () => {
    stubFetch((u) => (u === '/api/eks/shop/db-refs' ? json({ status: 'error' }, 502) : undefined));
    view();
    await settled();
    expect(canvas.props!.flow.gaps).toContain('db_refs_partial');
    expect(notices()).toContain(`${GAP_NOTICE.db_refs_partial} (shop (${HOST_ID} / ${REGION}))`);
    expect(ids()).toContain(`ds:rds_cluster:${MEMBER}:${REGION}:orders`); // the other cluster's refs still land
  });

  it('unknown host → host_not_found notice naming the searched host', async () => {
    stubFetch();
    view('view=site&host=nope.example.com');
    await waitFor(() => expect(notices()).toContain(`${GAP_NOTICE.host_not_found} nope.example.com`), { timeout: 3000 });
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


  // A synthetic highlighted chain: every node highlighted, edges `a->b` highlighted in the given order.
  const chainFlow = (nodes: [string, SiteNode['kind'], string][], links: [string, string][]): SiteFlow => ({
    host: 'mall.example.com', path: '/x', groups: [], gaps: [],
    nodes: nodes.map(([id, kind, label]) => ({ id, kind, label })),
    edges: links.map(([source, target]) => ({ id: `${source}->${target}`, source, target, evidence: 'observed' as const })),
    highlight: { nodes: nodes.map(([id]) => id), edges: links.map(([s, t]) => `${s}->${t}`), inferred: [] },
  });
  const chainItems = (flow: SiteFlow) => {
    render(<LanguageProvider><HighlightChain flow={flow} /></LanguageProvider>);
    return screen.getAllByRole('listitem').map((li) => li.textContent);
  };

  it('labels inferred hops in the chain list', () => {
    const front = wl(HOST_ARN, 'web/front'), catalog = wl(HOST_ARN, 'web/catalog');
    const f = chainFlow([[front, 'workload', 'front'], [catalog, 'workload', 'catalog']], [[front, catalog]]);
    const items = chainItems({ ...f, highlight: { nodes: [front], edges: [], inferred: [catalog, `${front}->${catalog}`] } });
    expect(items).toEqual(['Workload front', 'Workload catalog(추론)']);
  });

  it('lists sequential workload hops in request order (front before catalog), not sorted by label or id', () => {
    const front = wl(HOST_ARN, 'web/front'), catalog = wl(HOST_ARN, 'web/catalog');
    expect(chainItems(chainFlow([[catalog, 'workload', 'catalog'], [front, 'workload', 'front']], [[front, catalog]])))
      .toEqual(['Workload front', 'Workload catalog']);
  });

  it('keeps an NLB → TG → ALB → TG chain interleaved in request order', () => {
    expect(chainItems(chainFlow([
      ['lb:alb', 'lb', 'web-alb'], ['lb:nlb', 'lb', 'web-nlb'], ['tg:a', 'tg', 'web-tg'], ['tg:b', 'tg', 'app-tg'],
    ], [['lb:nlb', 'tg:a'], ['tg:a', 'lb:alb'], ['lb:alb', 'tg:b']])))
      .toEqual(['LB web-nlb', 'Target Group web-tg', 'LB web-alb', 'Target Group app-tg']);
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
      if (u.startsWith('/api/eks?') && !isFleet(u)) return json({ clusters: [CLUSTERS[1]], errors: [] });
      return undefined;
    }, { ...inventory(), target_group: [inventory().target_group[1]] });
    view('view=site&host=mall.example.com', `accounts=${MEMBER}&regions=__all__&includeGlobal=1`);
    await settled();
    expect(calls).toContain(`/api/eks?accounts=${MEMBER}&regions=${REGION}&includeGlobal=1`);
    expect(ids()).toContain(wl(MEMBER_ARN, 'biz/orders-api'));
  });
});

// ---- trace routes (`/api/topology/site-routes`) ----
const ROUTES_URL = '/api/topology/site-routes';
const CATALOG_DS = `ds:rds_cluster:${HOST_ID}:${REGION}:catalog`;
const ORDERS_DS = `ds:rds_cluster:${MEMBER}:${REGION}:orders`;
const CACHE_DS = `ds:elasticache:${CACHE_HOST}`;
/** front (gateway behind the default behavior) → catalog → catalog's datastore. Typed as the server's hop shape so
 *  a server-side contract change fails the typecheck here. */
const ROUTES: RouteHop[] = [
  { service: 'front', route: '/products/{id}', calls: 9, next: [{ service: 'catalog', route: '/catalog/{id}', calls: 9 }] },
  { service: 'catalog', route: '/catalog/{id}', calls: 9, next: [] },
];
const routesBody = (status: string, routes: unknown[] = ROUTES, reasons: string[] = []) => ({ status, reasons, routes });
/** catalog reads its own database (configured db-ref), so the route chain has a datastore to close on. */
const DB_REFS_CATALOG = { ...(DB_REFS.shop as Record<string, unknown>), refs: [...(DB_REFS.shop as { refs: unknown[] }).refs,
  { workload: { namespace: 'web', name: 'catalog' }, via: 'env', host: 'catalog-db.cluster-abc.ap-northeast-2.rds.amazonaws.com',
    kind: 'rds', resource: { type: 'rds_cluster', id: 'catalog', region: REGION, accountId: HOST_ID } }] };
/** Stub with a routes handler (body or Response) and catalog's db-ref. */
function stubRoutes(routes: (() => Response | Promise<Response>) | unknown, over: Handler = () => undefined, rows = inventory()) {
  stubFetch((u, init) => {
    const custom = over(u, init);
    if (custom) return custom;
    if (u === ROUTES_URL) return typeof routes === 'function' ? (routes as () => Response)() : json(routes);
    if (u === '/api/eks/shop/db-refs') return json(DB_REFS_CATALOG);
    return undefined;
  }, rows);
}
const hl = () => canvas.props!.flow.highlight!;
const PRODUCTS = 'view=site&host=mall.example.com&path=/products/1';
const front = wl(HOST_ARN, 'web/front'), catalog = wl(HOST_ARN, 'web/catalog'), ordersApi = wl(MEMBER_ARN, 'biz/orders-api');

describe('SiteFlowView trace routes', () => {
  it('ok routes: the highlight follows the route chain to the downstream service and its datastore', async () => {
    stubRoutes(routesBody('ok'));
    view(PRODUCTS);
    await settled();
    expect(calls.filter((u) => u === ROUTES_URL)).toHaveLength(1); // default window, no scope parameters
    expect(hl().nodes).toEqual(expect.arrayContaining([front, catalog, CATALOG_DS]));
    expect(hl().edges).toEqual(expect.arrayContaining([`${front}->${catalog}`]));
    expect(hl().nodes).not.toContain(CACHE_DS); // front is not terminal: its own datastore is not on this route
    expect(hl().inferred).toEqual([]);
    expect(canvas.props!.flow.gaps).not.toContain('route_unavailable');
    expect(notices()).toBe('');
    const items = within(screen.getByRole('region', { name: '강조된 요청 경로' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items.slice(-3)).toEqual(['Workload front', 'Service catalog', 'Datastore catalog']);
    expect(items.some((t) => t?.includes('(추론)'))).toBe(false);
  });

  it('partial routes are still followed and the read reasons are disclosed', async () => {
    stubRoutes(routesBody('partial', ROUTES, ['capped', 'multi_source_counts']));
    view(PRODUCTS);
    await settled();
    expect(hl().nodes).toEqual(expect.arrayContaining([catalog, CATALOG_DS]));
    expect(notices()).toContain(`${ROUTE_NOTICE.partial} (capped, multi_source_counts)`);
    expect(notices()).not.toContain(GAP_NOTICE.route_unavailable);
  });

  it.each([
    ['unavailable', () => json(routesBody('unavailable', [], ['query_failed']))],
    ['404 (flag off)', () => json({ error: 'topology_entities_disabled', class: 'service' }, 404)],
    ['503', () => json({ error: 'read_unavailable' }, 503)],
    ['network error', () => Promise.reject(new TypeError('network'))],
    ['malformed: extra top-level key', () => json({ ...routesBody('ok'), ambiguousTraces: 1 })],
    ['malformed: extra hop key', () => json(routesBody('ok', [{ ...ROUTES[0], path: '/products/1' }, ROUTES[1]]))],
    ['malformed: string count', () => json(routesBody('ok', [{ ...ROUTES[0], calls: '9' }, ROUTES[1]]))],
    ['malformed: unknown status', () => json(routesBody('degraded'))],
  ])('%s → route_unavailable notice and no route-based highlight', async (_, respond) => {
    stubRoutes(respond);
    view(PRODUCTS);
    await settled();
    expect(hl().nodes).toContain(front); // the infra walk still reaches the gateway
    expect(hl().nodes).not.toContain(catalog);
    expect(hl().nodes).not.toContain(CATALOG_DS);
    expect(canvas.props!.flow.gaps).toContain('route_unavailable');
    expect(notices()).toContain(GAP_NOTICE.route_unavailable);
    expect(notices()).not.toContain(ROUTE_NOTICE.partial);
    expect(notices()).not.toContain(ROUTE_NOTICE.no_trace_source);
  });

  it('no trace datasource → its own notice in place of the generic route_unavailable one', async () => {
    stubRoutes(routesBody('unavailable', [], ['no_trace_source']));
    view(PRODUCTS);
    await settled();
    expect(canvas.props!.flow.gaps).toContain('route_unavailable');
    expect(notices()).toContain(ROUTE_NOTICE.no_trace_source);
    expect(notices()).not.toContain(GAP_NOTICE.route_unavailable);
    expect(hl().nodes).not.toContain(catalog);
  });

  it('without a path the route-read notices are not shown (routes change nothing drawn)', async () => {
    stubRoutes(routesBody('partial', ROUTES, ['capped']));
    view();
    await settled();
    expect(canvas.props!.flow.path).toBeNull();
    expect(notices()).not.toContain(ROUTE_NOTICE.partial);
    cleanup();
    stubRoutes(routesBody('unavailable', [], ['no_trace_source']));
    view();
    await settled();
    expect(notices()).not.toContain(ROUTE_NOTICE.no_trace_source);
    expect(notices()).not.toContain(GAP_NOTICE.route_unavailable);
  });

  it('member-only scope still reads (and uses) the app-level routes', async () => {
    stubRoutes(routesBody('ok', [{ service: 'orders-api', route: '/api/orders', calls: 3, next: [] }]), (u) => {
      if (u.startsWith('/api/eks?') && !isFleet(u)) return json({ clusters: [CLUSTERS[1]], errors: [] });
      return undefined;
    }, { ...inventory(), target_group: [inventory().target_group[1]] });
    view('view=site&host=mall.example.com&path=/api/orders', `accounts=${MEMBER}&regions=__all__&includeGlobal=1`);
    await settled();
    expect(calls).toContain(ROUTES_URL);
    expect(hl().nodes).toEqual(expect.arrayContaining([ordersApi, ORDERS_DS]));
    expect(canvas.props!.flow.gaps).not.toContain('route_unavailable');
  });

  it('while the first route read is pending: evidence pending, no false route_unavailable notice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stubRoutes(() => gate.then(() => json(routesBody('ok'))));
    view(PRODUCTS);
    await waitFor(() => expect(canvas.props?.flow.highlight?.nodes).toContain(front), { timeout: 3000 });
    await waitFor(() => expect(calls).toContain('/api/eks/shop/db-refs'));
    expect(screen.getByText(PENDING)).toBeTruthy();
    expect(notices()).not.toContain(GAP_NOTICE.route_unavailable);
    act(() => release());
    await settled();
    expect(hl().nodes).toEqual(expect.arrayContaining([catalog, CATALOG_DS]));
  });

  it('a route read that never settles is cut at 30 s → route_unavailable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    stubRoutes(() => new Promise<Response>(() => {})); // ignores abort, like a stuck connection
    view(PRODUCTS);
    await waitFor(() => expect(calls).toContain(ROUTES_URL), { timeout: 3000 });
    await waitFor(() => expect(calls).toContain('/api/eks/shop/db-refs'), { timeout: 3000 });
    expect(screen.getByText(PENDING)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    await settled();
    expect(notices()).toContain(GAP_NOTICE.route_unavailable);
    expect(hl().nodes).not.toContain(catalog);
  });

  it('a path change reuses the loaded routes (no new route read)', async () => {
    stubRoutes(routesBody('ok'));
    const r = view(PRODUCTS);
    await settled();
    nav.search = 'view=site&host=mall.example.com&path=/products/2';
    r.rerender(<LanguageProvider><SiteFlowView inventoryScope={SCOPE} /></LanguageProvider>);
    await waitFor(() => expect(canvas.props!.flow.path).toBe('/products/2'));
    expect(hl().nodes).toEqual(expect.arrayContaining([catalog, CATALOG_DS]));
    expect(calls.filter((u) => u === ROUTES_URL)).toHaveLength(1);
  });

  it('refresh keeps the routes until the replacement lands, then swaps', async () => {
    let hold: ((r: Response) => void) | null = null;
    let reads = 0;
    stubRoutes(() => (++reads === 1 ? json(routesBody('ok'))
      : new Promise<Response>((r) => { hold = r; })));
    view(PRODUCTS);
    await settled();
    expect(hl().nodes).toContain(CATALOG_DS);
    const before = canvas.flows.length;
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(reads).toBe(2), { timeout: 3000 });
    await waitFor(() => expect(calls.filter((u) => u === '/api/eks/shop/db-refs')).toHaveLength(2), { timeout: 3000 });
    await waitFor(() => expect(screen.queryByRole('button', { name: '새로고침' })?.hasAttribute('disabled')).toBe(false), { timeout: 3000 });
    for (const f of canvas.flows.slice(before)) expect(f.highlight?.nodes).toContain(CATALOG_DS); // never rebuilt without routes
    expect(notices()).not.toContain(GAP_NOTICE.route_unavailable);
    // The replacement: front's route now ends at front (terminal) → front's own datastore, no catalog hop.
    act(() => hold!(json(routesBody('ok', [{ service: 'front', route: '/products/{id}', calls: 4, next: [] }]))));
    await waitFor(() => expect(hl().nodes).toContain(CACHE_DS));
    expect(hl().nodes).not.toContain(CATALOG_DS);
    expect(hl().nodes).not.toContain(catalog);
  });

  it('a page path on a static origin links to the API route it most likely calls (inferred, labelled)', async () => {
    const rows = inventory();
    rows.cloudfront = [inv('self', 'E1EXAMPLE', { ...CF_DATA, region: 'global',
      origins: [...CF_DATA.origins, { Id: 's3-static', DomainName: 'shop-static.s3.ap-northeast-2.amazonaws.com' }],
      default_cache_behavior: { TargetOriginId: 's3-static' } })];
    // Five orders-api templates match /api/orders/7; one ranks best, so the link is not ambiguous (best-rank ties only).
    stubRoutes(routesBody('ok', ['/api/orders/{id}', '/api/{a}/{b}', '/api/:x/:y', '/api/*', '/api/**']
      .map((route) => ({ service: 'orders-api', route, calls: 2, next: [] }))), undefined, rows);
    view('view=site&host=mall.example.com&path=/orders/7');
    await settled();
    const f = canvas.props!.flow;
    expect(f.gaps).not.toContain('route_ambiguous');
    expect(f.gaps).not.toContain('route_unavailable');
    expect(hl().nodes).toContain('origin:E1EXAMPLE:shop-static.s3.ap-northeast-2.amazonaws.com'); // the observed page request
    expect(hl().inferred).toEqual(expect.arrayContaining(['cf:E1EXAMPLE/beh:0', ordersApi, ORDERS_DS]));
    expect(hl().nodes).not.toContain(ordersApi);
    const items = within(screen.getByRole('region', { name: '강조된 요청 경로' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(expect.arrayContaining(['Behavior /api/*(추론)', 'Workload orders-api(추론)', 'Datastore orders(추론)']));
    expect(items.find((t) => t?.includes('shop-static'))).not.toContain('(추론)');
  });
});

describe('parseSiteRoutes', () => {
  it('keeps templates and service names only; an optional next route may be absent', () => {
    expect(parseSiteRoutes(routesBody('partial', [{ service: 'a', route: '/x', calls: 1, next: [{ service: 'b', calls: 1 }] }], ['capped'])))
      .toEqual({ status: 'partial', reasons: ['capped'], routes: [{ service: 'a', route: '/x', next: [{ service: 'b' }] }] });
    expect(parseSiteRoutes(routesBody('ok', [])).routes).toEqual([]);
  });
  it('unavailable carries its reasons but no routes', () => {
    expect(parseSiteRoutes(routesBody('unavailable', [], ['no_trace_source'])))
      .toEqual({ status: 'unavailable', reasons: ['no_trace_source'], routes: null });
  });
  it.each([
    ['not an object', []],
    ['missing reasons', { status: 'ok', routes: [] }],
    ['non-string reason', routesBody('ok', [], [1 as unknown as string])],
    ['routes not an array', { status: 'ok', reasons: [], routes: {} }],
    ['empty service', routesBody('ok', [{ service: '', route: '/x', calls: 1, next: [] }])],
    ['negative calls', routesBody('ok', [{ service: 'a', route: '/x', calls: -1, next: [] }])],
    ['fractional calls', routesBody('ok', [{ service: 'a', route: '/x', calls: 1.5, next: [] }])],
    ['missing next', routesBody('ok', [{ service: 'a', route: '/x', calls: 1 }])],
    ['next extra key', routesBody('ok', [{ service: 'a', route: '/x', calls: 1, next: [{ service: 'b', calls: 1, url: '/y' }] }])],
    ['next empty route', routesBody('ok', [{ service: 'a', route: '/x', calls: 1, next: [{ service: 'b', route: '', calls: 1 }] }])],
    ['next missing calls', routesBody('ok', [{ service: 'a', route: '/x', calls: 1, next: [{ service: 'b' }] }])],
  ])('malformed (%s) → failed, no routes', (_, body) => {
    expect(parseSiteRoutes(body)).toEqual({ status: 'failed', reasons: [], routes: null });
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
  it('route_unavailable names both causes (no route data / no matching route), says where it stops, claims no inference', () => {
    // Page→API inference needs the per-route aggregates this gap reports missing, so none is drawn; every emitter
    // (no route rows, unknown request path, no matching route, no traced next hop) stops where the route is unknown.
    expect(GAP_NOTICE.route_unavailable).toContain('경로를 알 수 없는 지점에서 강조가 멈춥니다');
    expect(GAP_NOTICE.route_unavailable).toContain('경로 정보가 없거나');
    expect(GAP_NOTICE.route_unavailable).toContain('맞는 라우트가 없어');
    const en = applyTerms('en', GAP_NOTICE.route_unavailable);
    expect(en).toContain('stops where the route is unknown');
    expect(en).toContain('Route data is unavailable');
    expect(en).toContain('no route matches');
    expect(GAP_NOTICE.route_unavailable).not.toContain('추론');
    for (const lang of ['en', 'zh', 'ja'] as const) expect(applyTerms(lang, GAP_NOTICE.route_unavailable)).not.toMatch(/infer|推断|推定/i);
  });
  it('binding_scope_partial names its only trigger (no connected cluster in scope) and gives no region advice', () => {
    // The per-account derivation lists explicit regions whenever a cluster is in scope, so the all-region note
    // only remains when no connected cluster is in the selected scope; picking regions would not change that.
    expect(BINDING_NOTICE.binding_scope_partial).toContain('연결된 EKS 클러스터가 없');
    expect(BINDING_NOTICE.binding_scope_partial).not.toContain('리전을 지정');
    expect(applyTerms('en', BINDING_NOTICE.binding_scope_partial)).not.toMatch(/(select|choose|pick)\s+(explicit\s+)?regions/i);
  });
  it.each(['en', 'zh', 'ja'] as const)('translates every gap, binding and route notice (%s)', (lang) => {
    for (const ko of [...Object.values(GAP_NOTICE), ...Object.values(BINDING_NOTICE), ...Object.values(ROUTE_NOTICE)]) {
      const out = applyTerms(lang, ko);
      expect(out, ko).not.toBe(ko);
      expect(/[가-힣]/.test(out), ko).toBe(false);
    }
  });
});

