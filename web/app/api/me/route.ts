import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  // isAdmin = Cognito group OR SSM email allowlist — a client-visible signal so UI can hide
  // admin-only controls accurately (write paths stay server-enforced regardless).
  const admin = await isAdmin(user);
  return Response.json({ sub: user.sub, email: user.email, groups: user.groups ?? [], isAdmin: admin });
}
