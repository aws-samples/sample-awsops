import { describe, it, expect } from 'vitest';
import { buildTopology } from './topology';

describe('buildTopology', () => {
  const input = {
    vpc: [{ resource_id: 'vpc-1', name: 'main', region: 'ap-northeast-2' }],
    subnet: [
      { resource_id: 'subnet-a', vpc_id: 'vpc-1', name: 'az-a' },
      { resource_id: 'subnet-b', vpc_id: 'vpc-1', name: 'az-b' },
    ],
    ec2: [
      { resource_id: 'i-1', subnet_id: 'subnet-a', vpc_id: 'vpc-1', name: 'web' },
      { resource_id: 'i-2', vpc_id: 'vpc-1', name: 'orphan' }, // no subnet_id → vpc fallback
    ],
    rds: [{ resource_id: 'db-1', vpc_id: 'vpc-1' }],
    alb: [{ resource_id: 'alb-1', vpc_id: 'vpc-1', dns_name: 'x.elb' }],
  };

  it('creates one node per resource across all types', () => {
    const { nodes } = buildTopology(input);
    expect(nodes).toHaveLength(7); // 1 vpc + 2 subnet + 2 ec2 + 1 rds + 1 alb
    expect(nodes.find((n) => n.id === 'vpc:vpc-1')?.label).toBe('main');
    expect(nodes.find((n) => n.id === 'alb:alb-1')?.label).toBe('x.elb');
  });

  it('builds parent→child edges (vpc→subnet, subnet→ec2, vpc→rds/alb)', () => {
    const { edges } = buildTopology(input);
    const has = (s: string, t: string) => edges.some((e) => e.source === s && e.target === t);
    expect(has('vpc:vpc-1', 'subnet:subnet-a')).toBe(true);
    expect(has('subnet:subnet-a', 'ec2:i-1')).toBe(true);
    expect(has('vpc:vpc-1', 'rds:db-1')).toBe(true);
    expect(has('vpc:vpc-1', 'alb:alb-1')).toBe(true);
  });

  it('falls back to a VPC edge for an EC2 with no matching subnet', () => {
    const { edges } = buildTopology(input);
    expect(edges.some((e) => e.source === 'vpc:vpc-1' && e.target === 'ec2:i-2')).toBe(true);
    expect(edges.some((e) => e.target === 'ec2:i-2' && e.source.startsWith('subnet:'))).toBe(false);
  });

  it('omits edges with a missing endpoint (no dangling edges)', () => {
    const { nodes, edges } = buildTopology({ subnet: [{ resource_id: 'subnet-x', vpc_id: 'vpc-missing' }] });
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0); // vpc-missing was never a node
  });

  it('returns empty graph for empty input', () => {
    expect(buildTopology({})).toEqual({ nodes: [], edges: [] });
  });

  it('dedups duplicate resource_ids', () => {
    const { nodes } = buildTopology({ vpc: [{ resource_id: 'vpc-1' }, { resource_id: 'vpc-1' }] });
    expect(nodes).toHaveLength(1);
  });
});
