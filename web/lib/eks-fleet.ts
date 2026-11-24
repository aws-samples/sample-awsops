// Fleet-wide EKS cluster listing for name uniqueness (trace joins) and EKS scope derivation (client-safe).
// One `/api/eks?accounts=<id>&regions=__all__&includeGlobal=1` per enabled registered account from
// `GET /api/accounts` (host as `self`), merged: a single all-account request is capped at 12 account×region
// targets server-side (eks-scope.ts TARGET_CAP, no registrations passed) and truncates on a real fleet.
// Fail closed: any failed / reasoned-error / truncated request, an aborted signal, or a failed or malformed
// `/api/accounts` body (any row without a 12-digit `accountId` or a boolean `enabled`) marks it incomplete.
import { ALL_REGIONS } from './account-context';

export interface FleetCluster { id: string; name: string; arn?: string; accountId?: string; region?: string; access?: string }
export interface Fleet {
  clusters: FleetCluster[];
  names: string[];
  incomplete: boolean;
  /** Listed accounts (`self` or 12-digit) whose listing carried the reason-less all-region discovery note: their
   *  wildcard scan covers configured/registered/home regions only, so other regions may hold unlisted clusters. */
  wildcard: string[];
}

const FLEET_CONCURRENCY = 4;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export const INCOMPLETE_FLEET = (): Fleet => ({ clusters: [], names: [], incomplete: true, wildcard: [] });

/** Per-account fleet listing URL (one account per request keeps it under the server's 12-target cap). */
export const fleetUrl = (account: string) =>
  `/api/eks?${new URLSearchParams({ accounts: account, regions: ALL_REGIONS, includeGlobal: '1' })}`;

/** One listing body → clusters/names; any malformed, truncated or reasoned-error listing is incomplete. */
export function parseFleet(body: unknown): Fleet {
  const list = record(body) && Array.isArray(body.clusters) ? body.clusters : null;
  if (!list || !list.every((c) => record(c) && nonempty(c.name))) return INCOMPLETE_FLEET();
  const clusters = (list as Record<string, unknown>[]).map((c) => ({
    id: nonempty(c.id) ? c.id : String(c.name), name: String(c.name),
    ...(nonempty(c.arn) ? { arn: c.arn } : {}), ...(nonempty(c.accountId) ? { accountId: c.accountId } : {}),
    ...(nonempty(c.region) ? { region: c.region } : {}), ...(nonempty(c.access) ? { access: c.access } : {}),
  }));
  const errors = record(body) && Array.isArray(body.errors) ? body.errors : [];
  const incomplete = (record(body) && body.truncated === true) || errors.some((e) => record(e) && !!e.reason)
    || (record(body) && body.status === 'error');
  // The server's note names the wildcard account (`self` for the host, else its 12-digit id).
  const wildcard = [...new Set(errors.flatMap((e) => (record(e) && !e.reason && e.region === ALL_REGIONS
    && typeof e.accountId === 'string' && /^(?:self|\d{12})$/.test(e.accountId) ? [e.accountId] : [])))].sort();
  return { clusters, names: clusters.map((c) => c.id), incomplete, wildcard };
}

/** Accounts to list: the host as `self` plus every enabled member; null when the body is malformed. */
export function fleetAccounts(body: unknown): string[] | null {
  const rows = record(body) && Array.isArray(body.accounts) ? body.accounts : null;
  if (!rows || !rows.every((a) => record(a) && typeof a.accountId === 'string' && /^\d{12}$/.test(a.accountId)
    && typeof a.enabled === 'boolean')) return null;
  const members = (rows as Record<string, unknown>[]).filter((a) => a.isHost !== true && a.enabled === true).map((a) => String(a.accountId));
  return ['self', ...[...new Set(members)].sort()];
}

/** Merged per-account fleet listing (bounded concurrency, shared signal). Clusters deduped by ARN, else id. */
export async function readFleet(accountsBody: unknown, signal: AbortSignal): Promise<Fleet> {
  const accounts = fleetAccounts(accountsBody);
  if (!accounts) return INCOMPLETE_FLEET();
  const parts: Fleet[] = new Array(accounts.length);
  let next = 0;
  const lane = async () => {
    for (let i = next++; i < accounts.length; i = next++) {
      parts[i] = await fetch(fleetUrl(accounts[i]), { signal })
        .then((r) => (r.ok ? r.json() : null)).then(parseFleet).catch(INCOMPLETE_FLEET);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FLEET_CONCURRENCY, accounts.length) }, lane));
  const clusters: FleetCluster[] = [];
  const seen = new Set<string>();
  for (const c of parts.flatMap((p) => p.clusters)) {
    const key = c.arn ?? c.id;
    if (!seen.has(key)) { seen.add(key); clusters.push(c); }
  }
  return { clusters, names: clusters.map((c) => c.id), incomplete: signal.aborted || parts.some((p) => p.incomplete),
    wildcard: [...new Set(parts.flatMap((p) => p.wildcard))].sort() };
}
