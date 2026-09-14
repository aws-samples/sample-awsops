import { expect, it } from 'vitest';
import cases from './fixtures/trace-queue-claims.json';
import { queueClaimMeta } from './trace-evidence';

it.each(cases)('rederives queue claims only from destination $destination', ({ destination, account, region }) => {
  const input = {
    destination, accountId: '444455556666', region: 'us-west-2',
    claimedAccountId: '777788889999', claimedRegion: 'eu-west-1',
    identityProvenance: 'aws_verified', infra_ref: 'inventory:queue',
    sourceId: 'tempo:1', environment: 'prod',
  };
  const result = queueClaimMeta(input);
  expect(result).toEqual({
    destination, claimedAccountId: account, claimedRegion: region,
    identityProvenance: 'telemetry_claim', sourceId: 'tempo:1', environment: 'prod',
  });
  expect(queueClaimMeta(result)).toEqual(result);
  expect(input.infra_ref).toBe('inventory:queue');
});

it('keeps absent destination and legacy caller-only metadata unclaimed', () => {
  expect(queueClaimMeta({ accountId: '444455556666', region: 'us-west-2' })).toEqual({
    claimedAccountId: null, claimedRegion: null, identityProvenance: 'telemetry_claim',
  });
});
