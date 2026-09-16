import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EKSClient, DescribeAccessEntryCommand, DescribeClusterCommand, type Cluster } from '@aws-sdk/client-eks';
import { assumedClient } from './aws-assume';
import { resolveEksCluster, EksScopeError, type EksClusterContext } from './eks-context';
import { parseEksClusterId } from './eks-cluster-id';
import { registeredEksRoleArn } from './eks-role';

// Access-entry awareness: host clusters trust the task role; member clusters
// trust their registered account role, matching the default Kubernetes signer.

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ARN_TTL_MS = 10 * 60 * 1000; // task-role ARN is effectively static; an IAM role swap (rare) self-heals within ≤10m (PR #36 r4)

let sts: STSClient | null = null;
let arnCache: { arn: string; at: number } | null = null;

export function _resetForTests() { sts = null; arnCache = null; }

/** Control-plane discovery uses the registered target role for members. */
async function targetClient(context: EksClusterContext): Promise<EKSClient> {
  try {
    return await assumedClient(context.accountId, EKSClient, { region: context.region });
  } catch (error) {
    throw discoveryError(error);
  }
}

function discoveryError(error: unknown): EksScopeError {
  if (error instanceof EksScopeError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'ResourceNotFoundException') return new EksScopeError('Unknown EKS cluster', 404);
  if (name === 'AccessDenied' || name === 'AccessDeniedException') {
    return new EksScopeError('EKS target discovery access denied', 403);
  }
  return new EksScopeError('EKS target discovery unavailable', 503);
}

/** Direct lookup: registration must work even beyond ListClusters' first page. */
export async function describeEksCluster(id: string): Promise<Cluster> {
  const context = await resolveEksCluster(id);
  try {
    const client = await targetClient(context);
    const { cluster } = await client.send(new DescribeClusterCommand({ name: context.name }));
    if (!cluster) throw new EksScopeError('Unknown EKS cluster', 404);
    return cluster;
  } catch (error) {
    throw discoveryError(error);
  }
}

/** Current task-role ARN (assumed-role STS ARN → IAM role ARN, v1 callerRole transform). */
export async function getTaskRoleArn(): Promise<string> {
  if (arnCache && Date.now() - arnCache.at < ARN_TTL_MS) return arnCache.arn;
  if (!sts) sts = new STSClient({ region: REGION });
  const { Arn = '' } = await sts.send(new GetCallerIdentityCommand({}));
  const m = Arn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//);
  const arn = m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : Arn;
  arnCache = { arn, at: Date.now() };
  return arn;
}

/** Does the cluster trust its default signing principal? null = couldn't determine. */
export async function hasAccessEntry(cluster: string): Promise<boolean | null> {
  const context = await resolveEksCluster(cluster);
  const memberPrincipal = context.accountId === 'self' ? undefined : await registeredEksRoleArn(context);
  const client = await targetClient(context);
  try {
    const principalArn = memberPrincipal ?? await getTaskRoleArn(); // host STS hiccups still degrade to unknown
    await client.send(new DescribeAccessEntryCommand({ clusterName: context.name, principalArn }));
    return true;
  } catch (e) {
    if (e instanceof Error && e.name === 'ResourceNotFoundException') return false;
    return null;
  }
}

export interface OnboardingGuide { commands: string[]; note: string }

/** v1-parity copy-paste onboarding guide with the role ARN and region filled in. */
export async function onboardingGuide(cluster: string): Promise<OnboardingGuide> {
  const context = await resolveEksCluster(cluster);
  const arn = context.accountId === 'self' ? await getTaskRoleArn() : await registeredEksRoleArn(context);
  // Only host/deployment-region registrations canonicalize to a bare name. The
  // host CloudTrail auto-registration and Terraform guidance do not cover ARN IDs.
  const targetAccount = parseEksClusterId(context.id)?.accountId;
  return {
    commands: [
      `aws eks create-access-entry --cluster-name ${context.name} --region ${context.region} --principal-arn ${arn} --type STANDARD`,
      `aws eks associate-access-policy --cluster-name ${context.name} --region ${context.region} --principal-arn ${arn} --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy --access-scope type=cluster`,
    ],
    note: targetAccount
      ? `Run these commands in AWS account ${targetAccount}, region ${context.region}, then click [조회 등록] (Register for query).`
      : (process.env.EKS_AUTO_REGISTER === 'true'
      ? '명령 실행 후 1~2분 내 자동으로 연결됩니다(EventBridge). 바로 확인하려면 [조회 등록]을 누르세요. 영구 온보딩(Terraform)은 make configure → onboard_eks_clusters 를 사용하세요.'
      : '명령 실행 후 [조회 등록]을 다시 누르세요. 영구 온보딩(Terraform)은 make configure → onboard_eks_clusters 를 사용하세요.'),
  };
}
