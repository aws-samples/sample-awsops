import { describe, expect, it } from 'vitest';
import { buildNetworkTopology } from './network-topology';
import type { NetRow, NetworkSelection } from './network-topology-types';

const A = '111111111111', B = '222222222222', R = 'ap-northeast-2';
const row = (resource_type: string, account_id: string, region: string, resource_id: string,
  data: Record<string, unknown>, captured_at = '2026-11-06T10:00:00Z'): NetRow =>
  ({ resource_type, account_id, region, resource_id, data, captured_at });
const vpc = (acct: string, id: string, name: string, extra: Record<string, unknown> = {}) =>
  row('vpc', acct, R, id, { owner_id: acct === 'self' ? A : acct, name, cidr_block: '10.0.0.0/16', ...extra });
const att = (acct: string, id: string, tgw: string, tgwOwner: string, vpcId: string, vpcOwner: string, state = 'available') =>
  row('transit_gateway_attachment', acct, R, id, { transit_gateway_id: tgw, transit_gateway_owner_id: tgwOwner,
    attached_resource_type: 'vpc', attached_resource_id: vpcId, resource_owner_id: vpcOwner, state });
const build = (rows: NetRow[], selection: NetworkSelection = { accounts: '__all__', vpcs: [] }, hostAccountId: string | null = A) =>
  buildNetworkTopology(rows, { hostAccountId, aliases: { [A]: 'host', [B]: 'member' }, selection });

const fleet = [
  vpc('self', 'vpc-aaaaaaaa', 'hub'),
  vpc(B, 'vpc-bbbbbbbb', 'spoke'),
  row('transit_gateway', 'self', R, 'tgw-0123456789abcdef0', { owner_id: A, state: 'available', name: 'core-tgw' }),
  // The TGW owner (host) sees both attachments; the member sees its own one again.
  att('self', 'tgw-attach-0000000000000000a', 'tgw-0123456789abcdef0', A, 'vpc-aaaaaaaa', A),
  att('self', 'tgw-attach-0000000000000000b', 'tgw-0123456789abcdef0', A, 'vpc-bbbbbbbb', B),
  att(B, 'tgw-attach-0000000000000000b', 'tgw-0123456789abcdef0', A, 'vpc-bbbbbbbb', B),
];

describe('buildNetworkTopology', () => {
  it('dedupes a cross-account TGW attachment seen by both owner and member', () => {
    const t = build(fleet);
    expect(t.level).toBe('fleet');
    expect(t.nodes.filter((n) => n.kind === 'tgw')).toHaveLength(1);
    const edges = t.edges.filter((e) => e.kind === 'tgw');
    expect(edges).toHaveLength(2);
    const cross = edges.find((e) => e.recordId === 'tgw-attach-0000000000000000b')!;
    expect(cross.crossAccount).toBe(true);
    expect(cross.source).toBe(`vpc:${B}/${R}/vpc-bbbbbbbb`);
    expect(cross.target).toBe(`tgw:${A}/${R}/tgw-0123456789abcdef0`);
  });

  it('withholds an attachment id with conflicting resource ids', () => {
    const t = build([...fleet, att(B, 'tgw-attach-0000000000000000a', 'tgw-0123456789abcdef0', A, 'vpc-bbbbbbbb', B)]);
    expect(t.edges.some((e) => e.recordId === 'tgw-attach-0000000000000000a')).toBe(false);
    expect(t.omitted.conflicting).toBe(1);
  });

  it('draws only available attachments and active peerings', () => {
    const t = build([
      vpc('self', 'vpc-aaaaaaaa', 'hub'), vpc(B, 'vpc-bbbbbbbb', 'spoke'),
      att('self', 'tgw-attach-0000000000000000c', 'tgw-0123456789abcdef0', A, 'vpc-aaaaaaaa', A, 'pending'),
      row('vpc_peering_connection', 'self', R, 'pcx-11111111', { status_code: 'deleted',
        requester_owner_id: A, requester_region: R, requester_vpc_id: 'vpc-aaaaaaaa',
        accepter_owner_id: B, accepter_region: R, accepter_vpc_id: 'vpc-bbbbbbbb' }),
    ]);
    expect(t.edges).toHaveLength(0);
    expect(t.omitted.inactive).toBe(2);
  });

  it('draws an active cross-account peering once even when both sides collected it', () => {
    const pcx = { status_code: 'active', requester_owner_id: A, requester_region: R, requester_vpc_id: 'vpc-aaaaaaaa',
      accepter_owner_id: B, accepter_region: R, accepter_vpc_id: 'vpc-bbbbbbbb' };
    const t = build([vpc('self', 'vpc-aaaaaaaa', 'hub'), vpc(B, 'vpc-bbbbbbbb', 'spoke'),
      row('vpc_peering_connection', 'self', R, 'pcx-11111111', pcx), row('vpc_peering_connection', B, R, 'pcx-11111111', pcx)]);
    expect(t.edges).toEqual([expect.objectContaining({ kind: 'peering', recordId: 'pcx-11111111', crossAccount: true })]);
  });

  it('keys a RAM-shared VPC by owner_id', () => {
    const t = build([vpc('self', 'vpc-aaaaaaaa', 'shared'), row('vpc', B, R, 'vpc-aaaaaaaa', { owner_id: A, name: 'shared' })]);
    expect(t.nodes.filter((n) => n.kind === 'vpc').map((n) => n.id)).toEqual([`vpc:${A}/${R}/vpc-aaaaaaaa`]);
  });

  it('maps self rows to the host account id, or keeps self without a host', () => {
    expect(build([vpc('self', 'vpc-aaaaaaaa', 'hub')]).nodes.map((n) => n.id)).toContain(`account:${A}`);
    const t = build([row('vpc', 'self', R, 'vpc-aaaaaaaa', { name: 'hub' })], undefined, null);
    expect(t.nodes.map((n) => n.id)).toContain('account:self');
    expect(t.nodes.map((n) => n.id)).toContain(`vpc:self/${R}/vpc-aaaaaaaa`);
  });

  it('renders out-of-scope peers as external stubs', () => {
    const t = build(fleet, { accounts: [A], vpcs: [] });
    expect(t.nodes.some((n) => n.id === `account:${B}`)).toBe(false);
    const stub = t.nodes.find((n) => n.id === `external:${B}/${R}/vpc-bbbbbbbb`)!;
    expect(stub).toMatchObject({ kind: 'external', label: 'spoke', outOfScope: true, parent: null, vpcKey: `${B}/${R}/vpc-bbbbbbbb` });
    expect(t.edges.some((e) => e.source === stub.id)).toBe(true);
  });

  it('renders a TGW owned by an account without inventory as an out-of-scope stub', () => {
    const C = '333333333333';
    const t = build([vpc(B, 'vpc-bbbbbbbb', 'spoke'),
      att(B, 'tgw-attach-0000000000000000d', 'tgw-0fedcba9876543210', C, 'vpc-bbbbbbbb', B)]);
    expect(t.nodes.some((n) => n.id === `account:${C}`)).toBe(false);
    expect(t.nodes.find((n) => n.id === `tgw:${C}/${R}/tgw-0fedcba9876543210`)).toMatchObject({ parent: null, outOfScope: true });
  });

  it('renders a VPC whose owner never collected inventory as an expandable stub, not an account box', () => {
    const C = '333333333333';
    const t = build([vpc(B, 'vpc-bbbbbbbb', 'spoke'), row('vpc', B, R, 'vpc-cccccccc', { owner_id: C, name: 'shared-from-c' })]);
    expect(t.nodes.some((n) => n.id === `account:${C}`)).toBe(false);
    expect(t.nodes.find((n) => n.id === `external:${C}/${R}/vpc-cccccccc`)).toMatchObject({ kind: 'external', inInventory: true, label: 'shared-from-c' });
  });

  it('marks whether an external stub exists in inventory', () => {
    const t = build([vpc('self', 'vpc-aaaaaaaa', 'hub'), ...fleet.slice(2),
      att('self', 'tgw-attach-0000000000000000e', 'tgw-0123456789abcdef0', A, 'vpc-eeeeeeee', '333333333333')], { accounts: [A], vpcs: [] });
    expect(t.nodes.find((n) => n.id === `external:${B}/${R}/vpc-bbbbbbbb`)?.inInventory).toBe(false);
    const known = build(fleet, { accounts: [A], vpcs: [] });
    expect(known.nodes.find((n) => n.id === `external:${B}/${R}/vpc-bbbbbbbb`)?.inInventory).toBe(true);
    expect(t.nodes.find((n) => n.id === `external:333333333333/${R}/vpc-eeeeeeee`)?.inInventory).toBe(false);
  });

  describe('detail level', () => {
    const vpcKey = `${A}/${R}/vpc-aaaaaaaa`;
    const subnet = (id: string, az: string) => row('subnet', 'self', R, id, { vpc_id: 'vpc-aaaaaaaa', availability_zone: az, name: id, cidr_block: '10.0.1.0/24' });
    const rt = (id: string, assoc: Record<string, unknown>[], routes: Record<string, unknown>[]) =>
      row('route_table', 'self', R, id, { vpc_id: 'vpc-aaaaaaaa', associations: assoc, routes });
    const base = [
      ...fleet,
      subnet('subnet-pub', `${R}a`), subnet('subnet-priv', `${R}a`), subnet('subnet-none', `${R}c`),
      rt('rtb-pub', [{ SubnetId: 'subnet-pub' }], [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-0123' }]),
      rt('rtb-priv', [{ SubnetId: 'subnet-priv' }], [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-0123' }]),
      row('internet_gateway', 'self', R, 'igw-0123', { attachments: [{ VpcId: 'vpc-aaaaaaaa' }] }),
      row('rds', 'self', R, 'db-one', { vpc_id: 'vpc-aaaaaaaa' }),
    ];

    it('classifies subnet tiers from route tables', () => {
      const t = build(base, { accounts: '__all__', vpcs: [vpcKey] });
      const tier = (id: string) => t.nodes.find((n) => n.id === `subnet:${A}/${R}/${id}`)?.tier;
      expect(t.level).toBe('detail');
      expect(tier('subnet-pub')).toBe('public');
      expect(tier('subnet-priv')).toBe('private');
      expect(tier('subnet-none')).toBe('unknown');
    });

    it('nests detail resources and caps tiles per subnet', () => {
      const ec2 = Array.from({ length: 14 }, (_, i) => row('ec2', 'self', R, `i-${String(i).padStart(17, '0')}`,
        { vpc_id: 'vpc-aaaaaaaa', subnet_id: 'subnet-priv', name: `web-${i}`, instance_state: 'running' }));
      const t = build([...base, ...ec2], { accounts: '__all__', vpcs: [vpcKey] });
      const parentOf = (id: string) => t.nodes.find((n) => n.id === id)?.parent;
      const subnetId = `subnet:${A}/${R}/subnet-priv`;
      expect(t.nodes.filter((n) => n.kind === 'ec2' && n.parent === subnetId)).toHaveLength(12);
      expect(t.nodes.find((n) => n.id === `more:${subnetId}`)).toMatchObject({ kind: 'more', count: 2, parent: subnetId });
      expect(t.omitted.resourcesCapped).toBe(2);
      expect(parentOf(subnetId)).toBe(`az:${vpcKey}/${R}a`);
      expect(parentOf(`az:${vpcKey}/${R}a`)).toBe(`vpc:${vpcKey}`);
      expect(parentOf(`igw:${A}/${R}/igw-0123`)).toBe(`vpc:${vpcKey}`);
      expect(parentOf(`rds:${A}/${R}/db-one`)).toBe(`vpc:${vpcKey}`);
      // Unselected VPCs are not expanded; the TGW-connected member VPC becomes a stub.
      expect(t.nodes.some((n) => n.id === `vpc:${B}/${R}/vpc-bbbbbbbb`)).toBe(false);
      expect(t.nodes.some((n) => n.id === `external:${B}/${R}/vpc-bbbbbbbb`)).toBe(true);
    });

    it('orders parents before children', () => {
      const t = build(base, { accounts: '__all__', vpcs: [vpcKey] });
      const seen = new Set<string>();
      for (const n of t.nodes) {
        if (n.parent) expect(seen.has(n.parent), n.id).toBe(true);
        seen.add(n.id);
      }
    });

    it('attributes participant-collected tiles to the collecting account in a shared VPC', () => {
      const t = build([...base, row('subnet', B, R, 'subnet-pub', { vpc_id: 'vpc-aaaaaaaa', availability_zone: `${R}a`, name: 'subnet-pub' }),
        row('vpc', B, R, 'vpc-aaaaaaaa', { owner_id: A, name: 'hub' }),
        row('ec2', B, R, 'i-0000000000000000b', { vpc_id: 'vpc-aaaaaaaa', subnet_id: 'subnet-pub', name: 'member-web' })],
        { accounts: '__all__', vpcs: [vpcKey] });
      const tileNode = t.nodes.find((n) => n.resourceId === 'i-0000000000000000b')!;
      expect(tileNode).toMatchObject({ id: `ec2:${B}/${R}/i-0000000000000000b`, accountId: B, vpcKey, parent: `subnet:${A}/${R}/subnet-pub` });
    });

    it('groups shared subnets by AZ id so owner and participant copies share one column', () => {
      const t = build([...base,
        row('subnet', 'self', R, 'subnet-shared', { vpc_id: 'vpc-aaaaaaaa', availability_zone: `${R}a`, availability_zone_id: 'apne2-az1', name: 'shared' }),
        row('vpc', B, R, 'vpc-aaaaaaaa', { owner_id: A, name: 'hub' }),
        row('subnet', B, R, 'subnet-shared', { vpc_id: 'vpc-aaaaaaaa', availability_zone: `${R}c`, availability_zone_id: 'apne2-az1', name: 'shared' })],
        { accounts: '__all__', vpcs: [vpcKey] });
      const azs = t.nodes.filter((n) => n.kind === 'az' && n.id.endsWith('apne2-az1'));
      expect(azs).toHaveLength(1);
      expect(azs[0].label).toBe(`${R}a`);
      expect(t.nodes.find((n) => n.id === `subnet:${A}/${R}/subnet-shared`)?.parent).toBe(azs[0].id);
    });

    it('treats IPv6 IGW default routes as public and blackhole routes as not public', () => {
      const t = build([...base,
        subnet('subnet-v6', `${R}a`), subnet('subnet-bh', `${R}a`),
        rt('rtb-v6', [{ SubnetId: 'subnet-v6' }], [{ DestinationIpv6CidrBlock: '::/0', GatewayId: 'igw-0123', State: 'active' }]),
        rt('rtb-bh', [{ SubnetId: 'subnet-bh' }], [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-0123', State: 'blackhole' }])],
        { accounts: '__all__', vpcs: [vpcKey] });
      const tier = (id: string) => t.nodes.find((n) => n.id === `subnet:${A}/${R}/${id}`)?.tier;
      expect(tier('subnet-v6')).toBe('public');
      expect(tier('subnet-bh')).toBe('private');
    });
  });

  it('lets the freshest copy of a link decide whether it is live', () => {
    const live = { ...att('self', 'tgw-attach-0000000000000000f', 'tgw-0123456789abcdef0', A, 'vpc-bbbbbbbb', B), captured_at: '2026-11-06T12:00:00Z' };
    const stale = { ...att(B, 'tgw-attach-0000000000000000f', 'tgw-0123456789abcdef0', A, 'vpc-bbbbbbbb', B, 'pending'), captured_at: '2026-11-06T09:00:00Z' };
    const t = build([vpc('self', 'vpc-aaaaaaaa', 'hub'), vpc(B, 'vpc-bbbbbbbb', 'spoke'), stale, live]);
    expect(t.edges.some((e) => e.recordId === 'tgw-attach-0000000000000000f')).toBe(true);
    expect(t.omitted.inactive).toBe(0);
  });

  it('reports the oldest captured_at of fleet rows', () => {
    const t = build([vpc('self', 'vpc-aaaaaaaa', 'hub'), { ...vpc(B, 'vpc-bbbbbbbb', 'spoke'), captured_at: '2026-11-06T08:00:00Z' }]);
    expect(t.capturedAt).toBe('2026-11-06T08:00:00.000Z');
  });

  it('includes detail rows and Date values in capturedAt', () => {
    const rows = [...fleet, row('subnet', 'self', R, 'subnet-old', { vpc_id: 'vpc-aaaaaaaa', availability_zone: `${R}a` },
      new Date('2026-11-05T01:00:00Z') as unknown as string)];
    expect(build(rows, { accounts: '__all__', vpcs: [`${A}/${R}/vpc-aaaaaaaa`] }).capturedAt).toBe('2026-11-05T01:00:00.000Z');
    expect(build(rows, { accounts: '__all__', vpcs: [] }).capturedAt).toBe('2026-11-06T10:00:00.000Z');
  });
});
