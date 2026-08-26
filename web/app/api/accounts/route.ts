// Admin-gated registered-accounts CRUD. POST verifies the target by assuming its role and
// asserting GetCallerIdentity.Account === the submitted id (anti-spoof) BEFORE inserting.
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getPool } from '@/lib/db';
import { listAccounts, getAccount, validateAccountId, ensureHostRow } from '@/lib/accounts';
import { upsertAccountRegion } from '@/lib/account-regions';
import { readJsonBounded } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const err = (message: string, status: number) => Response.json({ status: 'error', message }, { status });

/** Assume the target's role and assert GetCallerIdentity.Account === accountId (anti-spoof).
 *  Shared by POST (pre-insert verify) and PATCH (v1-parity per-account re-test). Throws on failure. */
async function assumeAndVerify(accountId: string, roleName: string, externalId: string | null): Promise<void> {
  const sts = new STSClient({ region: REGION });
  const assumed = await sts.send(new AssumeRoleCommand({
    RoleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
    RoleSessionName: 'awsops-verify',
    ...(externalId ? { ExternalId: externalId } : {}),
    DurationSeconds: 900,
  }));
  const c = assumed.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error('assume returned no credentials');
  }
  const asTarget = new STSClient({
    region: REGION,
    credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
  });
  const ident = await asTarget.send(new GetCallerIdentityCommand({}));
  if (ident.Account !== accountId) {
    throw new Error(`verification failed: assumed account ${ident.Account} != ${accountId}`);
  }
}

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) return err('unauthenticated', 401);
  try {
    await ensureHostRow(); // seed the host row (HOST_ACCOUNT_ID) so the selector + __all__ fan-out always include host
    return Response.json({ accounts: await listAccounts() });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);

  const body = (await readJsonBounded(request).catch(() => null)) as Record<string, unknown> | null;
  const accountId = String(body?.accountId ?? '').trim();
  const alias = String(body?.alias ?? '').trim();
  const region = String(body?.region ?? '').trim() || REGION;
  const externalId = String(body?.externalId ?? '').trim();
  const firstParty = body?.firstParty === true;
  // Hard-pinned to match the host task-role IAM (Resource scoped to .../AWSopsReadOnlyRole).
  // A custom roleName would fail-closed on assume, so we do not honor body.roleName.
  const roleName = 'AWSopsReadOnlyRole';

  if (!validateAccountId(accountId)) return err('accountId must be 12 digits', 400);
  if (!alias) return err('alias is required', 400);
  // ExternalId is OPTIONAL only as an EXPLICIT per-account choice (ADR-011 amended 2026-06-26):
  // omitting it requires firstParty=true, asserting the target trust pins THIS task-role ARN
  // (not account-root/org/wildcard). Without an ExternalId AND without that explicit confirmation
  // we refuse — so 3rd-party accounts are never silently onboarded without the confused-deputy guard.
  if (!externalId && !firstParty) {
    return err('externalId required — or set firstParty=true to confirm a 1st-party account whose target trust pins the AWSops task-role ARN', 400);
  }

  // Test-assume the target role, then confirm the assumed identity IS the submitted account.
  try {
    await assumeAndVerify(accountId, roleName, externalId || null);
  } catch (e) {
    return err(`assume/verify failed: ${e instanceof Error ? e.message : String(e)}`, 400);
  }

  // Verified → insert. If the INSERT fails, surface 500 (never report verified without a row).
  try {
    await getPool().query(
      `INSERT INTO accounts (account_id, alias, region, is_host, role_name, external_id, enabled, status, last_verified_at)
       VALUES ($1, $2, $3, false, $4, $5, true, 'verified', now())
       ON CONFLICT (account_id) DO UPDATE SET
         alias = EXCLUDED.alias, region = EXCLUDED.region, role_name = EXCLUDED.role_name,
         external_id = EXCLUDED.external_id, status = 'verified', last_verified_at = now()`,
      [accountId, alias, region, roleName, externalId || null],
    );
    await upsertAccountRegion(accountId, region);
  } catch (e) {
    return err(`insert failed: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
  return Response.json({ ok: true, status: 'verified' });
}

/** v1-parity per-account connection re-test: re-assume the REGISTERED role/externalId (from the
 *  DB row, never client input) and stamp status/last_verified_at with the outcome. The host row is
 *  trivially verified — the task role's own credentials ARE the host, there is nothing to assume. */
export async function PATCH(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);

  const body = (await readJsonBounded(request).catch(() => null)) as Record<string, unknown> | null;
  const accountId = String(body?.accountId ?? '').trim();
  if (!validateAccountId(accountId)) return err('accountId must be 12 digits', 400);

  const acct = await getAccount(accountId);
  if (!acct) return err('account not registered', 404);

  if (acct.isHost) {
    try {
      await getPool().query(`UPDATE accounts SET status = 'verified', last_verified_at = now() WHERE account_id = $1`, [accountId]);
    } catch { /* stamp is best-effort for the host */ }
    return Response.json({ ok: true, status: 'verified', host: true });
  }

  try {
    await assumeAndVerify(accountId, acct.roleName, acct.externalId);
    await getPool().query(`UPDATE accounts SET status = 'verified', last_verified_at = now() WHERE account_id = $1`, [accountId]);
    return Response.json({ ok: true, status: 'verified' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Record the failure so the table's status badge reflects reality (v1 showed test outcomes too).
    try {
      await getPool().query(`UPDATE accounts SET status = 'error' WHERE account_id = $1`, [accountId]);
    } catch { /* status stamp is best-effort */ }
    return Response.json({ ok: false, status: 'error', message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);

  const accountId = new URL(request.url).searchParams.get('accountId') || '';
  if (!validateAccountId(accountId)) return err('accountId must be 12 digits', 400);
  const acct = await getAccount(accountId);
  if (acct?.isHost) return err('cannot remove the host account', 400);
  try {
    await getPool().query('DELETE FROM accounts WHERE account_id = $1 AND is_host = false', [accountId]);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
  return Response.json({ ok: true });
}
