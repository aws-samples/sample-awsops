import { getAccount } from './accounts';
import { EksScopeError, type EksClusterContext } from './eks-context';

// Registered account roles use the same leaf-name form as credsForAccount.
// Validate before constructing an ARN that can appear in an operator CLI guide.
const ROLE_NAME_RE = /^[A-Za-z0-9_+=,.@-]{1,64}$/;
const ROLE_ARN_RE = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9_+=,.@/-]{1,128}$/;

export async function registeredEksRoleArn(context: EksClusterContext): Promise<string> {
  if (!/^\d{12}$/.test(context.accountId)) throw new EksScopeError('Invalid EKS member account', 403);
  let account;
  try {
    account = await getAccount(context.accountId);
  } catch {
    throw new EksScopeError('EKS account registry is unavailable', 503);
  }
  if (!account?.enabled || account.isHost || account.accountId !== context.accountId) {
    throw new EksScopeError('EKS account is not registered or is disabled', 403);
  }
  if (typeof account.roleName !== 'string' || !ROLE_NAME_RE.test(account.roleName) || /\s/.test(account.roleName)) {
    throw new EksScopeError('EKS registered account role is invalid', 503);
  }
  return `arn:aws:iam::${context.accountId}:role/${account.roleName}`;
}

/** Apply at registration, stored-auth reads, and immediately before signing so a
 * cached host/foreign-role override cannot send its credentials to a member API. */
export function assertEksRoleArn(context: EksClusterContext, roleArn: unknown): asserts roleArn is string {
  const match = typeof roleArn === 'string' && !/\s/.test(roleArn) ? ROLE_ARN_RE.exec(roleArn) : null;
  if (!match) throw new EksScopeError('Invalid EKS authentication role', 403);
  if (context.accountId !== 'self' && match[1] !== context.accountId) {
    throw new EksScopeError('EKS authentication role must belong to the selected account', 403);
  }
}
