import { verifyUser } from '@/lib/auth';
import { listAccounts } from '@/lib/accounts';
import { buildNetworkTopology } from '@/lib/network-topology';
import { readNetworkRows } from '@/lib/network-topology-read';
import { MAX_DETAIL_VPCS } from '@/lib/network-topology-types';

export const dynamic = 'force-dynamic';

const ACCOUNT = /^(\d{12}|self)$/;
const VPC_KEY = /^(\d{12}|self)\/[a-z]{2}(?:-[a-z]+)+-\d+\/vpc-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const invalid = () => reply({ status: 'error', message: 'invalid_request' }, 400);

/** Configuration-only cross-account network topology over central inventory. */
export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return reply({ status: 'error', message: 'unauthenticated' }, 401);
  const url = new URL(request.url);
  if (url.searchParams.getAll('accounts').length > 1 || url.searchParams.getAll('vpcs').length > 1) return invalid();
  const accountsParam = url.searchParams.get('accounts');
  const accounts = accountsParam === null || accountsParam === '__all__' ? '__all__' as const : accountsParam.split(',').filter(Boolean);
  const vpcs = (url.searchParams.get('vpcs') ?? '').split(',').filter(Boolean);
  if (accounts !== '__all__' && (!accounts.length || !accounts.every((a) => ACCOUNT.test(a)))) return invalid();
  if (vpcs.length > MAX_DETAIL_VPCS || !vpcs.every((v) => VPC_KEY.test(v))) return invalid();
  try {
    const registry = await listAccounts();
    const hostAccountId = registry.find((a) => a.isHost)?.accountId ?? null;
    const aliases = Object.fromEntries(registry.filter((a) => a.alias).map((a) => [a.accountId, a.alias]));
    // Keys may say `self`; the model keys VPCs by the real host account id.
    const selected = vpcs.map((v) => (v.startsWith('self/') && hostAccountId ? `${hostAccountId}${v.slice(4)}` : v));
    const { rows, truncated } = await readNetworkRows([...new Set(selected.map((v) => v.split('/')[2]))]);
    return reply(buildNetworkTopology(rows, { hostAccountId, aliases, truncated, selection: { accounts, vpcs: selected } }));
  } catch {
    return reply({ status: 'error', message: 'network_topology_unavailable' }, 503);
  }
}
