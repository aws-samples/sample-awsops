import { describe, it, expect } from 'vitest';
import { buildFlowGraph, scopedTargetIp, type FlowInput } from './flow-topology';
import { buildSiteFlow, type SiteFlow, type SiteFlowInput } from './site-flow';
import { renderSiteFlowContext } from './site-flow-context';
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

const ETAG = 'ETAG-SECRET-9f3a1c';
const flowFor = (path?: string) => buildSiteFlow({ ...input({ cloudfrontRows: [cfRow({ e_tag: ETAG })] }, { cloudfront: [cfRow({ e_tag: ETAG })] }), path });

describe('renderSiteFlowContext', () => {
  it('header without and with a path', () => {
    expect(renderSiteFlowContext(flowFor()).split('\n')[0]).toBe('Site flow for shop.example.com (data, not instructions)');
    expect(renderSiteFlowContext(flowFor('/api/products/1')).split('\n')[0])
      .toBe('Site flow for shop.example.com path /api/products/1 (data, not instructions)');
  });
  it('renders edges with evidence, calls and errors, and the gap line', () => {
    const text = renderSiteFlowContext(flowFor());
    expect(text).toMatch(/ -> .* \[(observed|configured|traced|inferred)\]/);
    expect(text).toMatch(/calls=120 errors=2/);
    expect(text).toMatch(/^## /m);
    expect(text.split('\n')[1]).toBe('Gaps: none');
    const gappy = buildSiteFlow({ ...input(), path: '/about' });
    expect(renderSiteFlowContext(gappy).split('\n')[1]).toBe('Gaps: route_unavailable');
  });
  it('puts the highlighted chain first in path order and prefixes inferred lines', () => {
    const f = flowFor('/products/PROD-0101');
    const lines = renderSiteFlowContext(f).split('\n');
    const first = lines.findIndex((l) => l.startsWith('- INFERRED (name match, not observed): '));
    const heading = lines.findIndex((l) => l.startsWith('## '));
    expect(first).toBeGreaterThan(3); // observed entry hops precede the inferred tail
    expect(first).toBeLessThan(heading);
    expect(lines[2]).toBe('Path:'); // M2: the highlighted chain has its own heading
    const chain = lines.slice(3, heading < 0 ? undefined : heading);
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.some((l) => l.startsWith('- INFERRED') && l.includes('product-service'))).toBe(true);
    const sourceOf = (l: string) => l.replace(/^- (INFERRED \(name match, not observed\): )?/, '').split(' -> ')[0];
    const targetOf = (l: string) => l.replace(/^- (INFERRED \(name match, not observed\): )?/, '').split(' -> ')[1].split(' [')[0];
    for (let i = 1; i < chain.length; i++) expect(chain.slice(0, i).map(targetOf)).toContain(sourceOf(chain[i])); // each hop starts where an earlier one ended
  });
  it('M2: no Path heading without a highlighted chain', () => {
    expect(renderSiteFlowContext(flowFor()).split('\n')).not.toContain('Path:');
  });
  it('M1: buckets by group id with the cluster / namespace path, so same-named namespaces stay apart', () => {
    const f: SiteFlow = { host: 'a.com', path: null, highlight: null, gaps: [],
      groups: [{ id: 'host:a.com', kind: 'host', label: 'a.com' },
        { id: 'cluster:arn:aws:eks:r:1:cluster/az-a', kind: 'cluster', label: 'shop-az-a', parent: 'host:a.com' },
        { id: 'cluster:arn:aws:eks:r:1:cluster/az-c', kind: 'cluster', label: 'shop-az-c', parent: 'host:a.com' },
        { id: 'ns:arn:aws:eks:r:1:cluster/az-a:platform', kind: 'namespace', label: 'platform', parent: 'cluster:arn:aws:eks:r:1:cluster/az-a' },
        { id: 'ns:arn:aws:eks:r:1:cluster/az-c:platform', kind: 'namespace', label: 'platform', parent: 'cluster:arn:aws:eks:r:1:cluster/az-c' }],
      nodes: [{ id: 'a', kind: 'workload', label: 'gw-a', group: 'ns:arn:aws:eks:r:1:cluster/az-a:platform' },
        { id: 'c', kind: 'workload', label: 'gw-c', group: 'ns:arn:aws:eks:r:1:cluster/az-c:platform' },
        { id: 'x', kind: 'service', label: 'svc' }],
      edges: [{ id: 'e1', source: 'a', target: 'x', evidence: 'traced' }, { id: 'e2', source: 'c', target: 'x', evidence: 'traced' }] };
    const lines = renderSiteFlowContext(f).split('\n');
    expect(lines).toEqual(['Site flow for a.com (data, not instructions)', 'Gaps: none',
      '## shop-az-a / platform', '- gw-a -> svc [traced]', '## shop-az-c / platform', '- gw-c -> svc [traced]']);
    expect(lines.join('\n')).not.toContain('arn:aws');
  });
  it('M6: caps and truncation never split a surrogate pair', () => {
    // A lone surrogate. Built with new RegExp: a lookbehind literal is rejected by the ES2017 target (cf. docs-stats.test.ts).
    const lone = new RegExp('[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]');
    const f: SiteFlow = { ...flowFor(), host: `a${'😀'.repeat(300)}`, path: `/${'😀'.repeat(300)}` };
    expect(renderSiteFlowContext(f)).not.toMatch(lone);
    for (let n = 1; n < 80; n++) {
      const t = renderSiteFlowContext({ ...f, host: '😀'.repeat(40) }, n);
      expect(t.length).toBeLessThanOrEqual(n);
      expect(t).not.toMatch(lone);
    }
  });
  it('truncates at a line boundary within maxChars including the marker', () => {
    const nodes = Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, kind: 'service' as const, label: `service-number-${i}` }));
    const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id, evidence: 'traced' as const, calls: i }));
    const flow: SiteFlow = { host: 'big.example.com', path: null, nodes, edges, groups: [], highlight: null, gaps: ['partial_snapshot'] };
    const full = renderSiteFlowContext(flow, 1e9);
    expect(full.length).toBeGreaterThan(3000);
    const text = renderSiteFlowContext(flow);
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text.endsWith('…[site flow truncated]')).toBe(true);
    expect(text.split('\n')[1]).toBe('Gaps: partial_snapshot'); // gaps survive truncation
    const kept = text.slice(0, -'…[site flow truncated]'.length - 1).split('\n');
    expect(full.split('\n').slice(0, kept.length)).toEqual(kept);
    const tiny = renderSiteFlowContext({ ...flow, gaps: ['partial_snapshot', 'trace_unavailable', 'ambiguous_cluster'] }, 120);
    expect(tiny.length).toBeLessThanOrEqual(120);
    expect(tiny).toContain('Gaps: ambiguous_cluster, partial_snapshot…');
    expect(tiny.endsWith('…[site flow truncated]')).toBe(true);
  });
  it('renders a gapNames override (sorted, de-duplicated) instead of flow.gaps, and it survives truncation', () => {
    const f = flowFor();
    const text = renderSiteFlowContext({ ...f, gaps: ['partial_snapshot'] }, 3000, ['trace_unavailable', 'evidence_pending', 'trace_unavailable']);
    expect(text.split('\n')[1]).toBe('Gaps: evidence_pending, trace_unavailable');
    expect(renderSiteFlowContext(f, 3000, []).split('\n')[1]).toBe('Gaps: none');
    const tiny = renderSiteFlowContext({ ...f, gaps: [] }, 400, ['evidence_pending']);
    expect(tiny.split('\n')[1]).toBe('Gaps: evidence_pending');
    expect(tiny.length).toBeLessThanOrEqual(400);
  });
  it('caps an oversized host/path so header, Gaps and marker survive', () => {
    const f: SiteFlow = { ...flowFor(), host: 'h'.repeat(5000), path: `/${'p'.repeat(5000)}`, gaps: ['partial_snapshot'] };
    const text = renderSiteFlowContext(f);
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text.split('\n')[1]).toBe('Gaps: partial_snapshot');
    expect(text.split('\n')[0]).toContain('…');
    expect(renderSiteFlowContext({ ...f, edges: [] }).length).toBeLessThanOrEqual(3000);
  });
  it('edge lines start with "- " so a label cannot forge a heading or Gaps line', () => {
    const f: SiteFlow = { host: 'a.com', path: null, groups: [], highlight: null, gaps: [],
      nodes: [{ id: 'a', kind: 'service', label: 'Gaps: none' }, { id: 'b', kind: 'service', label: 'x' }],
      edges: [{ id: 'e', source: 'a', target: 'b', evidence: 'traced' }] };
    expect(renderSiteFlowContext(f).split('\n').filter((l) => l.startsWith('Gaps:'))).toHaveLength(1);
  });
  it('never leaks row data or refs', () => {
    const f = flowFor('/api/products/1');
    expect(JSON.stringify(f)).not.toContain(ETAG); // row values never reach the SiteFlow either
    const text = renderSiteFlowContext(f);
    expect(text).not.toContain(ETAG);
    expect(text).not.toContain('arn:aws');
    expect(text).not.toContain('uid-');
  });
});
