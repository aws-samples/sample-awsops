import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getTaskRoleArn } from '@/lib/eks-access';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { onboardingInputError } from '@/lib/account-onboarding';
import { verifyAccountConnection } from '@/lib/account-connection';
import { registrationTargetAccountIds } from '@/lib/account-registration-scope';
import { getAccount } from '@/lib/accounts';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';
const PROBE_COOLDOWN_MS = 60_000;
const REGISTRY_LOOKUP_MS = 3_000;
let probeInFlight = false;
let nextProbeAt = 0;

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

/** Diagnostic only: approved targets can be checked without registering them. */
export async function POST(request: Request) {
  const reply = (body: unknown, status: number, headers: Record<string, string> = {}) => Response.json(body, {
    status, headers: { 'Cache-Control': 'private, no-store', ...headers },
  });
  const user = await verifyUser(request.headers.get('cookie'));
  const actorSub = typeof user?.sub === 'string' ? user.sub.trim() : '';
  if (!user || !actorSub || actorSub.length > 128) return reply({ message: 'unauthenticated' }, 401);
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
  const reject = (code: string, message: string, status: number, retryAfterSeconds?: number) => {
    const checkId = randomUUID();
    console.info(JSON.stringify({
      event: 'account_connection_rejected', checkId, actor_sub: actorSub,
      accountId: input.accountId, code,
    }));
    return reply({ message, code, checkId, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }, status,
      retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {});
  };
  let targetAccountIds: string[] | undefined;
  try {
    targetAccountIds = registrationTargetAccountIds(process.env.INVENTORY_TARGET_ACCOUNT_IDS, hostAccountId);
  } catch {
    return reject('scope_unavailable', 'Deployment account scope is unavailable', 503);
  }
  const now = Date.now();
  if (probeInFlight || now < nextProbeAt) {
    return reject(probeInFlight ? 'probe_in_flight' : 'probe_cooldown',
      'A connection check is already running or cooling down. Retry shortly.', 429,
      Math.max(1, Math.min(60, Math.ceil((nextProbeAt - now) / 1000))));
  }
  probeInFlight = true;
  nextProbeAt = now + PROBE_COOLDOWN_MS;
  try {
    const hostOnly = process.env.INVENTORY_HOST_ONLY === 'true';
    if (!targetAccountIds?.includes(input.accountId)) {
      let registered;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Account scope lookup timed out'));
            controller.abort();
          }, REGISTRY_LOOKUP_MS);
        });
        registered = await Promise.race([getAccount(input.accountId, controller.signal), timeout]);
      }
      catch {
        return reject('scope_unavailable', 'Deployment account scope is unavailable', 503);
      } finally {
        clearTimeout(timer);
      }
      if (registered?.accountId !== input.accountId || registered.enabled !== true || registered.isHost !== false) {
        return reject('target_not_configured', 'Connection checks require an enabled registered or deployment-approved target.', 409);
      }
    }
    const diagnostic = await verifyAccountConnection(input, {
      hostAccountId, registrationEnabled: !hostOnly && (!targetAccountIds || targetAccountIds.includes(input.accountId)),
    });
    // Attribute the safe diagnostic to its requesting admin; never log the request body.
    console.info(JSON.stringify({ event: 'account_connection_check', ...diagnostic, actor_sub: actorSub }));
    const status = diagnostic.verified ? 200
      : diagnostic.code === 'timeout' ? 504
      : ['access_denied', 'identity_mismatch'].includes(diagnostic.code) ? 400 : 503;
    return reply({ ok: diagnostic.verified, diagnostic }, status);
  } catch {
    return reject('check_failed', 'Connection check is unavailable', 503);
  } finally {
    probeInFlight = false;
  }
}
