import { beforeEach, expect, it, vi } from 'vitest';
const aws = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { send = aws.send; },
  DescribeSecretCommand: class { constructor(public input: unknown) {} },
}));
import { currentCustomMcpSecretVersion } from './custom-mcp-secret';
beforeEach(() => { aws.send.mockReset(); delete process.env.INTEGRATIONS_SECRET_NAME; });
it('reads metadata for the exact row and returns only its current version', async () => {
  aws.send.mockResolvedValue({ VersionIdsToStages: { ['a'.repeat(32)]: ['AWSCURRENT'], ['b'.repeat(32)]: ['AWSPREVIOUS'] } });
  expect(await currentCustomMcpSecretVersion(7)).toBe('a'.repeat(32));
  expect(aws.send.mock.calls[0][0].input).toEqual({ SecretId: 'ops/awsops-v2/integrations/custom/7' });
  expect(aws.send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
});
it('makes no AWS call for an invalid ID', async () => {
  await expect(currentCustomMcpSecretVersion(-1)).rejects.toThrow('invalid integration id');
  expect(aws.send).not.toHaveBeenCalled();
});
it.each([{}, { ['a'.repeat(32)]: ['AWSPREVIOUS'] }, { ['a'.repeat(32)]: ['AWSCURRENT'], ['b'.repeat(32)]: ['AWSCURRENT'] }])(
  'fails closed on missing or ambiguous current versions', async VersionIdsToStages => {
    aws.send.mockResolvedValue({ VersionIdsToStages });
    await expect(currentCustomMcpSecretVersion(7)).rejects.toThrow('exactly one');
  });
it('does not accept an unreadable or absent operator-provisioned secret', async () => {
  aws.send.mockRejectedValue(new Error('ResourceNotFoundException'));
  await expect(currentCustomMcpSecretVersion(7)).rejects.toThrow('ResourceNotFound');
});
