import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getTaskRoleArn } from '@/lib/eks-access';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { onboardingInputError } from '@/lib/account-onboarding';
import { verifyAccountConnection } from '@/lib/account-connection';
import { registrationTargetAccountIds } from '@/lib/account-registration-scope';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return Response.json({ message: 'unauthenticated' }, { status: 401 });
  if (!(await isAdmin(user))) return Response.json({ message: 'forbidden: admin only' }, { status: 403 });

  try {
    const hostTaskRoleArn = await getTaskRoleArn();
    const match = hostTaskRoleArn.match(/^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9_+=,.@/-]+$/);
    if (!match || (process.env.HOST_ACCOUNT_ID && match[1] !== process.env.HOST_ACCOUNT_ID.trim())) {
      throw new Error('Host task role is unavailable');
    }
    const inventoryTaskRoleArn = process.env.INVENTORY_TASK_ROLE_ARN?.trim();
    if (inventoryTaskRoleArn &&
        inventoryTaskRoleArn.match(/^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9_+=,.@/-]+$/)?.[1] !== match[1]) {
      throw new Error('Inventory task role is unavailable');
    }
    const targetAccountIds = registrationTargetAccountIds(process.env.INVENTORY_TARGET_ACCOUNT_IDS, match[1]);
    return Response.json({
      hostAccountId: match[1],
      hostTaskRoleArn,
      region: process.env.AWS_REGION || 'ap-northeast-2',
      registrationEnabled: process.env.INVENTORY_HOST_ONLY !== 'true',
      ...(inventoryTaskRoleArn ? { inventoryTaskRoleArn } : {}),
      ...(targetAccountIds ? { registrationTargetAccountIds: targetAccountIds } : {}),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ message: 'Unable to resolve the host task role. Retry or contact the administrator.' }, { status: 503 });
  }
}

/** Diagnostic only: host-only collection never prevents a read-only IAM connection check. */
export async function POST(request: Request) {
  const reply = (body: unknown, status: number) => Response.json(body, {
    status, headers: { 'Cache-Control': 'private, no-store' },
  });
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return reply({ message: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return reply({ message: 'forbidden: admin only' }, 403);
  let raw: unknown;
  try {
    raw = await readJsonBounded(request, 4096);
  } catch (error) {
    return reply({ message: 'Invalid connection check input' }, error instanceof BodyTooLargeError ? 413 : 400);
  }
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (typeof body.accountId !== 'string' || typeof body.region !== 'string' ||
      typeof body.externalId !== 'string' || typeof body.firstParty !== 'boolean') {
    return reply({ message: 'Invalid connection check input' }, 400);
  }
  const input = {
    accountId: body.accountId.trim(), region: body.region.trim(),
    externalId: body.externalId.trim(), firstParty: body.firstParty,
  };
  const hostAccountId = (process.env.HOST_ACCOUNT_ID || '').trim();
  const inputError = onboardingInputError({ ...input, profile: '' });
  if (inputError || input.accountId === hostAccountId) {
    return reply({ message: inputError || 'The host account is already connected' }, 400);
  }
  if (!/^\d{12}$/.test(hostAccountId)) return reply({ message: 'Host account configuration is unavailable' }, 503);
  let targetAccountIds: string[] | undefined;
  try {
    targetAccountIds = registrationTargetAccountIds(process.env.INVENTORY_TARGET_ACCOUNT_IDS, hostAccountId);
  } catch {
    return reply({ message: 'Deployment account scope is unavailable' }, 503);
  }
  const diagnostic = await verifyAccountConnection(input, {
    hostAccountId, registrationEnabled: process.env.INVENTORY_HOST_ONLY !== 'true' &&
      (!targetAccountIds || targetAccountIds.includes(input.accountId)),
  });
  // Only the typed, bounded diagnostic is logged; never provider errors or the input body.
  console.info(JSON.stringify({ event: 'account_connection_check', ...diagnostic }));
  const status = diagnostic.verified ? 200
    : diagnostic.code === 'timeout' ? 504
    : ['access_denied', 'identity_mismatch'].includes(diagnostic.code) ? 400 : 503;
  return reply({ ok: diagnostic.verified, diagnostic }, status);
}
