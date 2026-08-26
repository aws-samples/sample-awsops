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
