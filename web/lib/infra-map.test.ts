import { describe, it, expect } from 'vitest';
import { buildInfraMap, highlightClosure, invNodeId, searchMatches, type InfraMapInput, type InvRow } from './infra-map';

const row = (resource_id: string, data: Record<string, unknown> = {}): InvRow =>
  ({ resource_id, region: 'ap-northeast-2', data });

const nid = (kind: Parameters<typeof invNodeId>[0], id: string) => invNodeId(kind, row(id));

const empty = (): InfraMapInput =>
  ({ igw: [], tgw: [], vpc: [], subnet: [], ec2: [], alb: [], nlb: [], rds: [], nat: [] });

const fixture = (): InfraMapInput => ({
  ...empty(),
  igw: [row('igw-1', { attachments: [{ VpcId: 'vpc-a', State: 'available' }] })],
  tgw: [row('tgw-1', { state: 'available', description: 'core' })],
  vpc: [
    row('vpc-a', { name: 'prod', cidr_block: '10.0.0.0/16' }),
    row('vpc-b', { name: 'dev', cidr_block: '10.1.0.0/16' }),
  ],
  subnet: [
    row('subnet-a1', { vpc_id: 'vpc-a', availability_zone: 'apne2-a', cidr_block: '10.0.1.0/24', map_public_ip_on_launch: true, name: 'pub-a' }),
    row('subnet-a2', { vpc_id: 'vpc-a', availability_zone: 'apne2-c', cidr_block: '10.0.2.0/24', map_public_ip_on_launch: false }),
  ],
  ec2: [row('i-1', { name: 'web', subnet_id: 'subnet-a2', vpc_id: 'vpc-a', instance_state: 'running', instance_type: 't4g.large', private_ip_address: '10.0.2.10' })],
  alb: [row('alb-x', { name: 'edge', vpc_id: 'vpc-a', state_code: 'active', scheme: 'internal', availability_zones: [{ SubnetId: 'subnet-a1' }, { SubnetId: 'subnet-a2' }] })],
  rds: [row('db-1', { engine: 'aurora-postgresql', status: 'available', class: 'db.serverless', vpc_id: 'vpc-a' })],
  nat: [row('nat-1', { vpc_id: 'vpc-a', subnet_id: 'subnet-a1', state: 'available' })],
  tgwAttachments: [{ tgwId: 'tgw-1', resourceType: 'vpc', resourceId: 'vpc-b' }],
});

describe('buildInfraMap', () => {
  it('assigns kinds to their columns', () => {
    const g = buildInfraMap(fixture());
    const col = (id: string) => g.nodes.find((n) => n.id === id)?.column;
    expect(col(nid('igw', 'igw-1'))).toBe(0);
    expect(col(nid('tgw', 'tgw-1'))).toBe(0);
    expect(col(nid('vpc', 'vpc-a'))).toBe(1);
    expect(col(nid('subnet', 'subnet-a1'))).toBe(2);
    expect(col(nid('ec2', 'i-1'))).toBe(3);
    expect(col(nid('alb', 'alb-x'))).toBe(3);
    expect(col(nid('rds', 'db-1'))).toBe(3);
    expect(col(nid('nat', 'nat-1'))).toBe(4);
  });

  it('draws containment/attachment edges', () => {
    const g = buildInfraMap(fixture());
    const has = (s: string, t: string) => g.edges.some((e) => e.source === s && e.target === t);
    expect(has(nid('igw', 'igw-1'), nid('vpc', 'vpc-a'))).toBe(true);
    expect(has(nid('tgw', 'tgw-1'), nid('vpc', 'vpc-b'))).toBe(true);
    expect(has(nid('vpc', 'vpc-a'), nid('subnet', 'subnet-a1'))).toBe(true);
    expect(has(nid('subnet', 'subnet-a2'), nid('ec2', 'i-1'))).toBe(true);
    expect(has(nid('vpc', 'vpc-a'), nid('rds', 'db-1'))).toBe(true); // RDS attaches at VPC (no subnet id synced)
    expect(has(nid('subnet', 'subnet-a1'), nid('nat', 'nat-1'))).toBe(true);
  });

  it('fans a multi-subnet ALB out to one edge per subnet', () => {
    const g = buildInfraMap(fixture());
    const albEdges = g.edges.filter((e) => e.target === nid('alb', 'alb-x'));
    expect(albEdges.map((e) => e.source).sort()).toEqual([nid('subnet', 'subnet-a1'), nid('subnet', 'subnet-a2')]);
  });

  it('drops edges to unknown ids but keeps the node', () => {
    const input = { ...empty(), ec2: [row('i-orphan', { subnet_id: 'subnet-missing', instance_state: 'stopped' })] };
    const g = buildInfraMap(input);
    expect(g.nodes.some((n) => n.id === nid('ec2', 'i-orphan'))).toBe(true);
    expect(g.edges).toEqual([]);
  });

  it('marks status and public-subnet badge', () => {
    const g = buildInfraMap(fixture());
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(node(nid('ec2', 'i-1')).status).toBe('ok'); // running
    expect(node(nid('nat', 'nat-1')).status).toBe('ok'); // available
    expect(node(nid('subnet', 'subnet-a1')).badge).toContain('auto-public-ip');
    expect(node(nid('subnet', 'subnet-a2')).badge ?? '').not.toContain('auto-public-ip');
  });

  it('sorts subnets by (vpc, az, name) and stacks deterministically', () => {
    const g = buildInfraMap(fixture());
    const subnets = g.nodes.filter((n) => n.kind === 'subnet').map((n) => n.id);
    expect(subnets).toEqual([nid('subnet', 'subnet-a1'), nid('subnet', 'subnet-a2')]);
  });

  it('uses name as label with id fallback', () => {
    const g = buildInfraMap(fixture());
    expect(g.nodes.find((n) => n.id === nid('vpc', 'vpc-a'))?.label).toBe('prod');
    expect(g.nodes.find((n) => n.id === nid('subnet', 'subnet-a2'))?.label).toBe('subnet-a2');
  });

  it('skips TGW attachment edges in failed/deleting states', () => {
    const input = { ...fixture(), tgwAttachments: [{ tgwId: 'tgw-1', resourceType: 'vpc', resourceId: 'vpc-b', state: 'deleting' }] };
    const g = buildInfraMap(input);
    expect(g.edges.some((e) => e.source === nid('tgw', 'tgw-1'))).toBe(false);
  });

  it('skips TGW attachment edges in pending states too (allowlist)', () => {
    const input = { ...fixture(), tgwAttachments: [{ tgwId: 'tgw-1', resourceType: 'vpc', resourceId: 'vpc-b', state: 'pendingAcceptance' }] };
    expect(buildInfraMap(input).edges.some((e) => e.source === nid('tgw', 'tgw-1'))).toBe(false);
  });

  it('keeps same-named LBs in different regions as distinct nodes', () => {
    const a: InvRow = { resource_id: 'edge', region: 'ap-northeast-2', data: { name: 'edge', vpc_id: 'vpc-a', state_code: 'active', scheme: 'internal', availability_zones: [] } };
    const b: InvRow = { resource_id: 'edge', region: 'us-east-1', data: { name: 'edge', vpc_id: 'vpc-z', state_code: 'active', scheme: 'internal', availability_zones: [] } };
    const g = buildInfraMap({ ...empty(), alb: [a, b] });
    expect(g.nodes.filter((n) => n.kind === 'alb')).toHaveLength(2);
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
  });
});

describe('highlightClosure', () => {
  it('EC2 selection lights ancestors up to VPC (and its IGW) but not sibling subnets', () => {
    const g = buildInfraMap(fixture());
    const hl = highlightClosure(g, nid('ec2', 'i-1'));
    expect(hl.has(nid('ec2', 'i-1'))).toBe(true);
    expect(hl.has(nid('subnet', 'subnet-a2'))).toBe(true);
    expect(hl.has(nid('vpc', 'vpc-a'))).toBe(true);
    expect(hl.has(nid('igw', 'igw-1'))).toBe(true); // ancestor of vpc-a
    expect(hl.has(nid('subnet', 'subnet-a1'))).toBe(false); // sibling — must stay dim
    expect(hl.has(nid('rds', 'db-1'))).toBe(false); // sibling
  });

  it('VPC selection lights all descendants and its external ancestors', () => {
    const g = buildInfraMap(fixture());
    const hl = highlightClosure(g, nid('vpc', 'vpc-a'));
    for (const id of [nid('subnet', 'subnet-a1'), nid('subnet', 'subnet-a2'), nid('ec2', 'i-1'), nid('alb', 'alb-x'), nid('rds', 'db-1'), nid('nat', 'nat-1'), nid('igw', 'igw-1')]) {
      expect(hl.has(id)).toBe(true);
    }
    expect(hl.has(nid('vpc', 'vpc-b'))).toBe(false);
    expect(hl.has(nid('tgw', 'tgw-1'))).toBe(false); // attached to vpc-b only
  });
});

describe('searchMatches', () => {
  it('matches instance type and private IP through meta', () => {
    const g = buildInfraMap(fixture());
    expect(searchMatches(g, 't4g.large').has(nid('ec2', 'i-1'))).toBe(true);
    expect(searchMatches(g, '10.0.2.10').has(nid('ec2', 'i-1'))).toBe(true);
  });
  it('matches CIDR and is case-insensitive on labels', () => {
    const g = buildInfraMap(fixture());
    expect(searchMatches(g, '10.0.1.0/24').has(nid('subnet', 'subnet-a1'))).toBe(true);
    expect(searchMatches(g, 'PROD').has(nid('vpc', 'vpc-a'))).toBe(true);
  });
  it('returns empty set for blank query', () => {
    const g = buildInfraMap(fixture());
    expect(searchMatches(g, '   ').size).toBe(0);
  });
});
