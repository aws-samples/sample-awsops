import { describe, it, expect } from 'vitest';
import { buildFlowGraph, scopedTargetIp, type FlowInput } from './flow-topology';
import { buildSiteFlow, normalizeHost, siteHosts, type SiteEdge, type SiteFlow, type SiteFlowInput, type SiteGap, type SiteNode } from './site-flow';
import { computeHighlight } from './site-flow-highlight';
import type { FlowEdge, FlowNode } from './flow-topology';
import type { Binding } from './service-topology/types';
import type { TraceOverlay } from './k8s-trace-overlay';
import type { DbRef } from './eks-db-refs';
import type { DbResource } from './db-ref-resolve';

const REGION = 'ap-northeast-2', VPC = 'vpc-prod', ACCT = '123456789012';
const ARN = `arn:aws:eks:${REGION}:${ACCT}:cluster/shop-az-a`;
const NLB_DNS = 'prod-api-nlb-0123456789abcdef.elb.ap-northeast-2.amazonaws.com';
const NLB_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:loadbalancer/net/prod-api-nlb/abc`;
const NLB = `nlb:${NLB_ARN}`;
const AURORA = 'shop-aurora.cluster-abc.ap-northeast-2.rds.amazonaws.com';
const CACHE = 'shop-cache.abc.ng.0001.apne2.cache.amazonaws.com';
const CF = 'cf:E1EXAMPLE';
const R53 = 'r53:shop.example.com. A';
const S3 = 'origin:E1EXAMPLE:shop-static.s3.ap-northeast-2.amazonaws.com';
const GW = `wl:${ARN}:platform/api-gateway`;
const PRODUCT = `wl:${ARN}:business/product-service`;
const DS_AURORA = `ds:rds_cluster:${ACCT}:${REGION}:shop-aurora`;
const DS_CACHE = `ds:elasticache:${CACHE}`;
const IPS = ['10.2.1.10', '10.2.1.11', '10.2.3.12'];

const tgRow = (name: string, ips: string[]) => ({
  resource_id: `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:targetgroup/${name}/1`, target_group_name: name,
  target_type: 'ip', region: REGION, vpc_id: VPC, load_balancer_arns: [NLB_ARN],
  target_health_descriptions: ips.map((ip) => ({ Target: { Id: ip, Port: 8080 }, TargetHealth: { State: 'healthy' } })),
});
const cfRow = (over: Record<string, unknown> = {}) => ({
  resource_id: 'E1EXAMPLE', domain_name: 'd111111abcdef8.cloudfront.net', aliases: { Quantity: 1, Items: ['shop.example.com'] },
  origins: [{ Id: 'api-dynamic', DomainName: 'api-internal.example.com' },
    { Id: 's3-static', DomainName: 'shop-static.s3.ap-northeast-2.amazonaws.com' }],
  cache_behaviors: { Quantity: 2, Items: [{ PathPattern: '/api/*', TargetOriginId: 'api-dynamic' },
    { PathPattern: '/static/*', TargetOriginId: 's3-static' }] },
  default_cache_behavior: { TargetOriginId: 's3-static' }, ...over,
});
const r53 = (name: string, target: string) => ({ resource_id: `${name}. A`, name: `${name}.`, type: 'A', private_zone: false,
  alias_target: { DNSName: `${target}.` } });
const pod = (i: number) => `api-gateway-7d9f-${i}`;

function flowInput(over: Partial<FlowInput> = {}): FlowInput {
  return {
    route53: [r53('shop.example.com', 'd111111abcdef8.cloudfront.net'), r53('api-internal.example.com', `dualstack.${NLB_DNS}`)],
    cloudfront: [cfRow()],
    nlb: [{ resource_id: 'prod-api-nlb', arn: NLB_ARN, dns_name: NLB_DNS, scheme: 'internet-facing', region: REGION }],
    tg: [tgRow('prod-wtg-az-a', IPS.slice(0, 2)), tgRow('prod-wtg-az-c', IPS.slice(2))],
    ipResolved: Object.fromEntries(IPS.map((ip, i) => [scopedTargetIp(REGION, VPC, ip), {
      label: 'platform/api-gateway', resolved: 'eks' as const,
      meta: { cluster: 'shop-az-a', namespace: 'platform', pod: pod(i), workload: 'api-gateway', region: REGION, vpcId: VPC },
    }])),
    ...over,
  };
}
const binding = (ip: string, i: number, authority = ARN, account = ACCT): Binding => ({
  account, region: REGION, vpc: VPC, ip, kind: 'pod', nativeId: `uid-${i}`, label: `platform/${pod(i)}`, authority,
  confidence: 'observed', window: { start: 1, end: 1 },
  evidence: { id: authority, account, region: REGION, vpc: VPC, status: 'ok', complete: true, stale: false, retained: false,
    capturedAt: 1, window: { start: 1, end: 1 } },
});
const overlay = (): TraceOverlay => ({ available: true, omitted: 0, workloadCalls: [
  // reverse order on purpose: the closure must not depend on call order
  { fromWorkload: { namespace: 'business', name: 'product-service' }, to: { datastoreHost: AURORA }, spanCount: 80 },
  { fromWorkload: { namespace: 'other', name: 'batch' }, to: { workload: { namespace: 'other', name: 'worker' } }, spanCount: 5 },
  { fromWorkload: { namespace: 'platform', name: 'api-gateway' }, to: { workload: { namespace: 'business', name: 'product-service' } },
    spanCount: 120, errors: 2 },
] });
const ref = (ns: string, name: string, host: string, kind: DbRef['kind']): DbRef => ({ workload: { namespace: ns, name }, via: 'env', host, kind });
const aurora: DbResource = { type: 'rds_cluster', id: 'shop-aurora', region: REGION, accountId: ACCT };
const ROUTES: NonNullable<SiteFlowInput['routes']> = [
  { service: 'api-gateway', route: '/api/products/{id}', next: [{ service: 'product-service', route: '/products/{id}' }] },
  { service: 'product-service', route: '/products/{id}' },
];

function input(over: Partial<SiteFlowInput> = {}, flowOver: Partial<FlowInput> = {}): SiteFlowInput {
  return {
    host: 'shop.example.com', flow: buildFlowGraph(flowInput(flowOver)), cloudfrontRows: [cfRow()],
    bindings: IPS.map((ip, i) => binding(ip, i)), traces: [{ cluster: ARN, overlay: overlay() }],
    dbRefs: [{ cluster: ARN, partial: false,
      refs: [ref('business', 'product-service', AURORA, 'rds'), ref('platform', 'api-gateway', CACHE, 'elasticache')],
      resolved: { map: new Map([[AURORA.toUpperCase(), aurora]]), capped: false, incomplete: false } }],
    routes: ROUTES, ...over,
  };
}
const ids = (f: SiteFlow) => f.nodes.map((n) => n.id);
const node = (f: SiteFlow, id: string) => f.nodes.find((n) => n.id === id);
const edge = (f: SiteFlow, s: string, t: string) => f.edges.find((e) => e.source === s && e.target === t);

describe('normalizeHost / siteHosts', () => {
  it('folds case, trailing dot, scheme, port and path (Review Focus 1)', () => {
    expect(normalizeHost('Shop.Example.Com.')).toBe('shop.example.com');
    expect(normalizeHost('  https://Shop.Example.Com:443/products/1?x=1 ')).toBe('shop.example.com');
    expect(normalizeHost('')).toBe('');
  });
  it('indexes Route53 names, CF aliases and LB DNS names, deduped, by hops desc then name', () => {
    expect(siteHosts(buildFlowGraph(flowInput()))).toEqual([
      { host: 'shop.example.com', hops: 5 }, { host: 'api-internal.example.com', hops: 4 }, { host: NLB_DNS, hops: 3 },
    ]);
    const extra = { resource_id: 'EZ', domain_name: 'dz.cloudfront.net', aliases: ['a.example.com', 'b.example.com'], origins: [] };
    expect(siteHosts(buildFlowGraph(flowInput({ cloudfront: [cfRow(), extra] }))).slice(-2))
      .toEqual([{ host: 'a.example.com', hops: 1 }, { host: 'b.example.com', hops: 1 }]);
  });
});

describe('buildSiteFlow rules', () => {
  it('rule 1: Route53 entry; spelling-insensitive (Review Focus 1)', () => {
    const a = buildSiteFlow(input()), b = buildSiteFlow(input({ host: 'Shop.Example.Com.' }));
    expect(a.host).toBe('shop.example.com');
    expect(b).toEqual(a);
    expect(ids(a)).toContain(R53);
    expect(node(a, R53)?.kind).toBe('dns');
    expect(ids(a)).not.toContain('r53:api-internal.example.com. A');
  });
  it('rule 1: CloudFront alias and LB DNS entries; unknown host names what was searched (Review Focus 4)', () => {
    const aliasOnly = buildSiteFlow(input({}, { route53: [r53('api-internal.example.com', `dualstack.${NLB_DNS}`)] }));
    expect(ids(aliasOnly)).toContain(CF);
    expect(ids(aliasOnly)).toContain(GW);
    const lb = buildSiteFlow(input({ host: NLB_DNS }));
    expect(ids(lb)).toContain(NLB);
    expect(ids(lb)).not.toContain(CF);
    const none = buildSiteFlow(input({ host: 'Nope.Example.com' }));
    expect(none).toMatchObject({ host: 'nope.example.com', nodes: [], edges: [], groups: [], gaps: ['host_not_found'] });
  });
  it('Review Focus 4: a host with only one known hop renders on its own', () => {
    const lone = { resource_id: 'ELONE', domain_name: 'dlone.cloudfront.net', aliases: ['lone.example.com'], origins: [] };
    const f = buildSiteFlow({ ...input({ host: 'lone.example.com', cloudfrontRows: [lone] }, { cloudfront: [cfRow(), lone] }),
      path: '/x' });
    expect(ids(f)).toEqual(['cf:ELONE']);
    expect(f.groups.map((g) => g.id)).toEqual(['cdn:cf:ELONE', 'host:lone.example.com']);
    expect(f.highlight?.nodes).toEqual(['cf:ELONE']);
  });
  it('rules 1/2: the first non-empty tier wins; union of every entry subgraph within it', () => {
    const stale = { resource_id: 'ESTALE', domain_name: 'dstale.cloudfront.net', aliases: ['shop.example.com'], origins: [] };
    const other = { resource_id: 'EOTHER', domain_name: 'dother.cloudfront.net', aliases: ['other.example.com'], origins: [] };
    const f = buildSiteFlow(input({ cloudfrontRows: [cfRow(), stale, other] }, { cloudfront: [cfRow(), stale, other] }));
    expect(ids(f)).toEqual(expect.arrayContaining([R53, CF]));
    expect(ids(f)).not.toContain('cf:ESTALE'); // holds the alias, but DNS points elsewhere
    expect(ids(f)).not.toContain('cf:EOTHER');
    expect(ids(f)).not.toContain('r53:api-internal.example.com. A');
    const aaaa = { ...r53('shop.example.com', 'd111111abcdef8.cloudfront.net'), resource_id: 'shop.example.com. AAAA', type: 'AAAA' };
    const both = buildSiteFlow(input({}, { route53: [...flowInput().route53!, aaaa] }));
    expect(ids(both)).toEqual(expect.arrayContaining([R53, 'r53:shop.example.com. AAAA', CF]));
    const aliasTier = buildSiteFlow(input({ cloudfrontRows: [cfRow(), stale] },
      { cloudfront: [cfRow(), stale], route53: [r53('api-internal.example.com', `dualstack.${NLB_DNS}`)] }));
    expect(ids(aliasTier)).toEqual(expect.arrayContaining([CF, 'cf:ESTALE'])); // no Route53 tier: every alias holder
  });
  it('rule 1: split-horizon DNS — public-zone records win; private-only records get no highlight (I5)', () => {
    const ALB_DNS = 'web-alb-1.ap-northeast-2.elb.amazonaws.com', INT_DNS = 'internal-int-alb-2.ap-northeast-2.elb.amazonaws.com';
    const lbArn = (n: string) => `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:loadbalancer/app/${n}/1`;
    const alb = { resource_id: 'web-alb', arn: lbArn('web-alb'), dns_name: ALB_DNS, scheme: 'internet-facing', region: REGION };
    const internal = { resource_id: 'int-alb', arn: lbArn('int-alb'), dns_name: INT_DNS, scheme: 'internal', region: REGION };
    const cf = { resource_id: 'D1', domain_name: 'd1.cloudfront.net', aliases: ['site.example.com'], origins: [{ Id: 'o', DomainName: ALB_DNS }],
      default_cache_behavior: { TargetOriginId: 'o' } };
    const pub = { resource_id: 'ZPUB site.example.com. A', name: 'site.example.com.', type: 'A', private_zone: false,
      alias_target: { DNSName: 'd1.cloudfront.net.' } };
    const priv = { resource_id: 'ZPRIV site.example.com. A', name: 'site.example.com.', type: 'A', private_zone: true,
      alias_target: { DNSName: `dualstack.${INT_DNS}.` } };
    const build = (route53: Record<string, unknown>[]) => buildSiteFlow({ host: 'site.example.com', path: '/x',
      flow: buildFlowGraph({ cloudfront: [cf], alb: [alb, internal], route53 }), cloudfrontRows: [cf], bindings: [], traces: [], dbRefs: [] });
    const split = build([pub, priv]);
    expect(ids(split)).toContain('r53:ZPUB site.example.com. A');
    expect(ids(split)).not.toContain('r53:ZPRIV site.example.com. A');
    expect(ids(split)).not.toContain(`alb:${lbArn('int-alb')}`);
    expect(split.highlight?.nodes).toContain(`alb:${lbArn('web-alb')}`);
    expect(split.highlight?.nodes).not.toContain(`alb:${lbArn('int-alb')}`);
    expect(split.gaps).not.toContain('private_zone_only');
    for (const only of [priv, { ...priv, private_zone: undefined }]) { // unknown visibility is not public either
      const p = build([only]);
      expect(ids(p)).toEqual(expect.arrayContaining(['r53:ZPRIV site.example.com. A', `alb:${lbArn('int-alb')}`]));
      expect(ids(p)).not.toContain('cf:D1');
      expect(p.highlight).toBeNull();
      expect(p.gaps).toContain('private_zone_only');
    }
  });
  it('rule 3: behaviors sit between CloudFront and its origins, inheriting edge evidence', () => {
    const f = buildSiteFlow(input());
    expect(node(f, `${CF}/beh:0`)).toMatchObject({ kind: 'behavior', label: '/api/*', group: `cdn:${CF}` });
    expect(node(f, `${CF}/beh:1`)?.label).toBe('/static/*');
    expect(node(f, `${CF}/beh:default`)?.label).toBe('*');
    expect(edge(f, CF, `${CF}/beh:0`)?.evidence).toBe('configured');
    expect(edge(f, `${CF}/beh:0`, NLB)?.evidence).toBe('inferred'); // the CF→NLB alias-chain edge is inferred
    expect(edge(f, `${CF}/beh:default`, S3)?.evidence).toBe('observed');
    expect(edge(f, `${CF}/beh:1`, S3)).toBeDefined();
    expect(edge(f, CF, NLB)).toBeUndefined();
    expect(edge(f, CF, S3)).toBeUndefined();
  });
  it('rule 3: a behavior inherits its own origin\'s confidence from a merged origin edge (I1)', () => {
    const ALB_DNS = 'web-alb-1.ap-northeast-2.elb.amazonaws.com';
    const ALB_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:loadbalancer/app/web-alb/1`;
    const alb = { resource_id: 'web-alb', arn: ALB_ARN, dns_name: ALB_DNS, scheme: 'internet-facing', region: REGION };
    const direct = { Id: 'direct', DomainName: ALB_DNS }, chain = { Id: 'chain', DomainName: 'api.example.com' };
    for (const origins of [[direct, chain], [chain, direct]]) {
      const cf = { resource_id: 'D1', domain_name: 'd1.cloudfront.net', aliases: ['site.example.com'], origins,
        cache_behaviors: [{ PathPattern: '/api/*', TargetOriginId: 'chain' }], default_cache_behavior: { TargetOriginId: 'direct' } };
      const flow = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: [r53('api.example.com', `dualstack.${ALB_DNS}`)] });
      const f = buildSiteFlow({ host: 'site.example.com', flow, cloudfrontRows: [cf], bindings: [], traces: [], dbRefs: [] });
      expect(edge(f, 'cf:D1/beh:0', `alb:${ALB_ARN}`)?.evidence).toBe('inferred');
      expect(edge(f, 'cf:D1/beh:default', `alb:${ALB_ARN}`)?.evidence).toBe('observed');
    }
  });
  it('rule 3: an unreferenced origin merged onto a behavior-used origin edge keeps its direct CF→origin edge', () => {
    const ALB_DNS = 'web-alb-1.ap-northeast-2.elb.amazonaws.com';
    const ALB_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:loadbalancer/app/web-alb/1`;
    const alb = { resource_id: 'web-alb', arn: ALB_ARN, dns_name: ALB_DNS, scheme: 'internet-facing', region: REGION };
    const used = { Id: 'used', DomainName: 'api.example.com' }, spare = { Id: 'spare', DomainName: ALB_DNS };
    for (const origins of [[used, spare], [spare, used]]) {
      const cf = { resource_id: 'D1', domain_name: 'd1.cloudfront.net', aliases: ['site.example.com'], origins,
        default_cache_behavior: { TargetOriginId: 'used' } };
      const flow = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: [r53('api.example.com', `dualstack.${ALB_DNS}`)] });
      const f = buildSiteFlow({ host: 'site.example.com', flow, cloudfrontRows: [cf], bindings: [], traces: [], dbRefs: [] });
      expect(edge(f, 'cf:D1/beh:default', `alb:${ALB_ARN}`)?.evidence).toBe('inferred');
      expect(edge(f, 'cf:D1', `alb:${ALB_ARN}`)?.evidence).toBe('observed'); // `spare` is a direct (observed) origin
    }
  });
  it('rule 3: a behavior without an origin edge renders a dangling origin', () => {
    const row = cfRow({ cache_behaviors: [{ PathPattern: '/old/*', TargetOriginId: 'gone' }] });
    const f = buildSiteFlow(input({ cloudfrontRows: [row] }, { cloudfront: [row] }));
    expect(node(f, `${CF}/oid:gone`)).toMatchObject({ kind: 'origin', label: 'gone' });
    expect(edge(f, `${CF}/beh:0`, `${CF}/oid:gone`)?.evidence).toBe('configured');
    expect(edge(f, CF, NLB)?.evidence).toBe('inferred'); // unreferenced origin keeps its direct edge
  });
  it('rule 3: unparseable behaviors keep CF→origin edges and report behaviors_unavailable', () => {
    const row = cfRow({ cache_behaviors: [{ PathPattern: '/api/*' }] });
    const f = buildSiteFlow({ ...input({ cloudfrontRows: [row] }, { cloudfront: [row] }), path: '/api/products/1' });
    expect(f.nodes.some((n) => n.kind === 'behavior')).toBe(false);
    expect(edge(f, CF, NLB)).toBeDefined();
    expect(f.gaps).toContain('behaviors_unavailable');
    expect(f.highlight?.nodes).toEqual([CF, R53]);
  });
  it('rule 4: bound TG targets become one workload grouped cluster → namespace', () => {
    const f = buildSiteFlow(input());
    expect(f.nodes.some((n) => n.kind === 'target')).toBe(false);
    expect(node(f, GW)).toMatchObject({ kind: 'workload', label: 'api-gateway', group: `ns:${ARN}:platform`, account: ACCT,
      region: REGION, ref: { cluster: ARN, namespace: 'platform', workload: 'api-gateway' } });
    const tgs = f.nodes.filter((n) => n.kind === 'tg').map((n) => n.id);
    expect(tgs).toHaveLength(2);
    for (const tg of tgs) expect(edge(f, tg, GW)?.evidence).toBe('observed');
  });
  it('rule 4: unbound or contradicting pods stay targets with pods_unresolved', () => {
    for (const bindings of [[], [binding(IPS[0], 0), { ...binding(IPS[1], 1), label: 'platform/other-pod' }]]) {
      const f = buildSiteFlow(input({ bindings }));
      expect(ids(f)).not.toContain(GW);
      expect(f.nodes.filter((n) => n.kind === 'target').length).toBeGreaterThan(0);
      expect(f.gaps).toContain('pods_unresolved');
      expect(f.edges.some((e) => e.evidence === 'traced')).toBe(false);
    }
  });
  it('rule 4: a pod binding from unqualified evidence (retained, stale, incomplete, not ok) does not promote a workload', () => {
    const bad: Partial<Binding['evidence']>[] = [{ retained: true }, { stale: true }, { complete: false }, { complete: undefined },
      { status: 'partial' }, { status: 'empty' }];
    for (const over of bad) {
      const bindings = IPS.map((ip, i) => ({ ...binding(ip, i), evidence: { ...binding(ip, i).evidence, ...over } }));
      const f = buildSiteFlow(input({ bindings }));
      expect(ids(f)).not.toContain(GW);
      expect(f.nodes.filter((n) => n.kind === 'target').length).toBe(2); // both TGs keep their targets
      expect(f.gaps).toContain('pods_unresolved');
    }
    expect(ids(buildSiteFlow(input()))).toContain(GW); // qualified evidence still promotes
  });
  it('rule 4: a canary pod resolved into the same target group as the stable workload blocks promotion (either order)', () => {
    const CANARY = 'api-gateway-canary-1';
    const canary = { label: 'platform/api-gateway', resolved: 'eks' as const,
      meta: { cluster: 'shop-az-a', namespace: 'platform', pod: CANARY, workload: 'api-gateway-canary', region: REGION, vpcId: VPC } };
    for (const order of [[IPS[0], IPS[1]], [IPS[1], IPS[0]]]) {
      const f = buildSiteFlow(input({ bindings: [binding(IPS[0], 0), { ...binding(IPS[1], 1), label: `platform/${CANARY}` }, binding(IPS[2], 2)] }, {
        tg: [tgRow('prod-wtg-az-a', order), tgRow('prod-wtg-az-c', IPS.slice(2))],
        ipResolved: { ...flowInput().ipResolved, [scopedTargetIp(REGION, VPC, IPS[1])]: canary } }));
      const azA = f.nodes.filter((n) => n.id.startsWith(`target:${tgRow('prod-wtg-az-a', []).resource_id}:`));
      expect(azA.map((n) => n.kind)).toEqual(['target']); // the mixed group stays a target
      expect(edge(f, `tg:${tgRow('prod-wtg-az-a', []).resource_id}`, GW)).toBeUndefined();
      expect(f.gaps).toContain('pods_unresolved');
    }
  });
  it('rule 4: a pod binding whose cluster ARN names another account or region does not promote a workload', () => {
    for (const authority of [`arn:aws:eks:${REGION}:111111111111:cluster/shop-az-a`, `arn:aws:eks:us-east-1:${ACCT}:cluster/shop-az-a`]) {
      const f = buildSiteFlow(input({ bindings: IPS.map((ip, i) => binding(ip, i, authority)), traces: [], dbRefs: [] }));
      expect(f.nodes.some((n) => n.kind === 'workload')).toBe(false);
      expect(f.gaps).toContain('pods_unresolved');
    }
  });
  it('rule 5: traced calls close over bound workloads; DB refs add configured datastores', () => {
    const f = buildSiteFlow(input());
    expect(node(f, PRODUCT)).toMatchObject({ kind: 'service', group: `ns:${ARN}:business` });
    expect(edge(f, GW, PRODUCT)).toMatchObject({ evidence: 'traced', calls: 120, errors: 2, route: '/api/products/{id}' });
    expect(node(f, DS_AURORA)).toMatchObject({ kind: 'datastore', label: 'shop-aurora', group: 'datastore:rds_cluster' });
    expect(edge(f, PRODUCT, DS_AURORA)).toMatchObject({ evidence: 'traced', calls: 80 }); // traced wins over the env ref
    expect(node(f, DS_CACHE)).toMatchObject({ kind: 'datastore', label: CACHE, group: 'datastore:unresolved' });
    expect(edge(f, GW, DS_CACHE)?.evidence).toBe('configured');
    expect(ids(f).some((id) => id.includes('batch') || id.includes('worker'))).toBe(false); // no orphans
    expect(f.gaps).toEqual([]);
  });
  it('rule 5: an unavailable overlay contributes its gap and no trace edges; partial refs are disclosed', () => {
    const f = buildSiteFlow(input({
      traces: [{ cluster: ARN, overlay: { available: false, reason: 'unavailable', workloadCalls: [], omitted: 0 } }],
      dbRefs: [{ cluster: ARN, partial: true, refs: [ref('platform', 'api-gateway', CACHE, 'elasticache')],
        resolved: { map: new Map(), capped: false, incomplete: true } }],
    }));
    expect(f.edges.some((e) => e.evidence === 'traced')).toBe(false);
    expect(ids(f)).not.toContain(PRODUCT);
    expect(edge(f, GW, DS_CACHE)?.evidence).toBe('configured');
    expect(f.gaps).toEqual(['db_refs_partial', 'inventory_incomplete', 'trace_unavailable']);
    const omitted = buildSiteFlow(input({ traces: [{ cluster: ARN, overlay: { available: true, workloadCalls: [], omitted: 3 } }] }));
    expect(omitted.gaps).toContain('partial_snapshot');
  });
  it('Review Focus 3: same-named clusters in two accounts never join traces; infra hops still drawn', () => {
    const ARN2 = `arn:aws:eks:${REGION}:111111111111:cluster/shop-az-a`;
    const VPC2 = 'vpc-member', IP2 = '10.9.0.5';
    const f = buildSiteFlow(input({
      bindings: [...IPS.map((ip, i) => binding(ip, i)), (() => { const b = binding(IP2, 9, ARN2, '111111111111');
        return { ...b, vpc: VPC2, evidence: { ...b.evidence, vpc: VPC2 } }; })()], // evidence scoped to the binding's VPC
      traces: [{ cluster: ARN, overlay: overlay() },
        { cluster: ARN2, overlay: { available: false, reason: 'ambiguous_cluster', workloadCalls: [], omitted: 0 } }],
    }, {
      tg: [tgRow('prod-wtg-az-a', IPS.slice(0, 2)), tgRow('prod-wtg-az-c', IPS.slice(2)),
        { ...tgRow('member-tg', [IP2]), vpc_id: VPC2 }],
      ipResolved: { ...flowInput().ipResolved, [scopedTargetIp(REGION, VPC2, IP2)]: { label: 'platform/api-gateway', resolved: 'eks',
        meta: { cluster: 'shop-az-a', namespace: 'platform', pod: pod(9), workload: 'api-gateway', region: REGION, vpcId: VPC2 } } },
    }));
    expect(ids(f)).toEqual(expect.arrayContaining([GW, `wl:${ARN2}:platform/api-gateway`]));
    expect(f.edges.some((e) => e.evidence === 'traced')).toBe(false);
    expect(f.gaps).toContain('ambiguous_cluster');
  });
  it('rule 6: a page path highlights the static branch and infers the API chain', () => {
    const f = buildSiteFlow({ ...input(), path: '/products/PROD-0101?ref=home' });
    expect(f.path).toBe('/products/PROD-0101');
    expect(f.highlight?.nodes).toEqual([CF, `${CF}/beh:default`, S3, R53].sort());
    expect(f.highlight?.edges).toEqual(expect.arrayContaining([`${R53}->${CF}`, `${CF}->${CF}/beh:default`, `${CF}/beh:default->${S3}`]));
    expect(f.highlight?.inferred).toEqual(expect.arrayContaining([`${CF}/beh:0`, NLB, GW, PRODUCT, DS_AURORA, `${GW}->${PRODUCT}`]));
    expect(f.highlight?.inferred).not.toContain(CF); // disjoint from the observed chain
    expect(f.highlight?.inferred).not.toContain(DS_CACHE);
    expect(f.edges.find((e) => e.id === `${GW}->${PRODUCT}`)?.evidence).toBe('traced'); // inference never relabels edges
  });
  it('rule 6: an API path follows routes exactly, with no inference', () => {
    const f = buildSiteFlow({ ...input(), path: '/api/products/PROD-0101' });
    expect(f.highlight?.nodes).toEqual(expect.arrayContaining([R53, CF, `${CF}/beh:0`, NLB, GW, PRODUCT, DS_AURORA]));
    expect(f.highlight?.nodes).not.toContain(S3);
    expect(f.highlight?.nodes).not.toContain(DS_CACHE);
    expect(f.highlight?.edges).toEqual(expect.arrayContaining([`${CF}/beh:0->${NLB}`, `${GW}->${PRODUCT}`, `${PRODUCT}->${DS_AURORA}`]));
    expect(f.highlight?.inferred).toEqual([]);
  });
  it('rule 6: the gateway routes the request its origin receives (OriginPath prepended), not the viewer path', () => {
    const v1 = cfRow({ origins: (cfRow().origins as Record<string, unknown>[]).map((o) => (o.Id === 'api-dynamic' ? { ...o, OriginPath: '/v1' } : o)) });
    const run = (routes: NonNullable<SiteFlowInput['routes']>, path: string) =>
      buildSiteFlow({ ...input({ cloudfrontRows: [v1], routes }, { cloudfront: [v1] }), path });
    const prefixed: NonNullable<SiteFlowInput['routes']> = [
      { service: 'api-gateway', route: '/v1/api/products/{id}', next: [{ service: 'product-service', route: '/products/{id}' }] }, ROUTES[1]];
    const api = run(prefixed, '/api/products/PROD-0101');
    expect(api.highlight?.nodes).toEqual(expect.arrayContaining([GW, PRODUCT, DS_AURORA]));
    expect(api.gaps).not.toContain('route_unavailable');
    const viewerShaped = run(ROUTES, '/api/products/PROD-0101'); // `/api/products/{id}` is not what the gateway receives
    expect(viewerShaped.highlight?.nodes).toContain(GW);
    expect(viewerShaped.highlight?.nodes).not.toContain(PRODUCT);
    expect(viewerShaped.gaps).toContain('route_unavailable');
    const page = run(prefixed, '/products/PROD-0101'); // the page→API inference uses the origin's path too
    expect(page.highlight?.inferred).toEqual(expect.arrayContaining([GW, PRODUCT]));
    expect(page.gaps).not.toContain('route_unavailable');
    const pageViewerShaped = run(ROUTES, '/products/PROD-0101');
    expect(pageViewerShaped.highlight?.inferred).not.toContain(PRODUCT);
    expect(pageViewerShaped.gaps).toContain('route_unavailable');
  });
  it('rule 6: a route chain that cannot be joined or has no row for the next route adds a gap and claims no datastore', () => {
    const ghost = buildSiteFlow({ ...input({ routes: [
      { service: 'api-gateway', route: '/api/products/{id}', next: [{ service: 'ghost-service', route: '/x' }] }, ROUTES[1]] }),
    path: '/api/products/PROD-0101' });
    expect(ghost.highlight?.nodes).toContain(GW);
    expect(ghost.highlight?.nodes).not.toContain(PRODUCT);
    expect(ghost.gaps).toContain('route_unavailable'); // the declared next hop has no traced edge
    const noRow = buildSiteFlow({ ...input({ routes: [ROUTES[0]] }), path: '/api/products/PROD-0101' });
    expect(noRow.highlight?.nodes).toContain(PRODUCT); // reached over the traced edge
    expect(noRow.highlight?.nodes).not.toContain(DS_AURORA); // but its route row is absent: the chain is not known to end
    expect(noRow.gaps).toContain('route_unavailable');
    const unnamed = buildSiteFlow({ ...input({ routes: [{ ...ROUTES[0], next: [{ service: 'product-service' }] }, ROUTES[1]] }),
      path: '/api/products/PROD-0101' }); // a next hop without a route template is not a terminal route either
    expect(unnamed.highlight?.nodes).toContain(PRODUCT);
    expect(unnamed.highlight?.nodes).not.toContain(DS_AURORA);
    expect(unnamed.gaps).toContain('route_unavailable');
    const ok = buildSiteFlow({ ...input(), path: '/api/products/PROD-0101' });
    expect(ok.highlight?.nodes).toContain(DS_AURORA);
    expect(ok.gaps).not.toContain('route_unavailable');
  });
  it('rule 6: an over-long request path selects no behavior', () => {
    const f = buildSiteFlow({ ...input(), path: `/api/${'a'.repeat(2044)}` });
    expect(f.highlight?.nodes).toContain(CF);
    expect(f.highlight?.nodes).not.toContain(`${CF}/beh:0`);
    expect(f.gaps).toContain('path_unmatched');
  });
  it('rule 6: an API behavior whose origin path is unknown does not report a gap when another API behavior links', () => {
    const row = cfRow({ origins: [...(cfRow().origins as Record<string, unknown>[]), { Id: 'broken', DomainName: 'api-internal.example.com', OriginPath: 5 }],
      cache_behaviors: { Quantity: 3, Items: [{ PathPattern: '/old/*', TargetOriginId: 'broken' }, { PathPattern: '/api/*', TargetOriginId: 'api-dynamic' },
        { PathPattern: '/static/*', TargetOriginId: 's3-static' }] } });
    const f = buildSiteFlow({ ...input({ cloudfrontRows: [row] }, { cloudfront: [row] }), path: '/products/PROD-0101' });
    expect(f.highlight?.inferred).toEqual(expect.arrayContaining([GW, PRODUCT]));
    expect(f.gaps).not.toContain('route_unavailable');
    const only = cfRow({ origins: [...(cfRow().origins as Record<string, unknown>[]), { Id: 'broken', DomainName: 'api-internal.example.com', OriginPath: 5 }],
      cache_behaviors: { Quantity: 2, Items: [{ PathPattern: '/old/*', TargetOriginId: 'broken' }, { PathPattern: '/static/*', TargetOriginId: 's3-static' }] } });
    expect(buildSiteFlow({ ...input({ cloudfrontRows: [only] }, { cloudfront: [only] }), path: '/products/PROD-0101' }).gaps)
      .toContain('route_unavailable'); // nothing links: the page cannot be tied to an API route
  });
  it('rule 6: missing routes stop at the gateway; ambiguous inference stops there too', () => {
    const none = buildSiteFlow({ ...input({ routes: null }), path: '/api/products/1' });
    expect(none.gaps).toContain('route_unavailable');
    expect(none.highlight?.nodes).toContain(GW);
    expect(none.highlight?.nodes).not.toContain(PRODUCT);
    const amb = buildSiteFlow({ ...input({ routes: [...ROUTES, { service: 'api-gateway', route: '/api/products/:sku' }] }),
      path: '/products/PROD-0101' });
    expect(amb.gaps).toContain('route_ambiguous');
    expect(amb.highlight?.inferred).toContain(GW);
    expect(amb.highlight?.inferred).not.toContain(PRODUCT);
    expect(buildSiteFlow(input()).highlight).toBeNull();
  });
  describe('rule 6: ALB listener rules decide the target group (I4)', () => {
    const ALB_DNS = 'web-alb-1.ap-northeast-2.elb.amazonaws.com';
    const ALB_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:loadbalancer/app/web-alb/1`, ALB = `alb:${ALB_ARN}`;
    const tgArn = (n: string) => `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:targetgroup/${n}/1`;
    const TG = (n: string) => `tg:${tgArn(n)}`;
    const tg = (n: string) => ({ resource_id: tgArn(n), target_group_name: n, target_type: 'instance', load_balancer_arns: [ALB_ARN],
      target_health_descriptions: [] });
    const rule = (priority: string, tgName: string, conditions: unknown[] = []) => ({ resource_id: `r-${priority}-${tgName}`,
      load_balancer_arn: ALB_ARN, port: 443, priority, is_default: priority === 'default', conditions,
      actions: [{ Type: 'forward', TargetGroupArn: tgArn(tgName) }] });
    const pathIs = (...Values: string[]) => ({ Field: 'path-pattern', PathPatternConfig: { Values } });
    const hostIs = (...Values: string[]) => ({ Field: 'host-header', HostHeaderConfig: { Values } });
    const run = (path: string, alb_listener_rule?: Record<string, unknown>[], tgs = ['api-tg', 'admin-tg'], host = 'app.example.com') =>
      buildSiteFlow({ host, path, bindings: [], traces: [], dbRefs: [], cloudfrontRows: [], flow: buildFlowGraph({
        alb: [{ resource_id: 'web-alb', arn: ALB_ARN, dns_name: ALB_DNS, scheme: 'internet-facing', region: REGION }],
        tg: tgs.map(tg), alb_listener_rule, route53: [r53(host, `dualstack.${ALB_DNS}`)] }) });
    const hit = (f: SiteFlow) => (f.highlight?.nodes ?? []).filter((id) => id.startsWith('tg:')).sort();

    it('an ALB with several TGs and no synced rules stops at the LB with rule_unresolved (the probe)', () => {
      const f = run('/api/x');
      expect(f.highlight?.nodes).toContain(ALB);
      expect(hit(f)).toEqual([]);
      expect(f.gaps).toContain('rule_unresolved');
      const single = run('/api/x', undefined, ['api-tg']); // the only attached TG is followed
      expect(hit(single)).toEqual([TG('api-tg')]);
      expect(single.gaps).not.toContain('rule_unresolved');
    });
    it('path-pattern rules pick one TG (ALB glob semantics, case-sensitive)', () => {
      const rules = [rule('10', 'api-tg', [pathIs('/api/*')]), rule('20', 'admin-tg', [pathIs('/admin/?ndex', '/adm/*')])];
      expect(hit(run('/api/x', rules))).toEqual([TG('api-tg')]);
      expect(hit(run('/admin/index', rules))).toEqual([TG('admin-tg')]);
      const none = run('/API/x', rules); // case-sensitive: nothing forwards, so no TG is claimed
      expect(hit(none)).toEqual([]);
      expect(none.gaps).toContain('rule_unresolved');
      expect(run('/api/x', rules).gaps).not.toContain('rule_unresolved');
    });
    it('host-header rules match the site host case-insensitively with * and ?', () => {
      const rules = [rule('1', 'admin-tg', [hostIs('ADMIN.example.com')]), rule('2', 'api-tg', [hostIs('*.EXAMPLE.co?')])];
      expect(hit(run('/x', rules))).toEqual([TG('api-tg')]); // app.example.com
      expect(hit(run('/x', rules, undefined, 'admin.example.com'))).toEqual([TG('admin-tg')]);
    });
    it('evaluates ascending priority (row order irrelevant); first match wins; default last', () => {
      const rules = [rule('default', 'admin-tg'), rule('20', 'admin-tg', [pathIs('/api/*')]), rule('5', 'api-tg', [pathIs('/api/v1/*')])];
      expect(hit(run('/api/v1/x', rules))).toEqual([TG('api-tg')]);
      expect(hit(run('/api/v1/x', [...rules].reverse()))).toEqual([TG('api-tg')]);
      expect(hit(run('/api/v2/x', rules))).toEqual([TG('admin-tg')]);
      expect(hit(run('/other', rules))).toEqual([TG('admin-tg')]); // default
      const def = run('/other', [rule('5', 'api-tg', [pathIs('/api/*')]), rule('default', 'admin-tg')]);
      expect(hit(def)).toEqual([TG('admin-tg')]);
      expect(def.gaps).not.toContain('rule_unresolved');
    });
    it('a deciding rule with another condition, or a TG edge without rules, stops at the LB', () => {
      const header = { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'x-beta', Values: ['1'] } };
      const other = run('/api/x', [rule('1', 'admin-tg', [pathIs('/api/*'), header]), rule('2', 'api-tg', [pathIs('/api/*')])]);
      expect(hit(other)).toEqual([]);
      expect(other.gaps).toContain('rule_unresolved');
      // The undecidable rule's known path condition fails, so it is skipped and the next rule decides.
      const skipped = run('/web', [rule('1', 'admin-tg', [pathIs('/api/*'), header]), rule('2', 'api-tg', [pathIs('/*')])]);
      expect(hit(skipped)).toEqual([TG('api-tg')]);
      expect(skipped.gaps).not.toContain('rule_unresolved');
      const partial = run('/api/x', [rule('1', 'api-tg', [pathIs('/api/*')])]); // admin-tg has no rule data
      expect(hit(partial)).toEqual([]);
      expect(partial.gaps).toContain('rule_unresolved');
    });
    it('the page→API inference evaluates ALB rules on the prefixed API path; an unlinked guess adds no rule gap', () => {
      const AZA = tgRow('prod-wtg-az-a', IPS.slice(0, 2)), AZC = tgRow('prod-wtg-az-c', IPS.slice(2));
      const albRule = (priority: string, tgRowId: string, conditions: unknown[] = []) => ({ resource_id: `r-${priority}`,
        load_balancer_arn: ALB_ARN, port: 443, priority, is_default: priority === 'default', conditions,
        actions: [{ Type: 'forward', TargetGroupArn: tgRowId }] });
      const header = { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'x-beta', Values: ['1'] } };
      const viaAlb = (rules: Record<string, unknown>[], pagePath: string, apiPattern = '/api/*', OriginPath?: string, routes = ROUTES) => {
        const row = cfRow({ cache_behaviors: [{ PathPattern: apiPattern, TargetOriginId: 'api-dynamic' }],
          ...(OriginPath === undefined ? {} : { origins: (cfRow().origins as Record<string, unknown>[])
            .map((o) => (o.Id === 'api-dynamic' ? { ...o, OriginPath } : o)) }) });
        return buildSiteFlow({ ...input({ cloudfrontRows: [row], routes }, {
          cloudfront: [row], nlb: [], route53: [r53('shop.example.com', 'd111111abcdef8.cloudfront.net'), r53('api-internal.example.com', `dualstack.${ALB_DNS}`)],
          alb: [{ resource_id: 'web-alb', arn: ALB_ARN, dns_name: ALB_DNS, scheme: 'internet-facing', region: REGION }],
          tg: [{ ...AZA, load_balancer_arns: [ALB_ARN] }, { ...AZC, load_balancer_arns: [ALB_ARN] }], alb_listener_rule: rules }),
        path: pagePath });
      };
      const rules = [albRule('1', AZA.resource_id, [pathIs('/api/*')]), albRule('default', AZC.resource_id)];
      for (const pattern of ['/api/*', 'api/*']) { // a pattern without a leading slash still yields a rooted API path
        const linked = viaAlb(rules, '/products/PROD-0101', pattern);
        expect(linked.highlight?.inferred).toEqual(expect.arrayContaining([`tg:${AZA.resource_id}`, GW, PRODUCT]));
        expect(linked.highlight?.inferred).not.toContain(`tg:${AZC.resource_id}`); // the unprefixed page path would hit default
        expect(linked.gaps).not.toContain('rule_unresolved');
      }
      // The speculative API walk also takes the API origin's OriginPath (T7a): `/prod` + `/api/products/…` — for the ALB
      // rules and for the gateway's route templates alike.
      const prodRoutes: NonNullable<SiteFlowInput['routes']> = [{ ...ROUTES[0], route: '/prod/api/products/{id}' }, ROUTES[1]];
      const prefixed = viaAlb([albRule('1', AZA.resource_id, [pathIs('/prod/api/*')]), albRule('default', AZC.resource_id)],
        '/products/PROD-0101', '/api/*', '/prod', prodRoutes);
      expect(prefixed.highlight?.inferred).toEqual(expect.arrayContaining([`tg:${AZA.resource_id}`, GW, PRODUCT]));
      expect(prefixed.highlight?.inferred).not.toContain(`tg:${AZC.resource_id}`);
      const unlinked = viaAlb([albRule('1', AZA.resource_id, [pathIs('/api/about'), header]), albRule('default', AZC.resource_id)], '/about');
      expect(unlinked.gaps).toContain('route_unavailable');
      expect(unlinked.gaps).not.toContain('rule_unresolved'); // the speculative /api/about walk never linked
      expect(unlinked.highlight?.inferred).toEqual([]);
    });
    // T7a: the narrowing fails closed instead of confidently highlighting one wrong TG.
    const onPort = (r: Record<string, unknown>, port: number, listener_arn?: string) => ({ ...r, port, ...(listener_arn ? { listener_arn } : {}),
      resource_id: `${r.resource_id}-${port}${listener_arn ?? ''}` });
    const nonForward = (priority: string, type: 'redirect' | 'fixed-response', conditions: unknown[] = []) => ({
      resource_id: `r-${priority}-${type}`, load_balancer_arn: ALB_ARN, port: 443, priority, is_default: priority === 'default', conditions,
      actions: [type === 'redirect' ? { Type: type, RedirectConfig: { Protocol: 'HTTPS', StatusCode: 'HTTP_301' } }
        : { Type: type, FixedResponseConfig: { StatusCode: '404' } }] });
    it('a higher-priority redirect or fixed-response rule matching the path stops at the LB (the probe)', () => {
      const redirect = [nonForward('1', 'redirect', [pathIs('/api/*')]), rule('10', 'admin-tg', [pathIs('/*')]), rule('default', 'api-tg')];
      const f = run('/api/x', redirect);
      expect(hit(f)).toEqual([]);
      expect(f.gaps).toContain('rule_unresolved');
      const other = run('/x', redirect); // the redirect's path does not match: the forward rule below decides
      expect(hit(other)).toEqual([TG('admin-tg')]);
      expect(other.gaps).not.toContain('rule_unresolved');
      const fixed = [nonForward('1', 'fixed-response', [pathIs('/api/*')]), rule('5', 'admin-tg', [pathIs('/admin/*')]), rule('default', 'api-tg')];
      expect(hit(run('/api/x', fixed))).toEqual([]);
      expect(run('/api/x', fixed).gaps).toContain('rule_unresolved');
      expect(hit(run('/other', fixed))).toEqual([TG('api-tg')]);
      const single = run('/api/x', [nonForward('1', 'fixed-response', [pathIs('/api/*')]), rule('default', 'api-tg')], ['api-tg']);
      expect(hit(single)).toEqual([]); // even a lone TG is not reached when the LB answers the request itself
      expect(single.gaps).toContain('rule_unresolved');
      const noTg = run('/x', [rule('1', 'api-tg', [pathIs('/api/*')]), rule('2', 'admin-tg', [pathIs('/admin/*')]), nonForward('default', 'redirect')]);
      expect(hit(noTg)).toEqual([]);
      expect(noTg.gaps).toContain('rule_unresolved');
      const answered = run('/api/x', [nonForward('default', 'fixed-response')], ['api-tg']); // synced rules forward nowhere
      expect(hit(answered)).toEqual([]);
      expect(answered.gaps).toContain('rule_unresolved');
      // A non-forward rule must not give a TG without forward rules a rule list (the partial-data check still fires).
      const partial = run('/api/x', [rule('1', 'api-tg', [pathIs('/api/*')]), nonForward('5', 'redirect', [pathIs('/old/*')])]);
      expect(hit(partial)).toEqual([]);
      expect(partial.gaps).toContain('rule_unresolved');
    });
    it('rules with neither listener_arn nor port have an unknown listener; an HTTPS-redirect-only LB keeps the lone-TG fallback', () => {
      const noKey = (r: Record<string, unknown>) => ({ ...r, port: undefined });
      const unkeyed = run('/api/x', [noKey(rule('10', 'api-tg', [pathIs('/api/*')])), noKey(rule('default', 'admin-tg'))]);
      expect(hit(unkeyed)).toEqual([]);
      expect(unkeyed.gaps).toContain('rule_unresolved');
      const httpsOnly = run('/x', [onPort(nonForward('default', 'redirect'), 80)], ['api-tg']); // only the :80 → HTTPS redirect synced
      expect(hit(httpsOnly)).toEqual([TG('api-tg')]);
      expect(httpsOnly.gaps).not.toContain('rule_unresolved');
      const unkeyedRedirect = run('/x', [noKey(nonForward('default', 'redirect'))], ['api-tg']); // listener unknown: not ignorable
      expect(hit(unkeyedRedirect)).toEqual([]);
      expect(unkeyedRedirect.gaps).toContain('rule_unresolved');
    });
    it('an HTTP listener that only redirects does not block the forwarding listener', () => {
      const rules = [onPort(nonForward('default', 'redirect'), 80), rule('10', 'api-tg', [pathIs('/api/*')]), rule('default', 'admin-tg')];
      const api = run('/api/x', rules), web = run('/x', rules);
      expect(hit(api)).toEqual([TG('api-tg')]);
      expect(hit(web)).toEqual([TG('admin-tg')]);
      for (const f of [api, web]) expect(f.gaps).not.toContain('rule_unresolved');
    });
    it('forward rules on more than one listener stop at the LB (the listener is unknown)', () => {
      const split = run('/api/x', [onPort(rule('5', 'admin-tg', [pathIs('/*')]), 80), rule('10', 'api-tg', [pathIs('/api/*')]), rule('default', 'admin-tg')]);
      expect(hit(split)).toEqual([]);
      expect(split.gaps).toContain('rule_unresolved');
      const defaults = run('/x', [onPort(rule('default', 'admin-tg'), 80), rule('default', 'api-tg')]);
      expect(hit(defaults)).toEqual([]);
      expect(defaults.gaps).toContain('rule_unresolved');
      const L = (n: number) => `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:listener/app/web-alb/1/${n}`;
      const byArn = run('/api/x', [onPort(rule('10', 'api-tg', [pathIs('/api/*')]), 443, L(1)), onPort(rule('default', 'admin-tg'), 443, L(2))]);
      expect(hit(byArn)).toEqual([]); // listener_arn wins over the port
      expect(byArn.gaps).toContain('rule_unresolved');
      const one = run('/api/x', [onPort(rule('10', 'api-tg', [pathIs('/api/*')]), 443, L(1)), onPort(rule('default', 'admin-tg'), 443, L(1))]);
      expect(hit(one)).toEqual([TG('api-tg')]);
      expect(one.gaps).not.toContain('rule_unresolved');
    });

    it('an LB whose rule order is unknown never reaches its lone TG while it can answer requests itself', () => {
      const answers = nonForward('1', 'fixed-response', [pathIs('/api/*')]);
      const twoListeners = run('/x', [onPort(rule('default', 'api-tg'), 80), rule('default', 'api-tg'), answers], ['api-tg']); // probe D1
      expect(hit(twoListeners)).toEqual([]);
      expect(twoListeners.gaps).toContain('rule_unresolved');
      const badPriority = run('/x', [nonForward('1', 'redirect', [pathIs('/api/*')]), rule('x9', 'api-tg', [pathIs('/z')]),
        rule('default', 'api-tg')], ['api-tg']); // probe D2
      expect(hit(badPriority)).toEqual([]);
      expect(badPriority.gaps).toContain('rule_unresolved');
      const forwardOnly = run('/x', [onPort(rule('default', 'api-tg'), 80), rule('default', 'api-tg')], ['api-tg']); // every rule forwards to it
      expect(hit(forwardOnly)).toEqual([TG('api-tg')]);
      expect(forwardOnly.gaps).not.toContain('rule_unresolved');
    });
    it('a listener without forward rules is ignored only when all its rules redirect to HTTPS', () => {
      const fixed404 = run('/x', [nonForward('default', 'fixed-response'), onPort(rule('default', 'api-tg'), 80)], ['api-tg']); // probe A3
      expect(hit(fixed404)).toEqual([]);
      expect(fixed404.gaps).toContain('rule_unresolved');
      const toHttp = { ...onPort(nonForward('default', 'redirect'), 80), actions: [{ Type: 'redirect', RedirectConfig: { Protocol: '#{protocol}', Host: 'other.example.com' } }] };
      const offsite = run('/x', [toHttp, rule('10', 'api-tg', [pathIs('/api/*')]), rule('default', 'admin-tg')]);
      expect(hit(offsite)).toEqual([]);
      expect(offsite.gaps).toContain('rule_unresolved');
      const https = run('/x', [onPort(nonForward('1', 'redirect', [pathIs('/a/*')]), 80), onPort(nonForward('default', 'redirect'), 80),
        rule('default', 'admin-tg')], ['admin-tg']);
      expect(hit(https)).toEqual([TG('admin-tg')]);
      expect(https.gaps).not.toContain('rule_unresolved');
    });
    // CloudFront in front of the ALB: the Host the ALB sees is the origin domain unless the viewer Host is forwarded
    // (not in inventory), and the origin's OriginPath is prepended to the request path.
    const CF_ID = 'D7A';
    const runCf = (path: string, rules: Record<string, unknown>[], origin: Record<string, unknown> = {}, viaVpcOrigin = false) => {
      const domain = viaVpcOrigin ? 'app.example.com' : ALB_DNS;
      const row = { resource_id: CF_ID, domain_name: 'd7a.cloudfront.net', aliases: ['app.example.com'],
        origins: [{ Id: 'alb', DomainName: domain, ...origin }], default_cache_behavior: { TargetOriginId: 'alb' } };
      return buildSiteFlow({ host: 'app.example.com', path, bindings: [], traces: [], dbRefs: [], cloudfrontRows: [row], flow: buildFlowGraph({
        alb: [{ resource_id: 'web-alb', arn: ALB_ARN, dns_name: ALB_DNS, scheme: viaVpcOrigin ? 'internal' : 'internet-facing', region: REGION }],
        tg: ['api-tg', 'admin-tg'].map(tg), alb_listener_rule: rules, cloudfront: [row],
        cloudfront_vpc_origin: viaVpcOrigin ? [{ resource_id: 'vo-1', arn: ALB_ARN, status: 'Deployed',
          origin_refs: [{ distribution_id: CF_ID, domain }] }] : [],
        route53: [r53('app.example.com', 'd7a.cloudfront.net')] }) });
    };
    it('behind CloudFront, a host rule that could decide stops at the LB unless the origin domain is the site host (the probe)', () => {
      const rules = [rule('1', 'api-tg', [hostIs('app.example.com')]), rule('default', 'admin-tg')];
      const f = runCf('/x', rules);
      expect(f.highlight?.nodes).toContain(ALB);
      expect(hit(f)).toEqual([]);
      expect(f.gaps).toContain('rule_unresolved');
      const vpc = runCf('/x', rules, {}, true); // origin DomainName = site host: the ALB sees that Host either way
      expect(vpc.highlight?.nodes).toContain(ALB);
      expect(hit(vpc)).toEqual([TG('api-tg')]);
      expect(vpc.gaps).not.toContain('rule_unresolved');
      // A host rule whose path condition fails is not a candidate; host-less rules still decide.
      const skipped = runCf('/x', [rule('1', 'api-tg', [pathIs('/admin/*'), hostIs('app.example.com')]), rule('default', 'admin-tg')]);
      expect(hit(skipped)).toEqual([TG('admin-tg')]);
      expect(skipped.gaps).not.toContain('rule_unresolved');
      expect(run('/x', rules).gaps).not.toContain('rule_unresolved'); // Route 53 straight to the ALB: Host is the site host
    });
    it('behind CloudFront, the origin OriginPath is prepended before ALB path matching', () => {
      const rules = [rule('1', 'api-tg', [pathIs('/v1/api/*')]), rule('default', 'admin-tg')];
      const f = runCf('/api/x', rules, { OriginPath: '/v1' });
      expect(hit(f)).toEqual([TG('api-tg')]);
      expect(f.gaps).not.toContain('rule_unresolved');
      expect(hit(runCf('/api/x', rules, { OriginPath: '/v1/' }))).toEqual([TG('api-tg')]); // trailing slash not doubled
      expect(hit(runCf('/api/x', rules))).toEqual([TG('admin-tg')]); // no OriginPath
      expect(hit(runCf('/api/x', rules, { OriginPath: '' }))).toEqual([TG('admin-tg')]);
      // `cloudfrontRows` without `origins` (a projected row): the flow node's own row still supplies the OriginPath.
      const projected = runCf('/api/x', rules, { OriginPath: '/v1' });
      const flowOnly = buildSiteFlow({ host: 'app.example.com', path: '/api/x', bindings: [], traces: [], dbRefs: [],
        cloudfrontRows: [{ resource_id: CF_ID, default_cache_behavior: { TargetOriginId: 'alb' } }],
        flow: buildFlowGraph({ alb: [{ resource_id: 'web-alb', arn: ALB_ARN, dns_name: ALB_DNS, scheme: 'internet-facing', region: REGION }],
          tg: ['api-tg', 'admin-tg'].map(tg), alb_listener_rule: rules, route53: [r53('app.example.com', 'd7a.cloudfront.net')],
          cloudfront: [{ resource_id: CF_ID, domain_name: 'd7a.cloudfront.net', aliases: ['app.example.com'],
            origins: [{ Id: 'alb', DomainName: ALB_DNS, OriginPath: '/v1' }], default_cache_behavior: { TargetOriginId: 'alb' } }] }) });
      expect(hit(flowOnly)).toEqual(hit(projected));
      expect(hit(flowOnly)).toEqual([TG('api-tg')]);
      const bad = runCf('/api/x', rules, { OriginPath: 5 }); // unreadable OriginPath: the ALB path is unknown
      expect(hit(bad)).toEqual([]);
      expect(bad.gaps).toContain('rule_unresolved');
    });
    it('a hop other than DNS or a CloudFront behavior loses the Host the ALB sees', () => {
      const n = (id: string, kind: SiteNode['kind']): [string, SiteNode] => [id, { id, kind, label: id }];
      const e = (source: string, target: string): [string, SiteEdge] => [`${source}->${target}`, { id: `${source}->${target}`, source, target, evidence: 'observed' }];
      const rules = (r: FlowEdge['rules']) => r;
      const flowEdges = new Map<string, FlowEdge>([
        ['alb->tg:a', { id: 'alb->tg:a', source: 'alb', target: 'tg:a', confidence: 'observed', rules: rules([{ priority: 1, paths: [], hosts: ['app.example.com'], other: false }]) }],
        ['alb->tg:b', { id: 'alb->tg:b', source: 'alb', target: 'tg:b', confidence: 'observed', rules: rules([{ priority: 'default', paths: [], hosts: [], other: false }]) }],
      ]);
      const walk = (via: 'dns' | 'lb') => {
        const gaps = new Set<SiteGap>();
        const nodes = new Map([n('r53', 'dns'), n('mid', via), n('alb', 'lb'), n('tg:a', 'tg'), n('tg:b', 'tg')]);
        const edges = new Map([e('r53', 'mid'), e('mid', 'alb'), e('alb', 'tg:a'), e('alb', 'tg:b')]);
        const h = computeHighlight({ host: 'app.example.com', path: '/x', entries: ['r53'], nodes, edges, behaviorsOf: new Map(), originOf: new Map(),
          wlInfo: new Map(), flowNodes: new Map<string, FlowNode>([['alb', { id: 'alb', kind: 'alb', label: 'alb' }]]), flowEdges, routes: null, gaps });
        return { tgs: h.nodes.filter((id) => id.startsWith('tg:')), gaps: [...gaps] };
      };
      expect(walk('dns')).toEqual({ tgs: ['tg:a'], gaps: [] }); // a DNS chain keeps the site host
      expect(walk('lb')).toEqual({ tgs: [], gaps: ['rule_unresolved'] }); // e.g. API Gateway VPC link → ALB
    });
    it('route following tracks (service, route): one service reached under two routes follows both; a real cycle ends', () => {
      const wl = (id: string): [string, { arn: string; namespace: string; name: string }] => [id, { arn: 'c', namespace: 'ns', name: id }];
      const n = (id: string, kind: SiteNode['kind']): [string, SiteNode] => [id, { id, kind, label: id }];
      const e = (source: string, target: string, evidence: SiteEdge['evidence'] = 'traced'): [string, SiteEdge] =>
        [`${source}->${target}`, { id: `${source}->${target}`, source, target, evidence }];
      const run = (routes: NonNullable<SiteFlowInput['routes']>, extra: [string, SiteEdge][] = []) => {
        const gaps = new Set<SiteGap>();
        const nodes = new Map([n('r53', 'dns'), n('gw', 'workload'), n('p', 'service'), n('a', 'service'), n('b', 'service'),
          n('dsA', 'datastore'), n('dsB', 'datastore')]);
        const edges = new Map([e('r53', 'gw', 'observed'), e('gw', 'p'), e('p', 'a'), e('p', 'b'), e('a', 'dsA', 'configured'),
          e('b', 'dsB', 'configured'), ...extra]);
        const h = computeHighlight({ host: 'shop.example.com', path: '/api/x', entries: ['r53'], nodes, edges, behaviorsOf: new Map(),
          originOf: new Map(), wlInfo: new Map([wl('gw'), wl('p'), wl('a'), wl('b')]), flowNodes: new Map(), flowEdges: new Map(), routes, gaps });
        return { nodes: h.nodes, gaps: [...gaps] };
      };
      const two = run([{ service: 'gw', route: '/api/x', next: [{ service: 'p', route: '/a' }, { service: 'p', route: '/b' }] },
        { service: 'p', route: '/a', next: [{ service: 'a', route: '/x' }] }, { service: 'p', route: '/b', next: [{ service: 'b', route: '/y' }] },
        { service: 'a', route: '/x' }, { service: 'b', route: '/y' }]);
      expect(two.nodes).toEqual(expect.arrayContaining(['a', 'b', 'dsA', 'dsB']));
      expect(two.gaps).toEqual([]);
      const cycle = run([{ service: 'gw', route: '/api/x', next: [{ service: 'p', route: '/a' }] },
        { service: 'p', route: '/a', next: [{ service: 'gw', route: '/api/x' }] }], [e('p', 'gw')]);
      expect(cycle.nodes).toEqual(expect.arrayContaining(['gw', 'p'])); // terminates
      expect(cycle.nodes).not.toContain('dsA');
    });
    it('a forward rule to a target group that is not synced stops at the LB when it matches', () => {
      const ghost = (priority: string, conditions: unknown[] = []) => ({ ...rule(priority, 'api-tg', conditions),
        resource_id: `r-${priority}-ghost`, actions: [{ Type: 'forward', TargetGroupArn: tgArn('ghost-tg') }] });
      const lone = [ghost('5', [pathIs('/admin/*')]), rule('default', 'api-tg')];
      const admin = run('/admin/x', lone, ['api-tg']);
      expect(hit(admin)).toEqual([]);
      expect(admin.gaps).toContain('rule_unresolved');
      expect(hit(run('/x', lone, ['api-tg']))).toEqual([TG('api-tg')]); // the synced default still decides other paths
      const two = [rule('1', 'api-tg', [pathIs('/api/*')]), ghost('5', [pathIs('/admin/*')]), rule('default', 'admin-tg')];
      expect(hit(run('/admin/x', two))).toEqual([]);
      expect(hit(run('/api/x', two))).toEqual([TG('api-tg')]);
      const onlyGhost = run('/x', [ghost('default')], ['api-tg']); // every forward rule goes to an unsynced TG
      expect(hit(onlyGhost)).toEqual([]);
      expect(onlyGhost.gaps).toContain('rule_unresolved');
      const unordered = run('/x', [onPort(ghost('default'), 80), rule('default', 'api-tg')], ['api-tg']); // two listeners + unsynced TG
      expect(hit(unordered)).toEqual([]);
      expect(unordered.gaps).toContain('rule_unresolved');
    });
    it('a weight-0 target of a weighted forward is not a forward target', () => {
      const weighted = (priority: string, weights: [string, number][], conditions: unknown[]) => ({ ...rule(priority, 'api-tg', conditions),
        resource_id: `r-${priority}-w`, actions: [{ Type: 'forward', ForwardConfig: { TargetGroups: weights.map(([n, Weight]) => ({ TargetGroupArn: tgArn(n), Weight })) } }] });
      const f = run('/api/x', [weighted('1', [['api-tg', 100], ['admin-tg', 0]], [pathIs('/api/*')]), rule('default', 'admin-tg')]);
      expect(hit(f)).toEqual([TG('api-tg')]);
      expect(f.gaps).not.toContain('rule_unresolved');
      const none = run('/api/x', [weighted('1', [['api-tg', 0], ['admin-tg', 0]], [pathIs('/api/*')]), rule('default', 'admin-tg')]);
      expect(hit(none)).toEqual([]); // forwards nowhere: answered at the LB
      expect(none.gaps).toContain('rule_unresolved');
    });
    it('blue/green: a synced TG that only ever gets weight 0 receives nothing; an unreadable weight is undecidable', () => {
      const bg = (weights: [string, unknown][], tgs = ['api-tg', 'admin-tg']) => run('/x', [{ ...rule('default', 'api-tg'), resource_id: 'r-bg',
        actions: [{ Type: 'forward', ForwardConfig: { TargetGroups: weights.map(([n, Weight]) => ({ TargetGroupArn: tgArn(n), ...(Weight === undefined ? {} : { Weight }) })) } }] }], tgs);
      const blue = bg([['api-tg', 100], ['admin-tg', 0]]); // admin-tg has no other rule
      expect(hit(blue)).toEqual([TG('api-tg')]);
      expect(blue.gaps).not.toContain('rule_unresolved');
      expect(hit(bg([['api-tg', 100], ['admin-tg', '0']]))).toEqual([TG('api-tg')]); // the exact string "0" too
      expect(hit(bg([['api-tg', 0], ['admin-tg', 0]]))).toEqual([]); // nothing receives anything: answered at the LB
      for (const w of ['', ' ', false, [], -1, '00', 'abc']) {
        const f = bg([['api-tg', 100], ['admin-tg', w]]);
        expect(hit(f)).toEqual([]);
        expect(f.gaps).toContain('rule_unresolved');
      }
      const unsyncedGreen = bg([['api-tg', 100], ['admin-tg', '']], ['api-tg']); // unreadable weight to an unsynced TG
      expect(hit(unsyncedGreen)).toEqual([]);
      expect(unsyncedGreen.gaps).toContain('rule_unresolved');
      const absent = bg([['api-tg', 100], ['admin-tg', undefined]]); // absent Weight keeps the target
      expect(hit(absent)).toEqual([TG('admin-tg'), TG('api-tg')].sort());
      expect(hit(bg([['api-tg', '100'], ['admin-tg', 0]]))).toEqual([TG('api-tg')]);
    });
    it('unreadable conditions/actions, over-long patterns and over-long request paths are undecidable', () => {
      const garbled = run('/x', [{ ...rule('default', 'api-tg'), conditions: '[{"Field":' }, rule('1', 'admin-tg', [pathIs('/admin/*')])]);
      expect(hit(garbled)).toEqual([]); // an unparseable conditions string is not "no conditions"
      expect(garbled.gaps).toContain('rule_unresolved');
      const badActions = run('/api/x', [{ ...rule('1', 'admin-tg', [pathIs('/api/*')]), actions: 'not json' }, rule('default', 'api-tg')]);
      expect(hit(badActions)).toEqual([]);
      const long = run('/x', [rule('1', 'admin-tg', [pathIs(`/${'a'.repeat(128)}`)]), rule('default', 'api-tg')]); // 129 chars
      expect(hit(long)).toEqual([]);
      expect(long.gaps).toContain('rule_unresolved');
      expect(hit(run('/x', [rule('1', 'admin-tg', [pathIs(`/${'a'.repeat(127)}`)]), rule('default', 'api-tg')]))).toEqual([TG('api-tg')]);
      const rules = [rule('1', 'api-tg', [pathIs('/api/*')]), rule('default', 'admin-tg')];
      const longPath = run(`/api/${'a'.repeat(2044)}`, rules); // 2049 chars: not matched
      expect(hit(longPath)).toEqual([]);
      expect(longPath.gaps).toContain('rule_unresolved');
      expect(hit(run(`/api/${'a'.repeat(2043)}`, rules))).toEqual([TG('api-tg')]); // 2048 chars
    });
    it('a pathological ALB path or host pattern against a long path completes quickly', () => {
      const pattern = `/${'*a'.repeat(63)}b`; // 128 characters
      expect(pattern.length).toBe(128);
      const t0 = performance.now();
      const f = run(`/${'a'.repeat(2047)}`, [rule('1', 'admin-tg', [pathIs(pattern)]), rule('2', 'admin-tg', [hostIs(pattern.slice(1) + 'x')]),
        rule('default', 'api-tg')]);
      expect(hit(f)).toEqual([TG('api-tg')]);
      expect(performance.now() - t0).toBeLessThan(50);
    });
    it('an LB whose only rule data gives a TG weight 0 never falls back to another, rule-less TG', () => {
      const zeroOnly = run('/x', [{ ...rule('default', 'api-tg'), resource_id: 'r-zero',
        actions: [{ Type: 'forward', ForwardConfig: { TargetGroups: [{ TargetGroupArn: tgArn('api-tg'), Weight: 0 }] } }] }]);
      expect(hit(zeroOnly)).toEqual([]); // the LB answers (503); admin-tg is named by no rule
      expect(zeroOnly.gaps).toContain('rule_unresolved');
      // The walk itself: a receivesNothing edge beside a rule-less one is rule data, so no lone-TG fallback.
      const n = (id: string, kind: SiteNode['kind']): [string, SiteNode] => [id, { id, kind, label: id }];
      const e = (source: string, target: string): [string, SiteEdge] => [`${source}->${target}`, { id: `${source}->${target}`, source, target, evidence: 'observed' }];
      const gaps = new Set<SiteGap>();
      const h = computeHighlight({ host: 'shop.example.com', path: '/x', entries: ['r53'], nodes: new Map([n('r53', 'dns'), n('alb', 'lb'), n('tg:a', 'tg'), n('tg:b', 'tg')]),
        edges: new Map([e('r53', 'alb'), e('alb', 'tg:a'), e('alb', 'tg:b')]), behaviorsOf: new Map(), originOf: new Map(), wlInfo: new Map(),
        flowNodes: new Map<string, FlowNode>([['alb', { id: 'alb', kind: 'alb', label: 'alb' }]]), routes: null, gaps,
        flowEdges: new Map<string, FlowEdge>([['alb->tg:a', { id: 'alb->tg:a', source: 'alb', target: 'tg:a', confidence: 'observed', receivesNothing: true }],
          ['alb->tg:b', { id: 'alb->tg:b', source: 'alb', target: 'tg:b', confidence: 'observed' }]]) });
      expect(h.nodes.filter((id) => id.startsWith('tg:'))).toEqual([]);
      expect([...gaps]).toEqual(['rule_unresolved']);
    });
    it('a gateway with no workload name gets no route candidates', () => {
      const n = (id: string, kind: SiteNode['kind']): [string, SiteNode] => [id, { id, kind, label: id }];
      const gaps = new Set<SiteGap>();
      computeHighlight({ host: 'shop.example.com', path: '/api/x', entries: ['r53'], nodes: new Map([n('r53', 'dns'), n('gw', 'workload')]),
        edges: new Map([['r53->gw', { id: 'r53->gw', source: 'r53', target: 'gw', evidence: 'observed' }]]), behaviorsOf: new Map(),
        originOf: new Map(), wlInfo: new Map(), flowNodes: new Map(), flowEdges: new Map(), gaps,
        routes: [{ service: 'a', route: '/api/x' }, { service: 'b', route: '/api/x' }] });
      expect([...gaps]).toEqual(['route_unavailable']); // not route_ambiguous across unrelated services
    });
    it('an NLB has no rules and keeps following every TG', () => {
      const f = buildSiteFlow({ ...input(), path: '/api/products/1' });
      expect(f.highlight?.nodes).toEqual(expect.arrayContaining(f.nodes.filter((n) => n.kind === 'tg').map((n) => n.id)));
      expect(f.gaps).not.toContain('rule_unresolved');
    });
  });
  it('rule 6: an unjoinable next hop is not terminal; inference only ranks gateway routes', () => {
    const noTrace = buildSiteFlow({ ...input({ traces: [{ cluster: ARN, overlay: { available: false, reason: 'disabled',
      workloadCalls: [], omitted: 0 } }] }), path: '/api/products/1' });
    expect(noTrace.highlight?.nodes).toContain(GW);
    expect(noTrace.highlight?.nodes).not.toContain(DS_CACHE);
    const tie = buildSiteFlow({ ...input({ routes: [...ROUTES, { service: 'product-service', route: '/api/products/:pid' }] }),
      path: '/products/PROD-0101' });
    expect(tie.gaps).not.toContain('route_ambiguous');
    expect(tie.highlight?.inferred).toContain(PRODUCT);
    const noRoute = buildSiteFlow({ ...input({ routes: [{ service: 'other', route: '/api/x' }] }), path: '/api/products/1' });
    expect(noRoute.gaps).toContain('route_unavailable');
    const dupCall = buildSiteFlow({ ...input({ traces: [{ cluster: ARN, overlay: { ...overlay(), workloadCalls: [...overlay().workloadCalls,
      { fromWorkload: { namespace: 'platform', name: 'api-gateway' }, to: { workload: { namespace: 'shadow', name: 'product-service' } } }] } }] }),
      path: '/api/products/1' });
    expect(dupCall.gaps).toContain('route_ambiguous'); // two traced callees named product-service
    expect(dupCall.highlight?.nodes).not.toContain(PRODUCT);
  });
  it('rule 6: an earlier API-shaped behavior does not shadow /api/*', () => {
    const row = cfRow({ origins: [...cfRow().origins as object[], { Id: 'auth', DomainName: 'auth.example.net' }],
      cache_behaviors: [{ PathPattern: '/auth/*', TargetOriginId: 'auth' }, { PathPattern: '/old/*', TargetOriginId: 'gone' },
        { PathPattern: '/api/*', TargetOriginId: 'api-dynamic' }] });
    const f = buildSiteFlow({ ...input({ cloudfrontRows: [row] }, { cloudfront: [row] }), path: '/products/PROD-0101' });
    expect(f.highlight?.inferred).toEqual(expect.arrayContaining([`${CF}/beh:2`, GW, PRODUCT]));
  });
  it('rule 6: the page→API inference walks only the behavior CloudFront would select for the API call', () => {
    const row = cfRow({ origins: [...cfRow().origins as object[], { Id: 'api-b', DomainName: 'api-internal.example.com' }],
      cache_behaviors: [{ PathPattern: '/api/products/*', TargetOriginId: 'api-b' }, { PathPattern: '/api/*', TargetOriginId: 'api-dynamic' },
        { PathPattern: '/static/*', TargetOriginId: 's3-static' }] });
    const run = (routes: NonNullable<SiteFlowInput['routes']>) =>
      buildSiteFlow({ ...input({ cloudfrontRows: [row], routes }, { cloudfront: [row] }), path: '/products/PROD-0101' });
    // `/api/*` would build `/api/products/PROD-0101`, which CloudFront sends to `/api/products/*`: no inference via A.
    const viaA = run(ROUTES);
    expect(viaA.highlight?.inferred).not.toContain(`${CF}/beh:1`);
    expect(viaA.highlight?.inferred).not.toContain(PRODUCT);
    expect(viaA.gaps).toContain('route_unavailable');
    const viaB = run([...ROUTES, { service: 'api-gateway', route: '/api/products/products/{id}', next: [{ service: 'product-service', route: '/products/{id}' }] }]);
    expect(viaB.highlight?.inferred).toEqual(expect.arrayContaining([`${CF}/beh:0`, GW, PRODUCT]));
    expect(viaB.highlight?.inferred).not.toContain(`${CF}/beh:1`);
  });
  it('rule 6: a static page that no API route matches reports route_unavailable', () => {
    const f = buildSiteFlow({ ...input(), path: '/about' });
    expect(f.gaps).toEqual(['route_unavailable']);
    expect(f.highlight?.inferred).toEqual([]);
    expect(buildSiteFlow({ ...input(), path: '/products/PROD-0101' }).gaps).toEqual([]); // matched: no gap
  });
  it('rules 5/6: trace reasons map to gaps; unresolved trace hosts and cross-cluster hosts', () => {
    const reasons = [['disabled', 'trace_unavailable'], ['unsupported_scope', 'trace_unavailable'], ['unavailable', 'trace_unavailable'],
      ['incomplete_listing', 'incomplete_listing'], ['partial_snapshot', 'partial_snapshot']] as const;
    for (const [reason, gap] of reasons) {
      const f = buildSiteFlow(input({ traces: [{ cluster: ARN, overlay: { available: false, reason, workloadCalls: [], omitted: 0 } }] }));
      expect(f.gaps).toEqual([gap]);
    }
    const skipped = buildSiteFlow(input({ traces: [{ cluster: ARN, overlay: { ...overlay(), skipped: 2 } }] }));
    expect(skipped.gaps).toEqual(['trace_unmapped']);
    expect(edge(skipped, GW, PRODUCT)?.evidence).toBe('traced'); // mapped edges are kept
    const OTHER = 'orders-db.cluster-xyz.ap-northeast-2.rds.amazonaws.com';
    const ARN_C = `arn:aws:eks:${REGION}:${ACCT}:cluster/shop-az-c`, IPC = '10.2.5.5';
    const f = buildSiteFlow(input({
      bindings: [...IPS.map((ip, i) => binding(ip, i)), { ...binding(IPC, 7, ARN_C) }],
      traces: [{ cluster: ARN, overlay: { ...overlay(), workloadCalls: [...overlay().workloadCalls,
        { fromWorkload: { namespace: 'platform', name: 'api-gateway' }, to: { datastoreHost: OTHER } }] } },
      { cluster: ARN_C, overlay: { available: true, omitted: 0, workloadCalls: [
        { fromWorkload: { namespace: 'platform', name: 'api-gateway' }, to: { datastoreHost: AURORA } }] } }],
      dbRefs: [...input().dbRefs, { cluster: ARN_C, partial: false, refs: [], resolved: { map: new Map(), capped: false, incomplete: false } }],
    }, {
      tg: [tgRow('prod-wtg-az-a', IPS.slice(0, 2)), tgRow('prod-wtg-az-c', IPS.slice(2)), tgRow('az-c-tg', [IPC])],
      ipResolved: { ...flowInput().ipResolved, [scopedTargetIp(REGION, VPC, IPC)]: { label: 'platform/api-gateway', resolved: 'eks',
        meta: { cluster: 'shop-az-c', namespace: 'platform', pod: pod(7), workload: 'api-gateway', region: REGION, vpcId: VPC } } },
    }));
    expect(node(f, `ds:rds:${OTHER}`)).toMatchObject({ kind: 'datastore', label: OTHER, group: 'datastore:unresolved' });
    expect(edge(f, GW, `ds:rds:${OTHER}`)?.evidence).toBe('traced');
    expect(edge(f, `wl:${ARN_C}:platform/api-gateway`, DS_AURORA)?.evidence).toBe('traced'); // one node across clusters
    expect(ids(f)).not.toContain(`ds:rds:${AURORA}`);
  });
  it('a host two clusters resolve to different resources keeps each resolution and reports inventory_incomplete', () => {
    const ARN_C = `arn:aws:eks:${REGION}:${ACCT}:cluster/shop-az-c`, IPC = '10.2.5.5';
    const otherAurora: DbResource = { type: 'rds_cluster', id: 'other-aurora', region: REGION, accountId: ACCT };
    const run = (cResolved: Map<string, DbResource>) => buildSiteFlow(input({
      bindings: [...IPS.map((ip, i) => binding(ip, i)), { ...binding(IPC, 7, ARN_C) }],
      traces: [{ cluster: ARN, overlay: overlay() }, { cluster: ARN_C, overlay: { available: true, omitted: 0, workloadCalls: [
        { fromWorkload: { namespace: 'platform', name: 'api-gateway' }, to: { datastoreHost: AURORA } }] } }],
      dbRefs: [...input().dbRefs, { cluster: ARN_C, partial: false, refs: [], resolved: { map: cResolved, capped: false, incomplete: false } }],
    }, {
      tg: [tgRow('prod-wtg-az-a', IPS.slice(0, 2)), tgRow('prod-wtg-az-c', IPS.slice(2)), tgRow('az-c-tg', [IPC])],
      ipResolved: { ...flowInput().ipResolved, [scopedTargetIp(REGION, VPC, IPC)]: { label: 'platform/api-gateway', resolved: 'eks',
        meta: { cluster: 'shop-az-c', namespace: 'platform', pod: pod(7), workload: 'api-gateway', region: REGION, vpcId: VPC } } },
    }));
    const f = run(new Map([[AURORA, otherAurora]]));
    expect(edge(f, PRODUCT, DS_AURORA)?.evidence).toBe('traced'); // each cluster keeps its own resolution
    expect(edge(f, `wl:${ARN_C}:platform/api-gateway`, `ds:rds_cluster:${ACCT}:${REGION}:other-aurora`)?.evidence).toBe('traced');
    expect(f.gaps).toContain('inventory_incomplete');
    const agree = run(new Map([[AURORA, aurora]]));
    expect(agree.gaps).not.toContain('inventory_incomplete');
  });
  it('M3: missing routes add route_unavailable only when a gateway or an API behavior is reached', () => {
    const lone = { resource_id: 'ELONE', domain_name: 'dlone.cloudfront.net', aliases: ['lone.example.com'], origins: [] };
    const staticOnly = buildSiteFlow({ ...input({ host: 'lone.example.com', cloudfrontRows: [lone], routes: null },
      { cloudfront: [cfRow(), lone] }), path: '/x' });
    expect(staticOnly.gaps).not.toContain('route_unavailable');
    const page = buildSiteFlow({ ...input({ routes: null }), path: '/products/1' }); // static page, API behavior exists
    expect(page.gaps).toContain('route_unavailable');
    expect(page.highlight?.inferred).toEqual([]);
    const api = buildSiteFlow({ ...input({ routes: null }), path: '/api/products/1' });
    expect(api.gaps).toContain('route_unavailable');
  });
  it('M4: a path that matches no behavior (no default) reports path_unmatched', () => {
    const row = cfRow({ default_cache_behavior: undefined });
    const f = buildSiteFlow({ ...input({ cloudfrontRows: [row] }, { cloudfront: [row] }), path: '/about' });
    expect(f.gaps).toContain('path_unmatched');
    expect(f.highlight?.nodes).toEqual([CF, R53]);
    const matched = buildSiteFlow({ ...input({ cloudfrontRows: [row] }, { cloudfront: [row] }), path: '/api/products/1' });
    expect(matched.gaps).not.toContain('path_unmatched');
    const bad = cfRow({ cache_behaviors: [{ PathPattern: '/api/*' }] }); // behaviors_unavailable, not path_unmatched
    expect(buildSiteFlow({ ...input({ cloudfrontRows: [bad] }, { cloudfront: [bad] }), path: '/about' }).gaps).not.toContain('path_unmatched');
  });
  it('M8: duplicate trace entries for one cluster count once (first entry wins)', () => {
    const half: TraceOverlay = { available: true, omitted: 0, workloadCalls: [
      { fromWorkload: { namespace: 'platform', name: 'api-gateway' }, to: { workload: { namespace: 'business', name: 'product-service' } }, spanCount: 7 }] };
    const f = buildSiteFlow(input({ traces: [{ cluster: ARN, overlay: overlay() }, { cluster: ARN, overlay: overlay() }, { cluster: ARN, overlay: half }] }));
    expect(edge(f, GW, PRODUCT)).toMatchObject({ evidence: 'traced', calls: 120, errors: 2 });
    expect(edge(f, PRODUCT, DS_AURORA)?.calls).toBe(80);
    const first = buildSiteFlow(input({ traces: [{ cluster: ARN, overlay: half }, { cluster: ARN, overlay: overlay() }] }));
    expect(edge(first, GW, PRODUCT)?.calls).toBe(7);
  });
  it('M9: a bound cluster without a traces or dbRefs entry is disclosed; input gaps pass through', () => {
    const noTrace = buildSiteFlow(input({ traces: [] }));
    expect(noTrace.gaps).toEqual(['trace_unavailable']);
    expect(noTrace.edges.some((e) => e.evidence === 'traced')).toBe(false);
    const noRefs = buildSiteFlow(input({ dbRefs: [] }));
    expect(noRefs.gaps).toEqual(['db_refs_partial']);
    expect(edge(noRefs, GW, DS_CACHE)).toBeUndefined();
    const passed = buildSiteFlow(input({ gaps: ['inventory_incomplete', 'trace_unavailable', 'inventory_incomplete'] }));
    expect(passed.gaps).toEqual(['inventory_incomplete', 'trace_unavailable']);
    expect(buildSiteFlow(input({ host: 'nope.example.com', gaps: ['partial_snapshot'] })).gaps).toEqual(['host_not_found', 'partial_snapshot']);
  });
  it('rule 7: groups nest host → cdn → lb → cluster → namespace; datastores by type', () => {
    const f = buildSiteFlow(input());
    const parent = Object.fromEntries(f.groups.map((g) => [g.id, g.parent]));
    expect(parent).toEqual({
      'host:shop.example.com': undefined, [`cdn:${CF}`]: 'host:shop.example.com', [`lb:${NLB}`]: `cdn:${CF}`,
      [`cluster:${ARN}`]: `lb:${NLB}`, [`ns:${ARN}:platform`]: `cluster:${ARN}`, [`ns:${ARN}:business`]: `cluster:${ARN}`,
      'datastore:rds_cluster': 'host:shop.example.com', 'datastore:unresolved': 'host:shop.example.com',
    });
    expect(f.groups.find((g) => g.id === `cluster:${ARN}`)?.label).toBe('shop-az-a');
    expect(node(f, R53)?.group).toBe('host:shop.example.com');
    expect(node(f, S3)?.group).toBe(`cdn:${CF}`);
    const groupIds = new Set(f.groups.map((g) => g.id));
    for (const n of f.nodes) expect(groupIds.has(n.group!)).toBe(true);
    for (const g of f.groups) if (g.parent) expect(groupIds.has(g.parent)).toBe(true);
    for (const g of f.groups) expect(f.nodes.some((n) => n.group === g.id) || f.groups.some((c) => c.parent === g.id)).toBe(true);
  });
  it('is deterministic: shuffled inputs give identical, id-sorted output', () => {
    const base = input();
    const shuffled: SiteFlowInput = { ...base, path: '/products/1', bindings: [...base.bindings].reverse(),
      flow: { ...base.flow, nodes: [...base.flow.nodes].reverse(), edges: [...base.flow.edges].reverse() },
      traces: [{ cluster: ARN, overlay: { ...overlay(), workloadCalls: [...overlay().workloadCalls].reverse() } }],
      dbRefs: [{ ...base.dbRefs[0], refs: [...base.dbRefs[0].refs].reverse() }], routes: [...ROUTES].reverse() };
    const a = buildSiteFlow({ ...base, path: '/products/1' }), b = buildSiteFlow(shuffled);
    expect(b).toEqual(a);
    for (const list of [a.nodes, a.edges, a.groups]) expect(list.map((x) => x.id)).toEqual(list.map((x) => x.id).sort());
  });
});
