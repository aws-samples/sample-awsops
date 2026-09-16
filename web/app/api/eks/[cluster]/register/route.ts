import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { registerCluster, unregisterCluster, isEnvCluster, setClusterAuth, type EksAuth } from '@/lib/eks-registry';
import { describeEksCluster, hasAccessEntry, onboardingGuide } from '@/lib/eks-access';
import { resolveEksCluster, EksScopeError } from '@/lib/eks-context';
import { assertEksRoleArn } from '@/lib/eks-role';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function failure(error: unknown) {
  return error instanceof EksScopeError
    ? json({ status: 'error', message: error.message }, error.status)
    : json({ status: 'error', message: 'EKS registration unavailable' }, 503);
}

// Aurora-stored auth (v1 kubeconfig parity): validated shapes only; token/roleArn are write-only.
const ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,128}$/;
function parseAuth(body: unknown): EksAuth | null | 'invalid' {
  if (!body || typeof body !== 'object') return null;
  const a = (body as { auth?: unknown }).auth;
  if (a == null) return null;
  if (typeof a !== 'object') return 'invalid';
  const o = a as Record<string, unknown>;
  if (o.mode === 'sa-token') {
    const token = typeof o.token === 'string' ? o.token.trim() : '';
    if (!token || token.length > 16384 || /\s/.test(token)) return 'invalid';
    return { mode: 'sa-token', token };
  }
  if (o.mode === 'assume-role') {
    const roleArn = typeof o.roleArn === 'string' ? o.roleArn.trim() : '';
    if (!ROLE_ARN_RE.test(roleArn)) return 'invalid';
    const externalId = typeof o.externalId === 'string' && o.externalId.trim() ? o.externalId.trim().slice(0, 256) : undefined;
    return { mode: 'assume-role', roleArn, ...(externalId ? { externalId } : {}) };
  }
  return 'invalid';
}

export async function POST(request: Request, { params }: { params: { cluster: string } }) {
  try {
    const user = await verifyUser(request.headers.get('cookie'));
    if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
    if (!(await isAdmin(user))) return json({ status: 'error', message: 'admin only' }, 403);
    const context = await resolveEksCluster(params.cluster, new URL(request.url).searchParams);
    // Direct, scoped DescribeCluster avoids a false 404 beyond a capped inventory page.
    // Member discovery and default tokens use the registered target role; its
    // Access Entry is checked here. No AWS resource is created or changed by this route.
    await describeEksCluster(context.id);
    let rawBody: unknown = null;
    try {
      // Bounded even for admins; comfortably covers the 16KB SA-token cap.
      rawBody = await readJsonBounded(request, 32_768);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json({ status: 'error', message: 'request body too large' }, 413);
      /* empty/invalid body OK — preserve the selected account's default signer */
    }
    const auth = parseAuth(rawBody);
    if (auth === 'invalid') return json({ status: 'error', message: 'invalid auth payload' }, 400);
    // Explicit saved auth selects its own Kubernetes identity, separately from discovery.
    if (auth) {
      if (auth.mode === 'assume-role') assertEksRoleArn(context, auth.roleArn);
      const ok = await setClusterAuth(context.id, user.sub, auth);
      if (!ok) return json({ status: 'error', message: 'registry storage unavailable' }, 503);
      return json({ registered: true, authMode: auth.mode }, 200);
    }
    const entry = await hasAccessEntry(context.id);
    if (entry !== true) {
      // Check before the env shortcut: a pending Terraform apply cannot claim access.
      return json({
        registered: false, cluster: context.id, access: entry === false ? 'no-entry' : 'unknown',
        guide: await onboardingGuide(context.id),
      }, 409);
    }
    if (isEnvCluster(context.id)) return json({ registered: true, managedBy: 'terraform' }, 200);
    // The TEXT key stores an ARN for member/non-default-region registrations.
    const ok = await registerCluster(context.id, user.sub);
    if (!ok) return json({ status: 'error', message: 'registry storage unavailable' }, 503);
    return json({ registered: true }, 200);
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request, { params }: { params: { cluster: string } }) {
  try {
    const user = await verifyUser(request.headers.get('cookie'));
    if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
    if (!(await isAdmin(user))) return json({ status: 'error', message: 'admin only' }, 403);
    const context = await resolveEksCluster(params.cluster, new URL(request.url).searchParams);
    if (isEnvCluster(context.id)) {
      return json({ status: 'error', message: 'Terraform(onboard_eks_clusters) 관할 — tfvars에서 제거하세요' }, 400);
    }
    const result = await unregisterCluster(context.id);
    if (result === 'deleted') return json({ unregistered: true }, 200);
    if (result === 'not-found') return json({ status: 'error', message: 'not registered' }, 404);
    return json({ status: 'error', message: '등록 저장소(Aurora)를 사용할 수 없습니다' }, 503);
  } catch (error) {
    return failure(error);
  }
}
