// Cross-account credential helper for the web BFF. Mirrors agent/lambda/cross_account.py:
// STS AssumeRole of the target account's AWSopsReadOnlyRole. ExternalId is OPTIONAL (ADR-011
// amended 2026-06-26): 1st-party accounts (trust pins this task-role ARN) omit it; 3rd-party
// supply it. ARN-validated, 50-min in-memory cache. Host/self → the task role's own creds (null).
// Read-only; never persists creds.
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getAccount } from '@/lib/accounts';
import { currentAccountId } from '@/lib/account';

export interface AssumedCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

const ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;
const TTL_MS = 50 * 60 * 1000; // 50 min
const MAX_CACHE = 100;
const cache = new Map<string, { creds: AssumedCreds; exp: number }>(); // key = arn|externalId

let _sts: STSClient | null = null;
const sts = (): STSClient => (_sts ??= new STSClient({ region: process.env.AWS_REGION || 'ap-northeast-2' }));

/** Temp creds for a target account, or null when the account is the host (use the task role directly). */
export async function credsForAccount(accountId: string | null | undefined): Promise<AssumedCreds | null> {
  if (!accountId || accountId === 'self') return null;
  if (accountId === currentAccountId()) return null; // host → own creds, no AssumeRole

  const acct = await getAccount(accountId);
  if (!acct) throw new Error(`aws-assume: unknown account ${accountId}`);
  if (acct.isHost) return null;
  // ExternalId is OPTIONAL (ADR-011 amended 2026-06-26): 1st-party accounts whose target trust
  // policy pins this task-role ARN omit it; 3rd-party supply it (and the trust enforces it).

  const arn = `arn:aws:iam::${accountId}:role/${acct.roleName}`;
  if (!ARN_RE.test(arn)) throw new Error(`aws-assume: invalid role ARN ${arn}`);

  const key = `${arn}|${acct.externalId ?? ''}`; // empty segment when no ExternalId — distinct from a value
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.creds;

  const out = await sts().send(new AssumeRoleCommand({
    RoleArn: arn,
    RoleSessionName: 'awsops-web',
    ...(acct.externalId ? { ExternalId: acct.externalId } : {}),
    DurationSeconds: 3600,
  }));
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error(`aws-assume: empty credentials for ${accountId}`);
  }
  const creds: AssumedCreds = {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
  if (cache.size >= MAX_CACHE) {
    // evict the oldest entry (Map preserves insertion order) — bounded LRU, not a full flush.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { creds, exp: Date.now() + TTL_MS });
  return creds;
}

/** Build an SDK client scoped to `accountId` (assumed creds) or the host (default creds). */
export async function assumedClient<T>(
  accountId: string | null | undefined,
  Ctor: new (cfg: Record<string, unknown>) => T,
  cfg: Record<string, unknown> = {},
): Promise<T> {
  const creds = await credsForAccount(accountId);
  return creds ? new Ctor({ ...cfg, credentials: creds }) : new Ctor({ ...cfg });
}
