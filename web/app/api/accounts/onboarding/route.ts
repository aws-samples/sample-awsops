import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getTaskRoleArn } from '@/lib/eks-access';

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
    return Response.json({
      hostAccountId: match[1],
      hostTaskRoleArn,
      region: process.env.AWS_REGION || 'ap-northeast-2',
      registrationEnabled: process.env.INVENTORY_HOST_ONLY !== 'true',
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ message: 'Unable to resolve the host task role. Retry or contact the administrator.' }, { status: 503 });
  }
}
