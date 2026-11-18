import { expect, it } from 'vitest';
import { podBindings, inventoryOwners } from './adapters';
import { buildEntityIndex, resolveEndpoint } from './identity';
import type { PodRow } from '../eks-resources';
import type { SourceEvidence } from './types';

const scope = { account: '111111111111', region: 'us-east-1', vpc: 'vpc-a' };
const evidence: SourceEvidence = {
  ...scope,
  id: 'eks-list',
  capturedAt: 2000,
  window: { start: 2000, end: 2000 },
  status: 'ok',
  complete: true,
  stale: false,
  retained: false,
};
it('admits point-in-time UID evidence and withholds historical or host-network attribution', () => {
  const pod = {
    name: 'orders',
    namespace: 'shop',
    uid: 'u1',
    status: 'Running',
    podIPs: ['10.0.0.1', 'fd00::1'],
  } as PodRow;
  const build = (p: PodRow) =>
    buildEntityIndex(podBindings([p], 'arn:aws:eks:us-east-1:111111111111:cluster/shop', evidence), []);
  const claim = { ...scope, ip: 'fd00::1', window: evidence.window };
  expect(resolveEndpoint(claim, build(pod)).status).toBe('matched');
  expect(resolveEndpoint({ ...claim, window: { start: 1000, end: 2000 } }, build(pod)).status).toBe('ambiguous');
  expect(resolveEndpoint(claim, build({ ...pod, hostNetwork: true })).status).toBe('context');
});
it('retains the ENI resolver uncertainty and excludes other accounts', () => {
  const eni = {
    resource_id: 'eni-a',
    region: scope.region,
    account_id: scope.account,
    vpc_id: scope.vpc,
    private_ip_address: '10.0.0.1',
    attached_instance_id: 'i-a',
  };
  const ec2 = { resource_id: 'i-a', account_id: scope.account, region: scope.region };
  const owner = inventoryOwners(scope, { eni: [eni], ec2: [ec2] }, new Set());
  expect(owner('10.0.0.1')).toMatchObject({ status: 'context', owner: { kind: 'ec2', confidence: 'observed' } });
  expect(
    inventoryOwners(scope, { eni: [eni], ec2: [{ ...ec2, account_id: '222222222222' }] }, new Set())('10.0.0.1'),
  ).toMatchObject({ reason: 'owner_not_synced' });
  expect(inventoryOwners(scope, { eni: [eni] }, new Set(['eni']))('10.0.0.1')).toMatchObject({ status: 'ambiguous' });
});
