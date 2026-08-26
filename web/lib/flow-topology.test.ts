import { describe, it, expect } from 'vitest';
import { buildFlowGraph, filterFromEntry, TARGET_CAP } from './flow-topology';

// Fixtures in REAL Steampipe shape: flattened { resource_id, region, ...data } where nested
// jsonb columns keep AWS SDK PascalCase keys. alb/nlb resource_id = name; tg resource_id = arn.
const ALB_ARN = 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/web/abc';
const TG_ARN = 'arn:aws:elasticloadbalancing:ap-northeast-2:1:targetgroup/web-tg/def';
const WAF_ARN = 'arn:aws:wafv2:us-east-1:1:global/webacl/prod/xyz';
const ALB_ID = `alb:${ALB_ARN}`;

const alb = { resource_id: 'web', region: 'ap-northeast-2', arn: ALB_ARN, dns_name: 'internal-web-123.ap-northeast-2.elb.amazonaws.com', vpc_id: 'vpc-1' };
const waf = { resource_id: 'prod', region: 'us-east-1', arn: WAF_ARN };
const tg = {
  resource_id: TG_ARN, region: 'ap-northeast-2', target_group_name: 'web-tg', target_type: 'ip',
  load_balancer_arns: [ALB_ARN],
  target_health_descriptions: [
    { Target: { Id: '10.0.1.5', Port: 3000 }, TargetHealth: { State: 'healthy' } },
    { Target: { Id: '10.0.1.6', Port: 3000 }, TargetHealth: { State: 'unhealthy' } },
  ],
};

describe('buildFlowGraph — L7 routing labels (ALB rules + API GW routes)', () => {
  const albTg = { resource_id: TG_ARN, target_group_name: 'web-tg', target_type: 'ip', load_balancer_arns: [ALB_ARN], target_health_descriptions: [] };
  const FE_TG = 'arn:aws:elasticloadbalancing:ap-northeast-2:1:targetgroup/fe/xyz';
  const feTg = { resource_id: FE_TG, target_group_name: 'fe-tg', target_type: 'ip', load_balancer_arns: [ALB_ARN], target_health_descriptions: [] };

  it('labels the ALB→TG edge with the listener rule path + port (forward action)', () => {
    const rules = [
      { resource_id: 'r1', load_balancer_arn: ALB_ARN, port: 443, conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }], actions: [{ Type: 'forward', TargetGroupArn: TG_ARN }] },
      { resource_id: 'r2', load_balancer_arn: ALB_ARN, port: 443, is_default: true, conditions: [], actions: [{ Type: 'forward', TargetGroupArn: FE_TG }] },
    ];
    const g = buildFlowGraph({ alb: [alb], tg: [albTg, feTg], alb_listener_rule: rules });
    const apiEdge = g.edges.find((e) => e.source === ALB_ID && e.target === `tg:${TG_ARN}`);
    expect(apiEdge?.label).toContain('/api/*');
    expect(apiEdge?.label).toContain(':443');
    const feEdge = g.edges.find((e) => e.source === ALB_ID && e.target === `tg:${FE_TG}`);
    expect(feEdge?.label).toContain('default'); // empty-conditions forward default → 'default :443'
  });

  it('labels with the host-header for host-routed ALBs', () => {
    const rules = [{ resource_id: 'r1', load_balancer_arn: ALB_ARN, port: 443, conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['atlantis.example.com'] } }], actions: [{ Type: 'forward', TargetGroupArn: TG_ARN }] }];
    const g = buildFlowGraph({ alb: [alb], tg: [albTg], alb_listener_rule: rules });
    expect(g.edges.find((e) => e.target === `tg:${TG_ARN}`)?.label).toContain('atlantis.example.com');
  });

  it('does NOT label when the default rule is a fixed-response (no forward target)', () => {
    const rules = [{ resource_id: 'r1', load_balancer_arn: ALB_ARN, port: 443, is_default: true, conditions: [], actions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '503' } }] }];
    const g = buildFlowGraph({ alb: [alb], tg: [albTg], alb_listener_rule: rules });
    // the LB→TG edge exists via load_balancer_arns but carries NO label (no TG in the rule's actions)
    const e = g.edges.find((x) => x.source === ALB_ID && x.target === `tg:${TG_ARN}`);
    expect(e).toBeTruthy();
    expect(e?.label).toBeUndefined();
  });

  it('labels the API GW→Lambda edge with the route_key (path)', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'z6ktgdg69k.execute-api.ap-northeast-2.amazonaws.com' }] };
    const apigw = { resource_id: 'z6ktgdg69k', name: 'ttobak-api', api_endpoint: 'https://z6ktgdg69k.execute-api.ap-northeast-2.amazonaws.com', protocol_type: 'HTTP' };
    const integrations = [{ resource_id: 'i1', api_id: 'z6ktgdg69k', integration_type: 'AWS_PROXY', connection_type: 'INTERNET', integration_uri: 'arn:aws:lambda:ap-northeast-2:1:function:ttobak-api' }];
    const lambda = [{ resource_id: 'ttobak-api', arn: 'arn:aws:lambda:ap-northeast-2:1:function:ttobak-api' }];
    const routes = [{ resource_id: 'rt1', api_id: 'z6ktgdg69k', route_key: 'ANY /api/{proxy+}', target: 'integrations/i1' }];
    const g = buildFlowGraph({ cloudfront: [cf], apigatewayv2_api: [apigw], apigatewayv2_integration: integrations, lambda, apigatewayv2_route: routes });
    const e = g.edges.find((x) => x.source === 'apigw:z6ktgdg69k' && x.target === 'lambda:arn:aws:lambda:ap-northeast-2:1:function:ttobak-api');
    expect(e?.label).toBe('ANY /api/{proxy+}');
  });
});

describe('buildFlowGraph — API Gateway origins (CF→APIGW→Lambda/LB)', () => {
  const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'z6ktgdg69k.execute-api.ap-northeast-2.amazonaws.com' }] };
  const apigw = { resource_id: 'z6ktgdg69k', region: 'ap-northeast-2', name: 'ttobak-api', api_endpoint: 'https://z6ktgdg69k.execute-api.ap-northeast-2.amazonaws.com', protocol_type: 'HTTP' };

  it('resolves an execute-api origin → apigw node and follows AWS_PROXY integrations to Lambda (qualifier stripped)', () => {
    const integrations = [
      { resource_id: 'i1', api_id: 'z6ktgdg69k', integration_type: 'AWS_PROXY', connection_type: 'INTERNET', integration_uri: 'arn:aws:lambda:ap-northeast-2:1:function:ttobak-api:live' },
      { resource_id: 'i2', api_id: 'z6ktgdg69k', integration_type: 'AWS_PROXY', connection_type: 'INTERNET', integration_uri: 'arn:aws:lambda:ap-northeast-2:1:function:ttobak-qa' },
    ];
    const lambda = [
      { resource_id: 'ttobak-api', region: 'ap-northeast-2', arn: 'arn:aws:lambda:ap-northeast-2:1:function:ttobak-api' },
      { resource_id: 'ttobak-qa', region: 'ap-northeast-2', arn: 'arn:aws:lambda:ap-northeast-2:1:function:ttobak-qa' },
    ];
    const g = buildFlowGraph({ cloudfront: [cf], apigatewayv2_api: [apigw], apigatewayv2_integration: integrations, lambda });
    expect(g.edges.find((e) => e.source === 'cf:D1' && e.target === 'apigw:z6ktgdg69k')).toBeTruthy();
    // :live qualifier normalized → matches the unversioned synced lambda arn
    expect(g.edges.find((e) => e.source === 'apigw:z6ktgdg69k' && e.target === 'lambda:arn:aws:lambda:ap-northeast-2:1:function:ttobak-api')).toBeTruthy();
    expect(g.edges.find((e) => e.target === 'lambda:arn:aws:lambda:ap-northeast-2:1:function:ttobak-qa')).toBeTruthy();
    // no LB edge for an INTERNET (Lambda) integration
    expect(g.edges.find((e) => e.target.startsWith('alb:') || e.target.startsWith('nlb:'))).toBeUndefined();
  });

  it('a VPC_LINK integration whose uri is a listener ARN → apigw→ALB edge (listener→LB derivation)', () => {
    const listenerArn = `${ALB_ARN.replace(':loadbalancer/', ':listener/')}/9f8e7d`;
    const integrations = [{ resource_id: 'i1', api_id: 'z6ktgdg69k', integration_type: 'HTTP_PROXY', connection_type: 'VPC_LINK', connection_id: 'vl1', integration_uri: listenerArn }];
    const g = buildFlowGraph({ cloudfront: [cf], apigatewayv2_api: [apigw], apigatewayv2_integration: integrations, alb: [alb] });
    expect(g.edges.find((e) => e.source === 'apigw:z6ktgdg69k' && e.target === ALB_ID)).toBeTruthy();
  });

  it('execute-api origin with no synced api row → falls through to an unresolved origin node (no false apigw edge)', () => {
    const g = buildFlowGraph({ cloudfront: [cf] }); // no apigatewayv2_api
    expect(g.edges.find((e) => e.target.startsWith('apigw:'))).toBeUndefined();
    expect(g.nodes.find((n) => n.kind === 'origin')).toBeTruthy();
  });
});

describe('buildFlowGraph — CloudFront VPC origins (CF→internal ALB/NLB)', () => {
  it('resolves a Deployed VPC origin to its backing LB by (distribution,domain) (no unresolved node)', () => {
    const cf = { resource_id: 'E2', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'awsops-v2.example.com' }] };
    const vo = [{ resource_id: 'vo_6O65', region: 'global', status: 'Deployed', arn: ALB_ARN, origin_refs: [{ distribution_id: 'E2', domain: 'awsops-v2.example.com' }] }];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], cloudfront_vpc_origin: vo });
    expect(g.edges.find((e) => e.source === 'cf:E2' && e.target === ALB_ID)).toBeTruthy();
    expect(g.nodes.find((n) => n.kind === 'origin')).toBeUndefined();
  });

  it('does NOT mislink a co-resident external origin on a VPC-origin distribution', () => {
    const cf = { resource_id: 'E2', region: 'us-east-1', origins: [
      { Id: 'o1', DomainName: 'awsops-v2.example.com' },   // the VPC origin → ALB
      { Id: 'o2', DomainName: 'cdn.partner.com' },           // an external custom origin → must NOT link to the LB
    ] };
    const vo = [{ resource_id: 'vo_6O65', region: 'global', status: 'Deployed', arn: ALB_ARN, origin_refs: [{ distribution_id: 'E2', domain: 'awsops-v2.example.com' }] }];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], cloudfront_vpc_origin: vo });
    expect(g.edges.find((e) => e.source === 'cf:E2' && e.target === ALB_ID)).toBeTruthy();           // VPC origin linked
    expect(g.nodes.find((n) => n.kind === 'origin' && String(n.label).includes('cdn.partner.com'))).toBeTruthy(); // external = unresolved node, no false edge
  });

  it('a Failed VPC origin is NOT resolved — falls through to the honest unresolved origin node', () => {
    const cf = { resource_id: 'E2', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'awsops-v2.example.com' }] };
    const vo = [{ resource_id: 'vo_bad', region: 'global', status: 'Failed', arn: ALB_ARN, origin_refs: [{ distribution_id: 'E2', domain: 'awsops-v2.example.com' }] }];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], cloudfront_vpc_origin: vo });
    expect(g.edges.find((e) => e.source === 'cf:E2' && e.target === ALB_ID)).toBeUndefined();
    expect(g.nodes.find((n) => n.kind === 'origin')).toBeTruthy();
  });
});

describe('buildFlowGraph — CF→LB/WAF edges', () => {
  it('links CF→ALB when an origin DomainName matches alb.dns_name (case-insensitive)', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'INTERNAL-WEB-123.AP-NORTHEAST-2.ELB.AMAZONAWS.COM' }] };
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb] });
    expect(g.nodes.find((n) => n.id === 'cf:D1')).toBeTruthy();
    expect(g.nodes.find((n) => n.id === ALB_ID)).toBeTruthy();
    const e = g.edges.find((x) => x.source === 'cf:D1' && x.target === ALB_ID);
    expect(e).toBeTruthy();
    expect(e!.confidence).toBe('observed');
  });

  it('links CF→WAF by web_acl_id matched against waf.arn', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', web_acl_id: WAF_ARN, origins: [] };
    const g = buildFlowGraph({ cloudfront: [cf], waf: [waf] });
    expect(g.edges.find((x) => x.source === 'cf:D1' && x.target === 'waf:prod')).toBeTruthy();
  });

  it('labels the CF node with its custom domain (aliases) when present', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', domain_name: 'd1.cloudfront.net', aliases: { Items: ['app.example.com'] }, origins: [] };
    const g = buildFlowGraph({ cloudfront: [cf] });
    expect(g.nodes.find((n) => n.id === 'cf:D1')?.label).toBe('app.example.com');
  });

  it('resolves an S3 origin to the REAL synced bucket row (invType=s3 + row.arn from inventory)', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'my-site-123456789012.s3.ap-northeast-2.amazonaws.com' }] };
    const s3 = [{ resource_type: 's3', resource_id: 'my-site-123456789012', region: 'ap-northeast-2', arn: 'arn:aws:s3:::my-site-123456789012', creation_date: '2024-01-01' }];
    const g = buildFlowGraph({ cloudfront: [cf], s3 });
    const o = g.nodes.find((n) => n.kind === 'origin');
    expect(o?.label).toBe('my-site-123456789012');
    expect(o?.meta?.service).toBe('s3');
    expect(o?.meta?.invType).toBe('s3');
    expect((o?.meta?.row as { arn?: string })?.arn).toBe('arn:aws:s3:::my-site-123456789012');
    expect(o?.meta?.unresolved).toBeUndefined();
  });

  it('synthesizes a valid S3 ARN when the bucket is not in synced inventory (graceful fallback)', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'unsynced-bucket.s3.amazonaws.com' }] };
    const g = buildFlowGraph({ cloudfront: [cf] }); // no s3 input
    const o = g.nodes.find((n) => n.kind === 'origin');
    expect(o?.meta?.invType).toBe('s3');
    // partition-only S3 ARN form — no region/account segments
    expect((o?.meta?.row as { arn?: string })?.arn).toBe('arn:aws:s3:::unsynced-bucket');
    expect(o?.meta?.unresolved).toBeUndefined();
  });

  it('keeps a non-S3 unmatched origin as an unresolved origin node', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'example.com' }] };
    const g = buildFlowGraph({ cloudfront: [cf] });
    const o = g.nodes.find((n) => n.kind === 'origin');
    expect(o?.meta?.unresolved).toBe(true);
    expect(o?.meta?.service).toBeUndefined();
  });
});

describe('buildFlowGraph — custom-domain origin resolved via Route53 alias', () => {
  // A: a CloudFront custom-domain origin that Route53-aliases to a SYNCED, internet-facing LB →
  // real CF→LB edge. (A standard CF custom origin reaches the origin over the public internet, so
  // the edge is only drawn when the LB is internet-facing — see the internal-scheme test below.)
  it('links CF→LB when the origin custom domain Route53-aliases to a synced internet-facing LB', () => {
    const cf = { resource_id: 'D1', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'svc.example.com' }] };
    const alb = { resource_id: 'web-alb', region: 'ap-northeast-2', scheme: 'internet-facing', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/web-alb/1', dns_name: 'web-123.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [{ resource_id: 'svc.example.com A', name: 'svc.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'web-123.ap-northeast-2.elb.amazonaws.com.' } }];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: r53 });
    expect(g.edges.some((e) => e.source === 'cf:D1' && e.target === `alb:${alb.arn}`)).toBe(true);
    // resolved to a real LB → no leftover unresolved origin node for svc.example.com
    expect(g.nodes.find((n) => n.kind === 'origin' && String(n.label).includes('svc.example.com'))).toBeFalsy();
  });

  // PUBLIC-only: a record that exists ONLY in a PRIVATE hosted zone must NOT back a CF→LB edge
  // (a standard custom origin resolves over public DNS) — no false edge.
  it('does NOT resolve a private-zone record to a CF→LB edge', () => {
    const cf = { resource_id: 'D1', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'svc.example.com' }] };
    const alb = { resource_id: 'a', region: 'ap-northeast-2', scheme: 'internet-facing', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/a/1', dns_name: 'priv-lb.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [{ resource_id: 'svc.example.com A', name: 'svc.example.com.', type: 'A', private_zone: true, alias_target: { DNSName: 'priv-lb.ap-northeast-2.elb.amazonaws.com.' } }];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: r53 });
    expect(g.edges.some((e) => e.source === 'cf:D1' && e.target === `alb:${alb.arn}`)).toBe(false);
    // not resolvable (private) → plain unresolved, no resolvedTarget surfaced
    expect(g.nodes.find((n) => n.kind === 'origin')?.meta?.resolvedTarget).toBeUndefined();
  });

  // VPC origin guard: a KNOWN VPC origin whose backing LB isn't synced must NOT fall through to the
  // public Route53 path (a VPC origin isn't reached via public DNS) — no misleading public edge.
  it('does NOT draw a public Route53 edge for a known VPC origin whose backing LB is unsynced', () => {
    const cf = { resource_id: 'E2', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'svc.example.com' }] };
    const vo = [{ resource_id: 'vo1', status: 'Deployed', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/missing/1', origin_refs: [{ distribution_id: 'E2', domain: 'svc.example.com' }] }];
    const alb = { resource_id: 'pub', region: 'ap-northeast-2', scheme: 'internet-facing', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/pub/1', dns_name: 'pub.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [{ resource_id: 'svc.example.com A', name: 'svc.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'pub.ap-northeast-2.elb.amazonaws.com.' } }];
    const g = buildFlowGraph({ cloudfront: [cf], cloudfront_vpc_origin: vo, alb: [alb], route53: r53 });
    expect(g.edges.some((e) => e.source === 'cf:E2' && e.target === `alb:${alb.arn}`)).toBe(false);
  });

  // VpcOriginConfig path: a VPC origin detected only by the origin's VpcOriginConfig (no matched
  // cloudfront_vpc_origin row) must also be excluded from public Route53 resolution.
  it('does NOT draw a public Route53 edge for a VpcOriginConfig origin (no voArns)', () => {
    const cf = { resource_id: 'E3', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'svc.example.com', VpcOriginConfig: { VpcOriginId: 'vo-x' } }] };
    const alb = { resource_id: 'pub', region: 'ap-northeast-2', scheme: 'internet-facing', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/pub/1', dns_name: 'pub.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [{ resource_id: 'svc.example.com A', name: 'svc.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'pub.ap-northeast-2.elb.amazonaws.com.' } }];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: r53 }); // no cloudfront_vpc_origin
    expect(g.edges.some((e) => e.source === 'cf:E3' && e.target === `alb:${alb.arn}`)).toBe(false);
  });

  // all-status detection: a NON-Deployed VPC origin (excluded from edge-linking) with no
  // VpcOriginConfig must still be detected as a VPC origin → excluded from public Route53 resolution.
  it('does NOT draw a public Route53 edge for a non-Deployed VPC origin (detected via origin_refs)', () => {
    const cf = { resource_id: 'E4', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'svc.example.com' }] };
    const vo = [{ resource_id: 'vo1', status: 'Deploying', origin_refs: [{ distribution_id: 'E4', domain: 'svc.example.com' }] }];
    const alb = { resource_id: 'pub', region: 'ap-northeast-2', scheme: 'internet-facing', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/pub/1', dns_name: 'pub.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [{ resource_id: 'svc.example.com A', name: 'svc.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'pub.ap-northeast-2.elb.amazonaws.com.' } }];
    const g = buildFlowGraph({ cloudfront: [cf], cloudfront_vpc_origin: vo, alb: [alb], route53: r53 });
    expect(g.edges.some((e) => e.source === 'cf:E4' && e.target === `alb:${alb.arn}`)).toBe(false);
  });

  // UNKNOWN visibility (no private_zone field, e.g. pre-resync data) → conservative: no edge.
  it('does NOT resolve a record with unknown visibility (no private_zone field)', () => {
    const cf = { resource_id: 'D1', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'svc.example.com' }] };
    const alb = { resource_id: 'a', region: 'ap-northeast-2', scheme: 'internet-facing', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/a/1', dns_name: 'lb-u.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [{ resource_id: 'svc.example.com A', name: 'svc.example.com.', type: 'A', alias_target: { DNSName: 'lb-u.ap-northeast-2.elb.amazonaws.com.' } }];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: r53 });
    expect(g.edges.some((e) => e.source === 'cf:D1' && e.target === `alb:${alb.arn}`)).toBe(false);
  });

  // chain: origin → r53 record → another r53 record → internet-facing LB (2 hops).
  it('follows a Route53 alias chain (2 hops) to a synced internet-facing LB', () => {
    const cf = { resource_id: 'D1', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'edge.example.com' }] };
    const alb = { resource_id: 'a', region: 'ap-northeast-2', scheme: 'internet-facing', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/a/1', dns_name: 'lb-1.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [
      { resource_id: 'edge.example.com A', name: 'edge.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'svc.example.com.' } },
      { resource_id: 'svc.example.com A', name: 'svc.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'lb-1.ap-northeast-2.elb.amazonaws.com.' } },
    ];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: r53 });
    expect(g.edges.some((e) => e.source === 'cf:D1' && e.target === `alb:${alb.arn}`)).toBe(true);
  });

  // reachability: a standard CF custom origin CANNOT reach an INTERNAL LB → no false edge; surface
  // the resolved target on an unresolved node instead.
  it('does NOT draw a CF→LB edge to an internal-scheme LB (unreachable) — surfaces it instead', () => {
    const cf = { resource_id: 'D1', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'svc.example.com' }] };
    const alb = { resource_id: 'int-alb', region: 'ap-northeast-2', scheme: 'internal', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/int-alb/1', dns_name: 'internal-x.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [{ resource_id: 'svc.example.com A', name: 'svc.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'internal-x.ap-northeast-2.elb.amazonaws.com.' } }];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: r53 });
    expect(g.edges.some((e) => e.source === 'cf:D1' && e.target === `alb:${alb.arn}`)).toBe(false);
    const o = g.nodes.find((n) => n.kind === 'origin' && String(n.label).includes('svc.example.com'));
    expect(o?.meta?.resolvedTarget).toBe('internal-x.ap-northeast-2.elb.amazonaws.com');
  });

  // determinism: a record name with CONFLICTING alias targets (e.g. split-horizon public/private)
  // is ambiguous → not resolved (no order-dependent edge). Must be deterministic regardless of input order.
  it('does not resolve a record name with conflicting alias targets (deterministic)', () => {
    const cf = { resource_id: 'D1', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'svc.example.com' }] };
    const alb = { resource_id: 'a', region: 'ap-northeast-2', scheme: 'internet-facing', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/a/1', dns_name: 'lb-1.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [
      { resource_id: 'svc A pub', name: 'svc.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'lb-1.ap-northeast-2.elb.amazonaws.com.' } },
      { resource_id: 'svc A priv', name: 'svc.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'other-lb.ap-northeast-2.elb.amazonaws.com.' } },
    ];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: r53 });
    expect(g.edges.some((e) => e.source === 'cf:D1' && e.target === `alb:${alb.arn}`)).toBe(false); // ambiguous → no edge
  });

  // dualstack: an ELB ALIAS target carries a `dualstack.` prefix that the bare LB dns_name lacks —
  // must be stripped so the synced LB still matches (otherwise the LB is missed → unresolved).
  it('matches a synced LB when the Route53 alias target has a dualstack. prefix', () => {
    const cf = { resource_id: 'D1', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'svc.example.com' }] };
    const alb = { resource_id: 'a', region: 'ap-northeast-2', scheme: 'internet-facing', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/a/1', dns_name: 'demo3-1097511911.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [{ resource_id: 'svc.example.com A', name: 'svc.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'dualstack.demo3-1097511911.ap-northeast-2.elb.amazonaws.com.' } }];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: r53 });
    expect(g.edges.some((e) => e.source === 'cf:D1' && e.target === `alb:${alb.arn}`)).toBe(true);
  });

  // CNAME: a record with no alias_target carries its target in `records` — follow it too.
  it('resolves a CNAME record (records[]) to a synced internet-facing LB', () => {
    const cf = { resource_id: 'D1', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'svc.example.com' }] };
    const alb = { resource_id: 'a', region: 'ap-northeast-2', scheme: 'internet-facing', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/a/1', dns_name: 'cn-lb.ap-northeast-2.elb.amazonaws.com' };
    const r53 = [{ resource_id: 'svc.example.com CNAME', name: 'svc.example.com.', type: 'CNAME', private_zone: false, records: ['cn-lb.ap-northeast-2.elb.amazonaws.com'] }];
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb], route53: r53 });
    expect(g.edges.some((e) => e.source === 'cf:D1' && e.target === `alb:${alb.arn}`)).toBe(true);
  });

  // C: a CloudFront custom-domain origin whose Route53 alias points at a NON-synced (e.g. cross-region)
  // ELB → honest unresolved origin node, but its label/meta surfaces the resolved target.
  it('surfaces the resolved target on an unresolved node when the alias points to a non-synced ELB (cross-region)', () => {
    const cf = { resource_id: 'D2', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'grafana-internal.example.com' }] };
    const r53 = [{ resource_id: 'grafana-internal.example.com A', name: 'grafana-internal.example.com.', type: 'A', private_zone: false, alias_target: { DNSName: 'k8s-monitori-grafanan-xyz.elb.us-east-1.amazonaws.com.' } }];
    const g = buildFlowGraph({ cloudfront: [cf], route53: r53 }); // the target LB is NOT synced
    const o = g.nodes.find((n) => n.kind === 'origin' && String(n.label).includes('grafana-internal.example.com'));
    expect(o).toBeTruthy();
    expect(o!.meta?.unresolved).toBe(true);
    expect(o!.meta?.resolvedTarget).toBe('k8s-monitori-grafanan-xyz.elb.us-east-1.amazonaws.com');
    expect(String(o!.label)).toContain('k8s-monitori-grafanan-xyz.elb.us-east-1.amazonaws.com'); // "→ target" surfaced
  });

  // a custom origin with NO Route53 record stays a plain unresolved node (no resolvedTarget).
  it('leaves a custom origin with no Route53 record as a plain unresolved node', () => {
    const cf = { resource_id: 'D3', region: 'ap-northeast-2', origins: [{ Id: 'o1', DomainName: 'cdn.partner.com' }] };
    const g = buildFlowGraph({ cloudfront: [cf], route53: [] });
    const o = g.nodes.find((n) => n.kind === 'origin' && String(n.label).includes('cdn.partner.com'));
    expect(o?.meta?.unresolved).toBe(true);
    expect(o?.meta?.resolvedTarget).toBeUndefined();
  });
});

describe('buildFlowGraph — Route53 entry', () => {
  const cf = { resource_id: 'D1', region: 'us-east-1', domain_name: 'd111.cloudfront.net', aliases: { Items: ['app.example.com'] }, origins: [] };

  it('links Route53 ALIAS record → CloudFront when alias_target matches the CF domain', () => {
    const rec = { resource_id: 'app.example.com A', name: 'app.example.com.', type: 'A', alias_target: { DNSName: 'd111.cloudfront.net.' } };
    const g = buildFlowGraph({ route53: [rec], cloudfront: [cf] });
    const r53 = g.nodes.find((n) => n.kind === 'route53');
    expect(r53).toBeTruthy();
    expect(g.edges.find((x) => x.source === r53!.id && x.target === 'cf:D1')).toBeTruthy();
  });

  it('links Route53 → ALB when alias_target matches the LB dns_name', () => {
    const rec = { resource_id: 'direct.example.com A', name: 'direct.example.com.', type: 'A', alias_target: { DNSName: `${alb.dns_name}.` } };
    const g = buildFlowGraph({ route53: [rec], alb: [alb] });
    expect(g.edges.find((x) => x.source.startsWith('r53:') && x.target === ALB_ID)).toBeTruthy();
  });

  it('skips Route53 records that resolve to nothing tracked (no orphan DNS clutter)', () => {
    const rec = { resource_id: 'ext.example.com CNAME', name: 'ext.example.com.', type: 'CNAME', alias_target: { DNSName: 'somewhere-external.example.org.' } };
    const g = buildFlowGraph({ route53: [rec], cloudfront: [cf] });
    expect(g.nodes.find((n) => n.kind === 'route53')).toBeFalsy();
  });

  it('VPC-origin distribution (public FQDN + VpcOriginConfig) → unresolved origin node, no false LB edge', () => {
    const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'awsops-v2.example.com', VpcOriginConfig: { VpcOriginId: 'vo_abc' } }] };
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb] });
    // no false CF→ALB edge (DomainName is the public FQDN, not the ALB dns_name)
    expect(g.edges.find((x) => x.target === ALB_ID)).toBeFalsy();
    // an explicit unresolved-origin node exists, linked from CF
    const origin = g.nodes.find((n) => n.kind === 'origin');
    expect(origin).toBeTruthy();
    expect(g.edges.find((x) => x.source === 'cf:D1' && x.target === origin!.id)).toBeTruthy();
  });

  it('plain origin matching nothing → unresolved origin node (no throw, no false edge)', () => {
    // a true non-S3, non-LB custom origin (an *.s3*.amazonaws.com domain would resolve to a bucket)
    const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: 'cdn.example.com' }] };
    const g = buildFlowGraph({ cloudfront: [cf], alb: [alb] });
    expect(g.nodes.find((n) => n.kind === 'origin')).toBeTruthy();
    expect(g.edges.find((x) => x.target === ALB_ID)).toBeFalsy();
  });
});

describe('buildFlowGraph — ALB→TG→target', () => {
  it('links ALB→TG via load_balancer_arns (matched by arn, not node name)', () => {
    const g = buildFlowGraph({ alb: [alb], tg: [tg] });
    expect(g.edges.find((x) => x.source === ALB_ID && x.target === `tg:${TG_ARN}`)).toBeTruthy();
  });

  it('GROUPS a TG\'s unresolved ip targets into one node (member IPs listed + aggregate health)', () => {
    const g = buildFlowGraph({ tg: [tg] });
    const targets = g.nodes.filter((n) => n.kind === 'target');
    expect(targets.length).toBe(1); // 2 IPs of one TG → one grouped node (only the IP differs)
    expect(targets[0].meta?.count).toBe(2);
    expect(targets[0].meta?.health).toBe('unhealthy'); // any-unhealthy → unhealthy aggregate
    expect(targets[0].meta?.members).toEqual(['10.0.1.5:3000', '10.0.1.6:3000']);
    expect(g.edges.filter((x) => x.source === `tg:${TG_ARN}` && x.target.startsWith('target:')).length).toBe(1);
  });

  it('TG with empty/garbage targets still yields a node and never throws', () => {
    const empty = { resource_id: 'arn:tg:empty', target_group_name: 'empty', load_balancer_arns: [], target_health_descriptions: [] };
    const garbage = { resource_id: 'arn:tg:bad', target_group_name: 'bad', target_health_descriptions: 'not-an-array' };
    const g = buildFlowGraph({ tg: [empty, garbage] });
    expect(g.nodes.find((n) => n.id === 'tg:arn:tg:empty')).toBeTruthy();
    expect(g.nodes.find((n) => n.id === 'tg:arn:tg:bad')).toBeTruthy();
  });

  it('collapses 100s of unresolved targets into ONE grouped node (member list display-capped, count accurate)', () => {
    const n = TARGET_CAP + 5;
    const many = {
      resource_id: 'arn:tg:big', target_group_name: 'big', target_type: 'ip',
      target_health_descriptions: Array.from({ length: n }, (_, i) => ({ Target: { Id: `10.0.0.${i}` }, TargetHealth: { State: 'healthy' } })),
    };
    const g = buildFlowGraph({ tg: [many] });
    const targets = g.nodes.filter((x) => x.kind === 'target' && x.id.startsWith('target:arn:tg:big'));
    expect(targets.length).toBe(1); // one grouped node, not N (no per-IP blow-up at 100s of replicas)
    expect(targets[0].meta?.count).toBe(n);
    expect((targets[0].meta?.members as string[]).length).toBe(TARGET_CAP); // member list display-capped
    expect(targets[0].meta?.membersTruncated).toBe(5);
    expect(targets[0].meta?.health).toBe('healthy');
    expect(g.nodes.find((x) => x.kind === 'more')).toBeUndefined(); // grouping supersedes the +N more node
  });

  it('resolved replicas (same EKS workload) collapse into one node with the member IPs', () => {
    const tgEks = {
      resource_id: 'arn:tg:eks', target_group_name: 'eks-tg', target_type: 'ip',
      target_health_descriptions: [
        { Target: { Id: '10.2.1.1', Port: 8080 }, TargetHealth: { State: 'healthy' } },
        { Target: { Id: '10.2.1.2', Port: 8080 }, TargetHealth: { State: 'healthy' } },
        { Target: { Id: '10.2.1.3', Port: 8080 }, TargetHealth: { State: 'healthy' } },
      ],
    };
    const ipResolved = {
      '10.2.1.1': { label: 'app/api', resolved: 'eks' as const, meta: { service: 'api', namespace: 'app' } },
      '10.2.1.2': { label: 'app/api', resolved: 'eks' as const, meta: { service: 'api', namespace: 'app' } },
      '10.2.1.3': { label: 'app/api', resolved: 'eks' as const, meta: { service: 'api', namespace: 'app' } },
    };
    const g = buildFlowGraph({ tg: [tgEks], ipResolved });
    const targets = g.nodes.filter((x) => x.kind === 'target' && x.id.startsWith('target:arn:tg:eks'));
    expect(targets.length).toBe(1);
    expect(targets[0].label).toBe('app/api ×3');
    expect(targets[0].meta?.resolved).toBe('eks');
    expect(targets[0].meta?.members).toEqual(['10.2.1.1:8080', '10.2.1.2:8080', '10.2.1.3:8080']);
  });
});

describe('buildFlowGraph — backend resolution (instance/lambda)', () => {
  it('resolves an instance target to its EC2 Name', () => {
    const tgInst = { resource_id: 'arn:tg:inst', target_group_name: 'inst', target_type: 'instance',
      target_health_descriptions: [{ Target: { Id: 'i-0abc' }, TargetHealth: { State: 'healthy' } }] };
    const ec2 = { resource_id: 'i-0abc', name: 'web-server-1' };
    const g = buildFlowGraph({ tg: [tgInst], ec2: [ec2] });
    expect(g.nodes.find((n) => n.kind === 'target')?.label).toBe('web-server-1');
    expect(g.nodes.find((n) => n.kind === 'target')?.meta?.resolved).toBe('ec2');
  });

  it('resolves a lambda target to its function name', () => {
    const FN_ARN = 'arn:aws:lambda:ap-northeast-2:1:function:my-fn';
    const tgFn = { resource_id: 'arn:tg:fn', target_group_name: 'fn', target_type: 'lambda',
      target_health_descriptions: [{ Target: { Id: FN_ARN }, TargetHealth: { State: 'healthy' } }] };
    const lam = { resource_id: 'my-fn', arn: FN_ARN };
    const g = buildFlowGraph({ tg: [tgFn], lambda: [lam] });
    expect(g.nodes.find((n) => n.kind === 'target')?.label).toBe('my-fn');
  });

  it('leaves an ip target raw when unresolved', () => {
    const tgIp = { resource_id: 'arn:tg:ip', target_group_name: 'ip', target_type: 'ip',
      target_health_descriptions: [{ Target: { Id: '10.0.1.9' }, TargetHealth: { State: 'healthy' } }] };
    const g = buildFlowGraph({ tg: [tgIp] });
    expect(g.nodes.find((n) => n.kind === 'target')?.label).toBe('10.0.1.9');
  });

  it('resolves an ip target to an ECS service via synced ecsTask (attachments PascalCase)', () => {
    const tgIp = { resource_id: 'arn:tg:ip', target_group_name: 'ip', target_type: 'ip',
      target_health_descriptions: [{ Target: { Id: '10.20.11.244' }, TargetHealth: { State: 'healthy' } }] };
    const task = { resource_id: 'arn:aws:ecs:ap-northeast-2:1:task/cl/abc', cluster_arn: 'arn:aws:ecs:ap-northeast-2:1:cluster/prod', task_group: 'service:ai-trader-api',
      attachments: [{ Type: 'ElasticNetworkInterface', Details: [{ Name: 'privateIPv4Address', Value: '10.20.11.244' }] }] };
    const g = buildFlowGraph({ tg: [tgIp], ecsTask: [task] });
    const t = g.nodes.find((n) => n.kind === 'target');
    expect(t?.label).toBe('ai-trader-api');
    expect(t?.meta?.resolved).toBe('ecs');
  });

  it('resolves an ip target to an EKS workload via ipResolved', () => {
    const tgIp = { resource_id: 'arn:tg:ip', target_group_name: 'ip', target_type: 'ip',
      target_health_descriptions: [{ Target: { Id: '10.0.1.9' }, TargetHealth: { State: 'healthy' } }] };
    const g = buildFlowGraph({ tg: [tgIp], ipResolved: { '10.0.1.9': { label: 'prod/checkout', resolved: 'eks', meta: { pod: 'checkout-abc', cluster: 'fsi' } } } });
    const t = g.nodes.find((n) => n.kind === 'target');
    expect(t?.label).toBe('prod/checkout');
    expect(t?.meta?.resolved).toBe('eks');
    expect(t?.meta?.pod).toBe('checkout-abc');
  });
});

describe('buildFlowGraph — invariants', () => {
  it('same-named LBs in different regions stay distinct (ARN-keyed node id)', () => {
    const albA = { resource_id: 'web', region: 'ap-northeast-2', arn: ALB_ARN, dns_name: 'a.elb.amazonaws.com' };
    const albB = { resource_id: 'web', region: 'us-east-1', arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/web/zzz', dns_name: 'b.elb.amazonaws.com' };
    const g = buildFlowGraph({ alb: [albA, albB] });
    expect(g.nodes.filter((n) => n.kind === 'alb').length).toBe(2);
  });

  it('no dangling edges; node dedup', () => {
    const g = buildFlowGraph({ alb: [alb, alb], tg: [tg] });
    expect(g.nodes.filter((n) => n.id === ALB_ID).length).toBe(1);
    for (const e of g.edges) {
      expect(g.nodes.find((n) => n.id === e.source), e.source).toBeTruthy();
      expect(g.nodes.find((n) => n.id === e.target), e.target).toBeTruthy();
    }
  });
});

describe('filterFromEntry', () => {
  const cf = { resource_id: 'D1', region: 'us-east-1', origins: [{ Id: 'o1', DomainName: alb.dns_name }] };
  const full = buildFlowGraph({ cloudfront: [cf], alb: [alb], tg: [tg] });

  it('returns the reachable subtree from an entry node', () => {
    const sub = filterFromEntry(full, 'cf:D1');
    expect(sub.nodes.find((n) => n.id === 'cf:D1')).toBeTruthy();
    expect(sub.nodes.find((n) => n.id === ALB_ID)).toBeTruthy();
    expect(sub.nodes.find((n) => n.id === `tg:${TG_ARN}`)).toBeTruthy();
    expect(sub.nodes.filter((n) => n.kind === 'target').length).toBe(1); // 2 IPs → 1 grouped target node
  });

  it('an LB entry yields only its downstream (ALB→TG→targets), not the CF above it', () => {
    const sub = filterFromEntry(full, ALB_ID);
    expect(sub.nodes.find((n) => n.id === 'cf:D1')).toBeFalsy();
    expect(sub.nodes.find((n) => n.id === `tg:${TG_ARN}`)).toBeTruthy();
  });

  it('null/absent entry returns the full graph', () => {
    expect(filterFromEntry(full, null).nodes.length).toBe(full.nodes.length);
    expect(filterFromEntry(full, 'nope:x').nodes.length).toBe(full.nodes.length);
  });
});
