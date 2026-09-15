import { randomUUID } from 'node:crypto';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { AccountConnectionCode, AccountConnectionDiagnostic } from './account-connection-diagnostics';

interface ConnectionInput {
  accountId: string;
  region: string;
  externalId: string;
  firstParty: boolean;
}

const REQUEST_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
// Match the registration verifier's endpoint; the submitted region is inventory metadata.
const STS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
function requestId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const metadata = (value as { $metadata?: { requestId?: unknown } }).$metadata;
  return typeof metadata?.requestId === 'string' && REQUEST_ID.test(metadata.requestId) ? metadata.requestId : null;
}

function failureCode(error: unknown): AccountConnectionCode {
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  switch (name) {
    case 'AccessDenied':
    case 'AccessDeniedException': return 'access_denied';
    case 'ExpiredToken':
    case 'ExpiredTokenException': return 'expired_credentials';
    case 'InvalidClientTokenId':
    case 'UnrecognizedClientException':
    case 'CredentialsProviderError': return 'invalid_credentials';
    case 'AbortError':
    case 'TimeoutError':
    case 'RequestTimeout': return 'timeout';
    case 'Throttling':
    case 'ThrottlingException':
    case 'TooManyRequestsException': return 'throttled';
    default: return 'aws_error';
  }
}

/** Three bounded STS reads. Never returns credentials, ExternalId, or provider error text. */
export async function verifyAccountConnection(
  input: ConnectionInput,
  settings: { hostAccountId: string; registrationEnabled: boolean },
): Promise<AccountConnectionDiagnostic> {
  const started = Date.now();
  const result: AccountConnectionDiagnostic = {
    checkId: randomUUID(), checkedAt: new Date(started).toISOString(), accountId: input.accountId,
    region: input.region, stsRegion: STS_REGION, roleArn: `arn:aws:iam::${input.accountId}:role/AWSopsReadOnlyRole`,
    hostTaskRoleArn: null, externalIdProvided: Boolean(input.externalId), stage: 'host_identity',
    code: 'host_identity_unavailable', awsRequestId: null, durationMs: 0,
    verified: false, registrationEnabled: settings.registrationEnabled,
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('Connection check deadline reached'), { name: 'TimeoutError' }));
    }, 15_000);
  });
  const bounded = <T>(request: Promise<T>) => Promise.race([request, timeout]);
  const options = { abortSignal: controller.signal };
  const host = new STSClient({ region: STS_REGION, maxAttempts: 2 });
  let target: STSClient | undefined;
  try {
    const identity = await bounded(host.send(new GetCallerIdentityCommand({}), options));
    const match = identity.Arn?.match(/^arn:aws:sts::(\d{12}):assumed-role\/([A-Za-z0-9_+=,.@-]+)\/[^/]+$/);
    result.awsRequestId = requestId(identity);
    if (!match || match[1] !== settings.hostAccountId || identity.Account !== settings.hostAccountId) return result;
    result.hostTaskRoleArn = `arn:aws:iam::${match[1]}:role/${match[2]}`;
    result.stage = 'assume_role';
    const assumed = await bounded(host.send(new AssumeRoleCommand({
      RoleArn: result.roleArn, RoleSessionName: 'awsops-connection-check', DurationSeconds: 900,
      ...(input.externalId ? { ExternalId: input.externalId } : {}),
    }), options));
    result.awsRequestId = requestId(assumed);
    const credentials = assumed.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      result.code = 'invalid_response';
      return result;
    }
    target = new STSClient({
      region: STS_REGION, maxAttempts: 2,
      credentials: {
        accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
      },
    });
    result.stage = 'get_caller_identity';
    const targetIdentity = await bounded(target.send(new GetCallerIdentityCommand({}), options));
    result.awsRequestId = requestId(targetIdentity);
    result.verified = targetIdentity.Account === input.accountId;
    result.code = result.verified ? 'verified' : 'identity_mismatch';
    return result;
  } catch (error) {
    result.code = failureCode(error);
    result.awsRequestId = requestId(error);
    return result;
  } finally {
    clearTimeout(timer!);
    host.destroy();
    target?.destroy();
    result.durationMs = Math.max(0, Date.now() - started);
  }
}
