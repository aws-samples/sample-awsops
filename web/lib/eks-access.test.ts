import { describe, it, expect, vi, beforeEach } from 'vitest';

const stsSend = vi.fn();
const eksSend = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = (...a: unknown[]) => stsSend(...a); },
  GetCallerIdentityCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-eks', () => ({
  EKSClient: class { send = (...a: unknown[]) => eksSend(...a); },
  DescribeAccessEntryCommand: class { constructor(public input: unknown) {} },
}));

describe('eks-access', () => {
  beforeEach(async () => {
    stsSend.mockReset(); eksSend.mockReset();
    const { _resetForTests } = await import('./eks-access');
    _resetForTests();
  });

  it('getTaskRoleArn converts an assumed-role ARN to the IAM role ARN', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:sts::123456789012:assumed-role/awsops-v2-task/abc123' });
    const { getTaskRoleArn } = await import('./eks-access');
    expect(await getTaskRoleArn()).toBe('arn:aws:iam::123456789012:role/awsops-v2-task');
  });

  it('getTaskRoleArn passes a plain role ARN through and caches it', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::1:role/r' });
    const { getTaskRoleArn } = await import('./eks-access');
    await getTaskRoleArn();
    await getTaskRoleArn();
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it('hasAccessEntry: found → true', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::1:role/r' });
    eksSend.mockResolvedValue({ accessEntry: {} });
    const { hasAccessEntry } = await import('./eks-access');
    expect(await hasAccessEntry('c1')).toBe(true);
  });

  it('hasAccessEntry: ResourceNotFoundException → false', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::1:role/r' });
    eksSend.mockRejectedValue(Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }));
    const { hasAccessEntry } = await import('./eks-access');
    expect(await hasAccessEntry('c1')).toBe(false);
  });

  it('hasAccessEntry: other errors → null (unknown)', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::1:role/r' });
    eksSend.mockRejectedValue(new Error('throttled'));
    const { hasAccessEntry } = await import('./eks-access');
    expect(await hasAccessEntry('c1')).toBeNull();
  });

  it('onboardingGuide embeds the role ARN, cluster and region in both commands', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::1:role/awsops-v2-task' });
    const { onboardingGuide } = await import('./eks-access');
    const g = await onboardingGuide('my-c');
    expect(g.commands).toHaveLength(2);
    expect(g.commands[0]).toContain('create-access-entry');
    expect(g.commands[0]).toContain('--cluster-name my-c');
    expect(g.commands[0]).toContain('arn:aws:iam::1:role/awsops-v2-task');
    expect(g.commands[1]).toContain('associate-access-policy');
    expect(g.commands[1]).toContain('AmazonEKSAdminViewPolicy');
    expect(g.note).toContain('make configure');
  });
});
