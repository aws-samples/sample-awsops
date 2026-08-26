import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getAccount, getHostAccount, validateAccountId } from '@/lib/accounts';
import { disableAccountRegion, listAccountRegions, upsertAccountRegion, validateRegion } from '@/lib/account-regions';
import { readJsonBounded } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

const err = (message: string, status: number) => Response.json({ status: 'error', message }, { status });

// account_regions is keyed by the concrete 12-digit account id. 'self' is the app-wide host alias
// (see account-context.ts), so resolve it to the host's real id before any lookup/write — this makes
// the documented "'self' or 12 digits" contract actually work for the host. Returns null when the id
// is neither a known host (for 'self') nor a valid 12-digit id.
async function resolveAccountId(raw: string): Promise<string | null> {
  if (raw === 'self') return (await getHostAccount())?.accountId ?? null;
  return validateAccountId(raw) ? raw : null;
}

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) return err('unauthenticated', 401);
  try {
    return Response.json({ regions: await listAccountRegions() });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);

  const body = (await readJsonBounded(request).catch(() => null)) as Record<string, unknown> | null;
  const region = String(body?.region ?? '').trim();

  const accountId = await resolveAccountId(String(body?.accountId ?? '').trim());
  if (!accountId) return err("accountId must be 'self' or 12 digits", 400);
  if (!validateRegion(region)) return err('region must be an AWS region id', 400);
  if (!(await getAccount(accountId))) return err('account not found', 404);

  try {
    await upsertAccountRegion(accountId, region);
    return Response.json({ ok: true });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function DELETE(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return err('unauthenticated', 401);
  if (!(await isAdmin(user))) return err('forbidden: admin only', 403);

  const url = new URL(request.url);
  const region = url.searchParams.get('region') || '';

  const accountId = await resolveAccountId(url.searchParams.get('accountId') || '');
  if (!accountId) return err("accountId must be 'self' or 12 digits", 400);
  if (!validateRegion(region)) return err('region must be an AWS region id', 400);
  if (!(await getAccount(accountId))) return err('account not found', 404);

  try {
    await disableAccountRegion(accountId, region);
    return Response.json({ ok: true });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}
