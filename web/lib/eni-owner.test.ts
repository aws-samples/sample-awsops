import { describe, expect, it } from 'vitest';
import { eniOwnerResolver, type EniOwnerInput } from './eni-owner';

const R = 'ap-northeast-2', VPC = 'vpc-1';
const eni = (id: string, ip: string, data: Record<string, unknown> = {}) => ({
  resource_id: id, region: R, vpc_id: VPC, private_ip_address: ip,
  private_ip_addresses: [{ PrivateIpAddress: ip, Primary: true }], ...data,
});
const resolve = (input: EniOwnerInput, ip: string, vpc = VPC) => eniOwnerResolver(input).resolve(R, vpc, ip);

describe('eniOwnerResolver', () => {
  it('returns null when no synced ENI holds the IP in that region/VPC', () => {
    expect(resolve({ eni: [eni('eni-1', '10.0.0.1')] }, '10.0.0.2')).toBeNull();
    expect(resolve({ eni: [eni('eni-1', '10.0.0.1')] }, '10.0.0.1', 'vpc-other')).toBeNull();
  });

  it('treats an IP claimed by two ENIs as ambiguous, never the first match', () => {
    expect(resolve({ eni: [eni('eni-1', '10.0.0.1'), eni('eni-2', '10.0.0.1')] }, '10.0.0.1'))
      .toEqual({ reason: 'owner_ambiguous', eniId: null });
  });

  it('merges one ENI seen under several accounts (a RAM-shared VPC) instead of vetoing it', () => {
    const shared = (account: string) => eni('eni-s', '10.0.0.9', { account_id: account,
      attached_instance_id: 'i-0abc', requester_managed: false });
    const input = { eni: [shared('111122223333'), shared('444455556666')],
      ec2: [{ resource_id: 'i-0abc', region: R, name: 'node-a' }] };
    expect(resolve(input, '10.0.0.9')).toEqual({ owner: expect.objectContaining({ kind: 'ec2', eniId: 'eni-s' }) });
  });

  it('recognizes a NAT ENI by its InterfaceType even without the description prefix', () => {
    const input = { nat_gateway: [{ resource_id: 'nat-0123456789abcdef0', region: R }],
      eni: [eni('eni-n', '10.0.2.9', { interface_type: 'natGateway', description: 'nat-0123456789abcdef0' })] };
    expect(resolve(input, '10.0.2.9')).toEqual({ owner: expect.objectContaining({ kind: 'nat_gateway' }) });
  });

  it('resolves an ELB ENI by the exact ARN suffix, not by name alone', () => {
    const alb = { resource_id: 'web', region: R,
      arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/web/50dc6c495c0c9188' };
    const sameName = { ...alb, arn: alb.arn.replace('50dc6c495c0c9188', '0000000000000000') };
    const input = { eni: [eni('eni-1', '10.0.0.5', { description: 'ELB app/web/50dc6c495c0c9188' })], alb: [sameName, alb] };
    expect(resolve(input, '10.0.0.5')).toEqual({ owner: expect.objectContaining({
      kind: 'alb', resourceId: 'web', arn: alb.arn, confidence: 'observed', eniId: 'eni-1' }) });
    expect(resolve({ ...input, alb: [sameName] }, '10.0.0.5')).toEqual({ reason: 'owner_not_synced', eniId: 'eni-1' });
  });

  it('strips the Lambda ENI UUID suffix so hyphenated function names match exactly', () => {
    const fn = { resource_id: 'orders-api-handler', region: R, arn: 'arn:aws:lambda:ap-northeast-2:1:function:orders-api-handler' };
    const input = { lambda: [fn, { resource_id: 'orders-api', region: R }], eni: [eni('eni-l', '10.0.1.9', {
      interface_type: 'lambda', description: 'AWS Lambda VPC ENI-orders-api-handler-0b5a7a0c-1f9b-4c3e-9a51-6c0a1d2e3f40' })] };
    // Hyperplane ENIs can serve every function with the same subnet/SG set: the creator name is inferred.
    expect(resolve(input, '10.0.1.9')).toEqual({ owner: expect.objectContaining({
      kind: 'lambda', resourceId: 'orders-api-handler', confidence: 'inferred' }) });
  });

  it('resolves VPC endpoint and NAT ENIs by the id in their description', () => {
    const input = {
      vpc_endpoint: [{ resource_id: 'vpce-0123456789abcdef0', region: R }],
      nat_gateway: [{ resource_id: 'nat-0123456789abcdef0', region: R, name: 'egress' }],
      eni: [
        eni('eni-e', '10.0.2.1', { interface_type: 'vpc_endpoint', description: 'VPC Endpoint Interface vpce-0123456789abcdef0' }),
        eni('eni-n', '10.0.2.2', { interface_type: 'natGateway', description: 'Interface for NAT Gateway nat-0123456789abcdef0' }),
        eni('eni-x', '10.0.2.3', { interface_type: 'vpc_endpoint', description: 'VPC Endpoint Interface vpce-0fedcba987654321f' }),
      ],
    };
    expect(resolve(input, '10.0.2.1')).toEqual({ owner: expect.objectContaining({ kind: 'vpc_endpoint' }) });
    expect(resolve(input, '10.0.2.2')).toEqual({ owner: expect.objectContaining({ kind: 'nat_gateway', label: 'egress' }) });
    expect(resolve(input, '10.0.2.3')).toEqual({ reason: 'owner_not_synced', eniId: 'eni-x' });
  });

  describe('RDS (no DB name on the ENI)', () => {
    const rdsEni = eni('eni-r', '10.0.3.4', { requester_id: 'amazon-rds', description: 'RDSNetworkInterface',
      availability_zone: 'ap-northeast-2a', subnet_id: 'subnet-a' });
    const db = (id: string, cluster = '', zone = 'ap-northeast-2a') =>
      ({ resource_id: id, region: R, vpc_id: VPC, availability_zone: zone, db_cluster_identifier: cluster });

    it('infers the single DB placed in that VPC/AZ', () => {
      expect(resolve({ eni: [rdsEni], rds: [db('orders'), db('other', '', 'ap-northeast-2c')] }, '10.0.3.4'))
        .toEqual({ owner: expect.objectContaining({ kind: 'rds', resourceId: 'orders', confidence: 'inferred' }) });
    });

    it('infers the cluster when every DB in the AZ is a member of one synced cluster', () => {
      const input = { eni: [rdsEni], rds: [db('aurora-1', 'aurora'), db('aurora-2', 'aurora')],
        rds_cluster: [{ resource_id: 'aurora', region: R }] };
      expect(resolve(input, '10.0.3.4')).toEqual({ owner: expect.objectContaining({ kind: 'rds_cluster', resourceId: 'aurora' }) });
      expect(resolve({ ...input, rds: [db('aurora-1', 'aurora'), db('b', 'other')] }, '10.0.3.4'))
        .toEqual({ reason: 'owner_ambiguous', eniId: 'eni-r' });
      // Every DB names one cluster that the complete cluster read lacks: not synced, not ambiguous.
      expect(resolve({ ...input, rds_cluster: [] }, '10.0.3.4')).toEqual({ reason: 'owner_not_synced', eniId: 'eni-r' });
    });

    it('refuses to guess when an RDS Proxy shares the ENI subnet', () => {
      const proxy = { resource_id: 'p', region: R, vpc_id: VPC, vpc_subnet_ids: ['subnet-a'] };
      expect(resolve({ eni: [rdsEni], rds: [db('orders')], rds_proxy: [proxy] }, '10.0.3.4'))
        .toEqual({ reason: 'owner_ambiguous', eniId: 'eni-r' });
    });
  });

  it('attributes only the primary IP of an instance ENI to the instance', () => {
    const node = eni('eni-i', '10.0.4.10', { attached_instance_id: 'i-0abc', requester_managed: false,
      private_ip_addresses: [{ PrivateIpAddress: '10.0.4.10', Primary: true }, { PrivateIpAddress: '10.0.4.11', Primary: false }] });
    const input = { eni: [node], ec2: [{ resource_id: 'i-0abc', region: R, name: 'node-a' }] };
    expect(resolve(input, '10.0.4.10')).toEqual({ owner: expect.objectContaining({ kind: 'ec2', label: 'node-a' }) });
    // A secondary IP (e.g. a VPC CNI pod IP) is not the instance.
    expect(resolve(input, '10.0.4.11')).toEqual({ reason: 'secondary_ip', eniId: 'eni-i' });
  });

  it('leaves ECS task ENIs to the ECS task map and unknown ENIs unresolved', () => {
    expect(resolve({ eni: [eni('eni-t', '10.0.5.1', { description: 'arn:aws:ecs:ap-northeast-2:1:attachment/abc' })] }, '10.0.5.1'))
      .toEqual({ reason: 'ecs_managed', eniId: 'eni-t' });
    expect(resolve({ eni: [eni('eni-u', '10.0.5.2', { interface_type: 'interface', requester_managed: true })] }, '10.0.5.2'))
      .toEqual({ reason: 'owner_unknown', eniId: 'eni-u' });
  });

  it('reads private_ip_addresses supplied as a JSON string', () => {
    const row = { ...eni('eni-s', '10.0.6.1', { attached_instance_id: 'i-1' }),
      private_ip_addresses: JSON.stringify([{ PrivateIpAddress: '10.0.6.2', Primary: false }]) };
    expect(resolve({ eni: [row], ec2: [{ resource_id: 'i-1', region: R }] }, '10.0.6.2'))
      .toEqual({ reason: 'secondary_ip', eniId: 'eni-s' });
  });

  it('reports an incomplete owner read instead of claiming the owner is not synced', () => {
    const input = { eni: [eni('eni-n', '10.0.7.1', { interface_type: 'natGateway', description: 'Interface for NAT Gateway nat-0123456789abcdef0' })] };
    expect(eniOwnerResolver(input, new Set(['nat_gateway'])).resolve(R, VPC, '10.0.7.1'))
      .toEqual({ reason: 'owner_inventory_incomplete', eniId: 'eni-n' });
    expect(eniOwnerResolver(input).resolve(R, VPC, '10.0.7.1')).toEqual({ reason: 'owner_not_synced', eniId: 'eni-n' });
  });

  it('refuses RDS placement inference when the DB or proxy inventory is incomplete', () => {
    const rdsEni = eni('eni-r', '10.0.3.4', { requester_id: 'amazon-rds', availability_zone: 'ap-northeast-2a' });
    const input = { eni: [rdsEni], rds: [{ resource_id: 'orders', region: R, vpc_id: VPC, availability_zone: 'ap-northeast-2a' }] };
    for (const type of ['rds', 'rds_proxy'])
      expect(eniOwnerResolver(input, new Set([type])).resolve(R, VPC, '10.0.3.4'))
        .toEqual({ reason: 'owner_inventory_incomplete', eniId: 'eni-r' });
  });
});

describe('incomplete ENI reads', () => {
  it('reports incomplete instead of a single observed owner when the ENI list itself is cut', () => {
    const input = { eni: [eni('eni-1', '10.0.0.5', { description: 'ELB app/web/50dc6c495c0c9188' })],
      alb: [{ resource_id: 'web', region: R, arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/web/50dc6c495c0c9188' }] };
    expect(eniOwnerResolver(input, new Set(['eni'])).resolve(R, VPC, '10.0.0.5'))
      .toEqual({ reason: 'owner_inventory_incomplete', eniId: null });
    expect(eniOwnerResolver(input, new Set(['eni'])).resolve(R, VPC, '10.9.9.9'))
      .toEqual({ reason: 'owner_inventory_incomplete', eniId: null });
  });
});
