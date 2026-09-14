import { describe, it, expect } from 'vitest';
import { buildInfraGraph, idsFrom } from './infra-topology';

describe('idsFrom', () => {
  it('handles string | {GroupId} | {SubnetId} | availability_zones[].SubnetId arrays', () => {
    expect(idsFrom(['sg-1', 'sg-2'])).toEqual(['sg-1', 'sg-2']);
    expect(idsFrom([{ GroupId: 'sg-3' }])).toEqual(['sg-3']);
    expect(idsFrom([{ SubnetId: 'subnet-a' }, { SubnetId: 'subnet-b' }])).toEqual(['subnet-a', 'subnet-b']);
    expect(idsFrom('subnet-x')).toEqual(['subnet-x']);
    expect(idsFrom(null)).toEqual([]);
  });
});

describe('buildInfraGraph', () => {
  const vpcs = [{ resource_type: 'vpc', resource_id: 'vpc-1', data: { tags: { Name: 'mgmt-vpc' } } }];
  const subnets = [{ resource_type: 'subnet', resource_id: 'subnet-a', data: { vpc_id: 'vpc-1', tags: { Name: 'app-a' } } }];
  const securityGroups = [
    { resource_type: 'security_group', resource_id: 'sg-1', data: { group_name: 'web-sg' } },
    { resource_type: 'security_group', resource_id: 'sg-def', data: { group_name: 'default' } },
  ];

  it('emits resource -> vpc/subnet/sg edges with the infra rel ontology', () => {
    const resources = [{
      resource_type: 'alb', resource_id: 'my-lb',
      data: { vpc_id: 'vpc-1', availability_zones: [{ SubnetId: 'subnet-a' }], security_groups: [{ GroupId: 'sg-1' }] },
    }];
    const g = buildInfraGraph({ resources, vpcs, subnets, securityGroups });
    const rid = 'alb:my-lb';
    expect(g.nodes.find((n) => n.id === rid)?.kind).toBe('alb');
    expect(g.nodes.find((n) => n.id === 'vpc:vpc-1')?.label).toBe('mgmt-vpc');   // inventory name wins
    expect(g.nodes.find((n) => n.id === 'subnet:subnet-a')?.label).toBe('app-a');
    expect(g.edges.map((e) => e.rel).sort()).toEqual(['infra:in_subnet', 'infra:in_vpc', 'infra:uses_sg']);
    expect(g.edges.find((e) => e.rel === 'infra:uses_sg')?.target).toBe('sg:sg-1');
  });

  it('flags the default security group on its node meta', () => {
    const g = buildInfraGraph({ resources: [], vpcs, subnets, securityGroups });
    expect(g.nodes.find((n) => n.id === 'sg:sg-def')?.meta?.default).toBe(true);
    expect(g.nodes.find((n) => n.id === 'sg:sg-1')?.meta?.default).toBe(false);
  });

  it('preserves RDS security-group relationships from the inventory producer shape', () => {
    const g = buildInfraGraph({
      resources: [{
        resource_type: 'rds', resource_id: 'orders-db', region: 'ap-northeast-2',
        data: {
          db_instance_identifier: 'orders-db', vpc_id: 'vpc-1',
          endpoint_address: 'orders-db.example.rds.amazonaws.com',
          vpc_security_groups: [
            { VpcSecurityGroupId: 'sg-1', Status: 'active' },
            { VpcSecurityGroupId: 'sg-def', Status: 'active' },
          ],
        },
      }],
      vpcs, subnets, securityGroups,
    });
    expect(g.edges.filter((e) => e.rel === 'infra:uses_sg')).toEqual([
      { id: 'infra:uses_sg:rds:orders-db->sg:sg-1', source: 'rds:orders-db', target: 'sg:sg-1', rel: 'infra:uses_sg' },
      { id: 'infra:uses_sg:rds:orders-db->sg:sg-def', source: 'rds:orders-db', target: 'sg:sg-def', rel: 'infra:uses_sg' },
    ]);
    expect(g.nodes.find((n) => n.id === 'rds:orders-db')?.meta?.host).toBe('orders-db.example.rds.amazonaws.com');
  });

  it('preserves every Lambda vpc_subnet_ids relationship and deduplicates overlapping fields', () => {
    const g = buildInfraGraph({
      resources: [{
        resource_type: 'lambda', resource_id: 'orders-handler', region: 'ap-northeast-2',
        data: {
          name: 'orders-handler', vpc_id: 'vpc-1',
          vpc_subnet_ids: ['subnet-a', 'subnet-b', 'subnet-b'],
          vpc_security_group_ids: ['sg-1'], subnet_ids: ['subnet-a'],
        },
      }],
      vpcs, subnets, securityGroups,
    });
    expect(g.edges.filter((e) => e.rel === 'infra:in_subnet').map((e) => [e.source, e.target])).toEqual([
      ['lambda:orders-handler', 'subnet:subnet-a'],
      ['lambda:orders-handler', 'subnet:subnet-b'],
    ]);
    expect(g.edges.filter((e) => e.rel === 'infra:uses_sg').map((e) => e.target)).toEqual(['sg:sg-1']);
    const nodeIds = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => nodeIds.has(e.source) && nodeIds.has(e.target))).toBe(true);
  });

  it('skips resources with no network context (not part of the infra graph)', () => {
    const resources = [{ resource_type: 'route53', resource_id: 'r1', data: { name: 'x.example.com' } }];
    const g = buildInfraGraph({ resources, vpcs: [], subnets: [], securityGroups: [] });
    expect(g.nodes.find((n) => n.id === 'route53:r1')).toBeUndefined();
    expect(g.edges).toHaveLength(0);
  });

  it('stamps meta.host from data.endpoint_address (M2 trace-topology bridge)', () => {
    const resources = [{
      resource_type: 'rds', resource_id: 'db-1',
      data: { vpc_id: 'vpc-1', endpoint_address: 'db-1.abc123.us-east-1.rds.amazonaws.com' },
    }];
    const g = buildInfraGraph({ resources, vpcs, subnets: [], securityGroups: [] });
    expect(g.nodes.find((n) => n.id === 'rds:db-1')?.meta?.host).toBe('db-1.abc123.us-east-1.rds.amazonaws.com');
  });

  it('omits meta.host when the resource has no endpoint_address', () => {
    const resources = [{ resource_type: 'alb', resource_id: 'my-lb', data: { vpc_id: 'vpc-1' } }];
    const g = buildInfraGraph({ resources, vpcs, subnets: [], securityGroups: [] });
    expect(g.nodes.find((n) => n.id === 'alb:my-lb')?.meta).not.toHaveProperty('host');
  });
});
