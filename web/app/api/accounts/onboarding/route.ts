import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getTaskRoleArn } from '@/lib/eks-access';
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
