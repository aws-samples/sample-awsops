import { describe, it, expect, vi, beforeEach } from 'vitest';

// REGION은 모듈 로드 시점에 읽으므로 import 전에 고정 (테스트 결정성 — vpce.test.ts 선례)
process.env.AWS_REGION = 'ap-northeast-2';

const ec2Send = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class {
    constructor(public cfg: { region: string }) {}
    send(cmd: unknown) { return ec2Send(cmd, this.cfg.region); }
  },
  DescribeTransitGatewayAttachmentsCommand: class { constructor(public input: unknown) {} },
  DescribeTransitGatewayRouteTablesCommand: class { constructor(public input: unknown) {} },
  DescribeTransitGatewayVpcAttachmentsCommand: class { constructor(public input: unknown) {} },
  SearchTransitGatewayRoutesCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(async () => {
  ec2Send.mockReset();
  const { _resetTgwCacheForTests } = await import('./tgw');
  _resetTgwCacheForTests();
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function mockRegion(opts: {
  attachments?: unknown[];
  vpcAttachments?: unknown[];
  routeTables?: unknown[];
  routes?: unknown[];
  additionalRoutes?: boolean;
  failVpcAttachments?: boolean;
  failRegion?: string;
}) {
  ec2Send.mockImplementation(async (cmd: unknown, region: string) => {
    const c = cmd as Cmd;
    if (opts.failRegion && region === opts.failRegion) throw new Error('denied');
    switch (c.constructor.name) {
      case 'DescribeTransitGatewayAttachmentsCommand':
        return { TransitGatewayAttachments: opts.attachments ?? [] };
      case 'DescribeTransitGatewayVpcAttachmentsCommand':
        if (opts.failVpcAttachments) throw new Error('vpc-att denied');
        return { TransitGatewayVpcAttachments: opts.vpcAttachments ?? [] };
      case 'DescribeTransitGatewayRouteTablesCommand':
        return { TransitGatewayRouteTables: opts.routeTables ?? [] };
      case 'SearchTransitGatewayRoutesCommand':
        return { Routes: opts.routes ?? [], AdditionalRoutesAvailable: opts.additionalRoutes ?? false };
      default:
        throw new Error(`unexpected command ${c.constructor.name}`);
    }
  });
}

describe('tgwDetails (gap L168)', () => {
  it('merges VPC-attachment options into attachment rows; non-VPC rows keep options null', async () => {
    mockRegion({
      attachments: [
        { TransitGatewayAttachmentId: 'tgw-attach-vpc', TransitGatewayId: 'tgw-1', ResourceType: 'vpc', ResourceId: 'vpc-1', State: 'available', Association: { TransitGatewayRouteTableId: 'tgw-rtb-1' } },
        { TransitGatewayAttachmentId: 'tgw-attach-vpn', TransitGatewayId: 'tgw-1', ResourceType: 'vpn', ResourceId: 'vpn-1', State: 'available' },
      ],
      vpcAttachments: [
        { TransitGatewayAttachmentId: 'tgw-attach-vpc', Options: { DnsSupport: 'enable', Ipv6Support: 'disable', ApplianceModeSupport: 'disable' } },
      ],
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    const vpc = d.attachments.find((a) => a.id === 'tgw-attach-vpc');
    const vpn = d.attachments.find((a) => a.id === 'tgw-attach-vpn');
    expect(vpc?.options).toEqual({ dnsSupport: 'enable', ipv6Support: 'disable', applianceModeSupport: 'disable' });
    expect(vpn?.options).toBeNull(); // the API exposes options per attachment TYPE
  });

  it('a failed VPC-attachment describe degrades to null options WITHOUT failing the region — and DISCLOSES it', async () => {
    mockRegion({
      attachments: [
        { TransitGatewayAttachmentId: 'tgw-attach-vpc', TransitGatewayId: 'tgw-1', ResourceType: 'vpc', ResourceId: 'vpc-1', State: 'available' },
      ],
      failVpcAttachments: true,
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    expect(d.attachments).toHaveLength(1); // attachments/routes still render
    expect(d.attachments[0].options).toBeNull();
    expect(d.degradedRegions ?? []).toEqual([]); // options degrade is NOT a region degrade
    // …but it IS disclosed: a denied options describe must never be conflated with
    // "not a VPC attachment" (the honest-degrade contract this file established)
    expect(d.optionsDegradedRegions).toEqual(['ap-northeast-2']);
  });

  it('a successful options describe reports NO options degradation', async () => {
    mockRegion({ attachments: [], vpcAttachments: [] });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    expect(d.optionsDegradedRegions ?? []).toEqual([]);
  });

  it('follows NextToken on the VPC-attachment describe (a row past page 1 must not read —)', async () => {
    let call = 0;
    ec2Send.mockImplementation(async (cmd: unknown) => {
      const c = cmd as Cmd;
      switch (c.constructor.name) {
        case 'DescribeTransitGatewayAttachmentsCommand':
          return { TransitGatewayAttachments: [
            { TransitGatewayAttachmentId: 'att-2', TransitGatewayId: 'tgw-1', ResourceType: 'vpc', ResourceId: 'vpc-2', State: 'available' },
          ] };
        case 'DescribeTransitGatewayVpcAttachmentsCommand': {
          call += 1;
          if (call === 1) {
            expect((c.input as { NextToken?: string }).NextToken).toBeUndefined();
            return { TransitGatewayVpcAttachments: [
              { TransitGatewayAttachmentId: 'att-1', Options: { DnsSupport: 'enable', Ipv6Support: 'disable', ApplianceModeSupport: 'disable' } },
            ], NextToken: 't2' };
          }
          expect((c.input as { NextToken?: string }).NextToken).toBe('t2');
          return { TransitGatewayVpcAttachments: [
            { TransitGatewayAttachmentId: 'att-2', Options: { DnsSupport: 'disable', Ipv6Support: 'disable', ApplianceModeSupport: 'enable' } },
          ] };
        }
        case 'DescribeTransitGatewayRouteTablesCommand':
          return { TransitGatewayRouteTables: [] };
        default:
          throw new Error('unexpected');
      }
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    expect(call).toBe(2);
    expect(d.attachments[0].options).toEqual({ dnsSupport: 'disable', ipv6Support: 'disable', applianceModeSupport: 'enable' });
  });

  it('groups by owning region (a TGW in another region is queried with that region client)', async () => {
    mockRegion({ attachments: [], routeTables: [] });
    const { tgwDetails } = await import('./tgw');
    await tgwDetails([{ id: 'tgw-a' }, { id: 'tgw-b', region: 'us-west-2' }]);
    const regions = new Set(ec2Send.mock.calls.map(([, r]) => r));
    expect(regions).toEqual(new Set(['ap-northeast-2', 'us-west-2']));
  });

  it('a whole-region failure reports degradedRegions (missing, not empty)', async () => {
    mockRegion({ attachments: [], failRegion: 'us-west-2' });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-b', region: 'us-west-2' }]);
    expect(d.attachments).toEqual([]);
    expect(d.degradedRegions).toEqual(['us-west-2']);
  });

  it('route truncation flag survives (SearchTransitGatewayRoutes cap disclosed)', async () => {
    mockRegion({
      routeTables: [{ TransitGatewayRouteTableId: 'tgw-rtb-1', TransitGatewayId: 'tgw-1', State: 'available' }],
      routes: [{ DestinationCidrBlock: '10.0.0.0/8', Type: 'propagated', State: 'active', TransitGatewayAttachments: [{ ResourceId: 'vpc-1', ResourceType: 'vpc' }] }],
      additionalRoutes: true,
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    expect(d.routeTables[0].truncated).toBe(true);
    expect(d.routeTables[0].routes[0]).toEqual({ cidr: '10.0.0.0/8', type: 'propagated', state: 'active', resourceId: 'vpc-1', resourceType: 'vpc' });
  });
});

describe('IAM wiring guard (the "new SDK call, forgotten IAM action" class)', () => {
  // SCOPE: this is a missing-GRANT guard, not an ADR-005 read-only-invariant guard — a
  // mutating command would need its own review; the read-only assertion below merely makes a
  // Modify*/Create*/Delete* import turn the test red so that review actually happens.
  it('every EC2 command tgw.ts IMPORTS is read-only and granted as an Allow action in workload.tf', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Derive the command list from the module SOURCE (not a hardcoded copy): a 5th SDK
    // command added to tgw.ts without an IAM grant must turn this red.
    const src = readFileSync(join(__dirname, 'tgw.ts'), 'utf8');
    // Scope the scan to the @aws-sdk/client-ec2 import block: a future non-EC2 client's
    // commands must not be asserted as ec2:<Name> (message accuracy — the guard itself is
    // per-client by construction).
    const importBlock = src.match(/import \{([\s\S]*?)\} from '@aws-sdk\/client-ec2';/)?.[1] ?? '';
    expect(importBlock).not.toBe('');
    const commands = [...new Set(
      [...importBlock.matchAll(/\b([A-Z][A-Za-z]+)Command\b/g)].map((m) => m[1]),
    )];
    expect(commands.length).toBeGreaterThanOrEqual(4); // sanity: the scan actually found them
    // read-only verb allowlist: any other verb here is a policy question, not a wiring fix
    for (const cmd of commands) {
      expect(cmd, `${cmd} is not a read-only EC2 verb — tgw.ts must stay read-only`).toMatch(/^(Describe|Search|List|Get)/);
    }
    const tf = readFileSync(
      join(__dirname, '..', '..', 'terraform', 'foundation', 'workload.tf'), 'utf8',
    );
    // Match quoted Allow-list entries only ("ec2:X",) — a mention in a comment or prose
    // doesn't count. (Statement-level scoping would need real HCL parsing; the task role's
    // EC2 actions live in a single enumerated statement, and a quoted action string in this
    // file is an action entry by construction.)
    for (const cmd of commands) {
      expect(tf, `ec2:${cmd} missing from workload.tf`).toMatch(new RegExp(`"ec2:${cmd}",`));
    }
  });
});

describe('options incomplete-view disclosure (round 2)', () => {
  it('a leftover NextToken after the page cap is disclosed as incomplete, NOT success', async () => {
    ec2Send.mockImplementation(async (cmd: unknown) => {
      const c = cmd as Cmd;
      switch (c.constructor.name) {
        case 'DescribeTransitGatewayAttachmentsCommand':
          return { TransitGatewayAttachments: [] };
        case 'DescribeTransitGatewayVpcAttachmentsCommand':
          // ALWAYS returns a NextToken: the 5-page cap exits with a token left over
          return { TransitGatewayVpcAttachments: [], NextToken: 'more' };
        case 'DescribeTransitGatewayRouteTablesCommand':
          return { TransitGatewayRouteTables: [] };
        default: throw new Error('unexpected');
      }
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    const pages = ec2Send.mock.calls.filter(([cmd]) => (cmd as Cmd).constructor.name === 'DescribeTransitGatewayVpcAttachmentsCommand').length;
    expect(pages).toBe(5); // capped
    expect(d.optionsDegradedRegions).toEqual(['ap-northeast-2']); // truncation disclosed
  });

  it('a page-N failure KEEPS already-fetched pages and still discloses the region', async () => {
    let call = 0;
    ec2Send.mockImplementation(async (cmd: unknown) => {
      const c = cmd as Cmd;
      switch (c.constructor.name) {
        case 'DescribeTransitGatewayAttachmentsCommand':
          return { TransitGatewayAttachments: [
            { TransitGatewayAttachmentId: 'att-1', TransitGatewayId: 'tgw-1', ResourceType: 'vpc', ResourceId: 'vpc-1', State: 'available' },
          ] };
        case 'DescribeTransitGatewayVpcAttachmentsCommand': {
          call += 1;
          if (call === 1) return { TransitGatewayVpcAttachments: [
            { TransitGatewayAttachmentId: 'att-1', Options: { DnsSupport: 'enable', Ipv6Support: 'disable', ApplianceModeSupport: 'disable' } },
          ], NextToken: 't2' };
          throw new Error('Throttling'); // page 2 dies
        }
        case 'DescribeTransitGatewayRouteTablesCommand':
          return { TransitGatewayRouteTables: [] };
        default: throw new Error('unexpected');
      }
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    // page-1 options survive the page-2 throttle…
    expect(d.attachments[0].options).toEqual({ dnsSupport: 'enable', ipv6Support: 'disable', applianceModeSupport: 'disable' });
    // …and the region is still disclosed incomplete
    expect(d.optionsDegradedRegions).toEqual(['ap-northeast-2']);
  });

  it('a VPC-type row the (successful) options response never returned is disclosed (RAM-shared caveat)', async () => {
    mockRegion({
      attachments: [
        { TransitGatewayAttachmentId: 'att-shared', TransitGatewayId: 'tgw-1', ResourceType: 'vpc', ResourceId: 'vpc-x', State: 'available' },
      ],
      vpcAttachments: [], // describe succeeded but returned nothing for this VPC row
    });
    const { tgwDetails } = await import('./tgw');
    const d = await tgwDetails([{ id: 'tgw-1' }]);
    expect(d.attachments[0].options).toBeNull();
    expect(d.optionsDegradedRegions).toEqual(['ap-northeast-2']); // incomplete, not "non-VPC"
  });
});
