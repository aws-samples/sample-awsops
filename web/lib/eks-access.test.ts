import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const stsSend = vi.fn();
const eksSend = vi.fn();
const targetSend = vi.fn();
const assumedClient = vi.fn();
const getAccount = vi.fn();
vi.mock('./accounts', () => ({ getAccount: (...args: unknown[]) => getAccount(...args) }));
vi.mock('./account-regions', () => ({ listScanScope: async () => [{ accountId: '222222222222', regions: ['*'] }] }));
vi.mock('./aws-assume', () => ({ assumedClient: (...args: unknown[]) => assumedClient(...args) }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = (...a: unknown[]) => stsSend(...a); },
  GetCallerIdentityCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-eks', () => ({
  EKSClient: class { send = (...a: unknown[]) => eksSend(...a); },
  DescribeAccessEntryCommand: class { constructor(public input: unknown) {} },
  DescribeClusterCommand: class { constructor(public input: unknown) {} },
}));

describe('eks-access', () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(async () => {
    stsSend.mockReset(); eksSend.mockReset();
    targetSend.mockReset();
    process.env.HOST_ACCOUNT_ID = '111111111111';
    process.env.AWS_REGION = 'ap-northeast-2';
    getAccount.mockReset().mockResolvedValue({
      accountId: '222222222222', enabled: true, isHost: false, region: 'us-east-1',
      roleName: 'TenantEksReader',
    });
    assumedClient.mockReset().mockImplementation(async (id: string) => ({ send: id === 'self' ? eksSend : targetSend }));
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

  it('discovers the member Access Entry for its registered role without asking for host identity', async () => {
    stsSend.mockRejectedValue(new Error('host identity must not be read'));
    targetSend.mockResolvedValue({ accessEntry: { type: 'STANDARD' } });
    const { hasAccessEntry } = await import('./eks-access');
    expect(await hasAccessEntry('arn:aws:eks:us-east-1:222222222222:cluster/shared')).toBe(true);
    expect(assumedClient).toHaveBeenCalledWith('222222222222', expect.anything(), { region: 'us-east-1' });
    expect(targetSend.mock.calls[0][0].input).toEqual({
      clusterName: 'shared', principalArn: 'arn:aws:iam::222222222222:role/TenantEksReader',
    });
    expect(eksSend).not.toHaveBeenCalled();
    expect(stsSend).not.toHaveBeenCalled();
  });

  it('directly describes a selected cluster without relying on a capped list', async () => {
    targetSend.mockResolvedValue({ cluster: { name: 'shared', endpoint: 'https://member.eks.amazonaws.com' } });
    const { describeEksCluster } = await import('./eks-access');
    expect(await describeEksCluster('arn:aws:eks:us-east-1:222222222222:cluster/shared'))
      .toMatchObject({ name: 'shared', endpoint: 'https://member.eks.amazonaws.com' });
    expect(targetSend.mock.calls[0][0].input).toEqual({ name: 'shared' });
    expect(eksSend).not.toHaveBeenCalled();
  });

  it('maps a missing target cluster to 404', async () => {
    targetSend.mockRejectedValue(Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' }));
    const { describeEksCluster } = await import('./eks-access');
    await expect(describeEksCluster('arn:aws:eks:us-east-1:222222222222:cluster/shared')).rejects.toMatchObject({ status: 404 });
  });

  it('propagates disabled accounts instead of returning unknown or falling back to host', async () => {
    getAccount.mockResolvedValue({ accountId: '222222222222', enabled: false });
    const { hasAccessEntry, onboardingGuide } = await import('./eks-access');
    const id = 'arn:aws:eks:us-east-1:222222222222:cluster/shared';
    await expect(hasAccessEntry(id)).rejects.toMatchObject({ status: 403 });
    await expect(onboardingGuide(id)).rejects.toMatchObject({ status: 403 });
    expect(targetSend).not.toHaveBeenCalled();
    expect(eksSend).not.toHaveBeenCalled();
  });

  it('uses the registered member role, raw name, and target region in cross-account guides', async () => {
    stsSend.mockRejectedValue(new Error('host identity must not be read'));
    const { onboardingGuide } = await import('./eks-access');
    const guide = await onboardingGuide('arn:aws:eks:us-east-1:222222222222:cluster/shared');
    for (const command of guide.commands.slice(0, 2)) {
      expect(command).toContain('--cluster-name shared --region us-east-1');
      expect(command).toContain('--principal-arn arn:aws:iam::222222222222:role/TenantEksReader');
      expect(command).not.toContain('--cluster-name arn:');
    }
    expect(guide.note).toContain('222222222222');
    expect(stsSend).not.toHaveBeenCalled();
  });

  it('grants member View plus a fixed nodes group, never AdminView or wildcard permissions', async () => {
    const { onboardingGuide } = await import('./eks-access');
    const guide = await onboardingGuide('arn:aws:eks:us-east-1:222222222222:cluster/shared');
    expect(guide.commands).toHaveLength(4);
    expect(guide.commands[0]).toContain('--type STANDARD --kubernetes-groups awsops:eks-readonly');
    expect(guide.commands[1]).toContain('--policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=cluster');
    expect(guide.commands.join('\n')).not.toMatch(/AmazonEKSAdminViewPolicy|AmazonEKSClusterAdminPolicy|secrets|"[*]"|"create"|"update"|"patch"|"delete"/);
    expect(assumedClient).not.toHaveBeenCalled();
    expect(stsSend).not.toHaveBeenCalled();
    expect(guide.note).toContain('preserving all existing Kubernetes groups');
    expect(guide.note).toContain('update-access-entry');
    expect(guide.note).toContain('disassociate-access-policy');
    expect(guide.note).toContain('AmazonEKSAdminViewPolicy');
    expect(guide.note).toContain('adding AmazonEKSViewPolicy does not revoke');
  });

  it('generates executable owner commands targeting the canonical context with a nodes-only manifest', async () => {
    const id = 'arn:aws:eks:us-east-1:222222222222:cluster/shared';
    const { onboardingGuide } = await import('./eks-access');
    const guide = await onboardingGuide(id);
    const directory = mkdtempSync(join(tmpdir(), 'eks-member-guide-'));
    try {
      // Local shell functions intercept every generated owner command. No AWS or
      // Kubernetes executable is launched, and the applied manifest is captured.
      const result = spawnSync('bash', ['-s'], {
        input: `set -e
aws() { printf '%s\\n' "$*" >> "$AWS_CALLS"; }
kubectl() { printf '%s\\n' "$*" > "$KUBE_ARGS"; cat > "$KUBE_MANIFEST"; }
${guide.commands.join('\n')}
`,
        encoding: 'utf8', timeout: 5000,
        env: {
          ...process.env,
          AWS_CALLS: join(directory, 'aws-calls'),
          KUBE_ARGS: join(directory, 'kubectl-args'),
          KUBE_MANIFEST: join(directory, 'nodes.json'),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const calls = readFileSync(join(directory, 'aws-calls'), 'utf8').trim().split('\n');
      expect(calls).toHaveLength(3);
      expect(calls[0]).toContain('--principal-arn arn:aws:iam::222222222222:role/TenantEksReader');
      expect(calls[0]).toContain('--kubernetes-groups awsops:eks-readonly');
      expect(calls[1]).toContain('cluster-access-policy/AmazonEKSViewPolicy');
      expect(calls[2]).toBe(`eks update-kubeconfig --name shared --region us-east-1 --alias ${id}`);
      expect(readFileSync(join(directory, 'kubectl-args'), 'utf8').trim()).toBe(`--context ${id} apply -f -`);
      const manifest = JSON.parse(readFileSync(join(directory, 'nodes.json'), 'utf8'));
      expect(manifest.items[0].rules).toEqual([{ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list', 'watch'] }]);
      expect(manifest.items[1].subjects[0].name).toBe('awsops:eks-readonly');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['', 'reader;echo injected', 'reader\n', 'reader/unsupported-path', 'r'.repeat(65), undefined])(
    'rejects invalid registered role names before CLI interpolation or discovery: %j', async roleName => {
      getAccount.mockResolvedValue({
        accountId: '222222222222', enabled: true, isHost: false, region: 'us-east-1', roleName,
      });
      const { onboardingGuide, hasAccessEntry } = await import('./eks-access');
      const id = 'arn:aws:eks:us-east-1:222222222222:cluster/shared';
      await expect(onboardingGuide(id)).rejects.toMatchObject({ status: 503 });
      await expect(hasAccessEntry(id)).rejects.toMatchObject({ status: 503 });
      expect(targetSend).not.toHaveBeenCalled();
      expect(stsSend).not.toHaveBeenCalled();
    },
  );

  it('still checks the current task-role principal for a host cluster', async () => {
    stsSend.mockResolvedValue({ Arn: 'arn:aws:sts::111111111111:assumed-role/awsops-v2-task/session' });
    eksSend.mockResolvedValue({ accessEntry: { type: 'STANDARD' } });
    const { hasAccessEntry } = await import('./eks-access');
    expect(await hasAccessEntry('shared')).toBe(true);
    expect(eksSend.mock.calls[0][0].input).toEqual({
      clusterName: 'shared', principalArn: 'arn:aws:iam::111111111111:role/awsops-v2-task',
    });
    expect(getAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['222222222222', 'us-east-1'],
    ['222222222222', 'ap-northeast-2'],
    ['111111111111', 'us-east-1'],
  ])('requires manual registration in target %s/%s even when host auto-registration is enabled', async (accountId, region) => {
    vi.stubEnv('EKS_AUTO_REGISTER', 'true');
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::111111111111:role/awsops-v2-task' });
    const { onboardingGuide } = await import('./eks-access');
    const guide = await onboardingGuide(`arn:aws:eks:${region}:${accountId}:cluster/shared`);
    expect(guide.note).toContain(`AWS account ${accountId}`);
    expect(guide.note).toContain(region);
    expect(guide.note).toContain('then click [조회 등록]');
    expect(guide.note).not.toMatch(/EventBridge|1~2|자동|Terraform|make configure|onboard_eks_clusters/);
  });

  it('preserves auto-registration and Terraform guidance for the host deployment-region alias', async () => {
    vi.stubEnv('EKS_AUTO_REGISTER', 'true');
    stsSend.mockResolvedValue({ Arn: 'arn:aws:iam::111111111111:role/awsops-v2-task' });
    const { onboardingGuide } = await import('./eks-access');
    const guide = await onboardingGuide('arn:aws:eks:ap-northeast-2:111111111111:cluster/shared');
    expect(guide.note).toContain('EventBridge');
    expect(guide.note).toContain('make configure');
  });
});
