// Fleet-wide EKS cluster listing for name uniqueness (trace joins) and EKS scope derivation (client-safe).
// One `/api/eks?accounts=<id>&regions=__all__` per enabled registered account from `GET /api/accounts` (host as
// `self`), merged: a single all-account request is capped at 12 account×region targets server-side (eks-scope.ts
// TARGET_CAP, no registrations passed) and truncates on a real fleet. `__all__` covers only an account's configured
// (and, for wildcard scans, registered/home) regions, so `GET /api/eks/registrations` is read too: the uniqueness set
// (`names`) is the listed clusters ∪ every registered cluster, while `clusters` (scope derivation, vetoes) stays the
// listed set. Fail closed: any failed / errored / truncated / malformed listing (parseFleet) or registrations read,
// an aborted signal, or a failed or malformed `/api/accounts` body (any row without a 12-digit `accountId` or a
// boolean `enabled`) marks it incomplete.
import { ALL_REGIONS } from './account-context';
import { hostAccountOf } from './host-account';

export interface FleetCluster { id: string; name: string; arn?: string; accountId?: string; region?: string; access?: string }
export interface Fleet {
  /** Listed clusters (scope derivation and vetoes). */
  clusters: FleetCluster[];
  /** Trace-join uniqueness set: listed ∪ registered cluster ids, one per cluster (account|region|name). */
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
export const fleetUrl = (account: string) => `/api/eks?${new URLSearchParams({ accounts: account, regions: ALL_REGIONS })}`;
export const REGISTRATIONS_URL = '/api/eks/registrations';

interface Registered { id: string; name: string; accountId: string; region: string }
/** `/api/eks/registrations` body → registered clusters; null (fleet incomplete) on any malformed shape. */
export function parseRegistrations(body: unknown): Registered[] | null {
  if (!record(body) || body.truncated === true || body.status === 'error') return null; // a capped registry proves nothing
  const list = Array.isArray(body.clusters) ? body.clusters : null;
  if (!list || !list.every((c) => record(c) && nonempty(c.id) && nonempty(c.name)
    && typeof c.accountId === 'string' && /^(?:self|\d{12})$/.test(c.accountId)
    && typeof c.region === 'string' && REGION_RE.test(c.region))) return null;
  return (list as Record<string, string>[]).map((c) => ({ id: c.id, name: c.name, accountId: c.accountId, region: c.region }));
}

const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const ARN_RE = /^arn:aws(?:-[a-z0-9-]+)?:eks:([a-z0-9-]+):(\d{12}):cluster\/[\w-]+$/;
/** The reason-less all-region discovery note the server adds for a wildcard-scan account (the only tolerated error). */
const isDiscoveryNote = (e: unknown): e is { accountId: string } => record(e) && e.reason === undefined && e.region === ALL_REGIONS
  && typeof e.accountId === 'string' && /^(?:self|\d{12})$/.test(e.accountId);
/** A fully validated listing row: id, name, region, access and a 12-digit owning account that any ARN agrees with. */
function validRow(c: unknown): c is Record<string, string> {
  if (!record(c) || !nonempty(c.id) || !nonempty(c.name) || !nonempty(c.access)
    || typeof c.region !== 'string' || !REGION_RE.test(c.region)
    || typeof c.accountId !== 'string' || !/^\d{12}$/.test(c.accountId)) return false;
  for (const arn of [c.id.startsWith('arn:') ? c.id : null, c.arn === undefined ? null : c.arn]) {
    if (arn === null) continue;
    const m = typeof arn === 'string' ? ARN_RE.exec(arn) : null;
    if (!m || m[1] !== c.region || m[2] !== c.accountId) return false;
  }
  return true;
}

/**
 * One listing body → clusters/names. Fail closed: a malformed, truncated or reasoned-error listing, a non-array
 * `errors`, any error entry other than the discovery note, or any cluster row that is not fully valid (validRow)
 * marks it incomplete, since the fleet proves trace-name uniqueness and scopes pod bindings.
 */
export function parseFleet(body: unknown): Fleet {
  if (!record(body) || !Array.isArray(body.clusters) || !body.clusters.every(validRow)) return INCOMPLETE_FLEET();
  if (body.errors !== undefined && !Array.isArray(body.errors)) return INCOMPLETE_FLEET();
  const errors: unknown[] = Array.isArray(body.errors) ? body.errors : [];
  const clusters: FleetCluster[] = (body.clusters as Record<string, string>[]).map((c) => ({
    id: c.id, name: c.name, ...(nonempty(c.arn) ? { arn: c.arn } : {}), accountId: c.accountId, region: c.region, access: c.access,
  }));
  const incomplete = body.truncated === true || body.status === 'error' || !errors.every(isDiscoveryNote);
  // The server's note names the wildcard account (`self` for the host, else its 12-digit id).
  const wildcard = [...new Set(errors.filter(isDiscoveryNote).map((e) => e.accountId))].sort();
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

/** Merged per-account fleet listing plus the registry (bounded concurrency, shared signal). Listed clusters deduped by
 *  ARN, else id; the uniqueness set adds every registered cluster not already listed (same account|region|name). */
export async function readFleet(accountsBody: unknown, signal: AbortSignal): Promise<Fleet> {
  const accounts = fleetAccounts(accountsBody);
  if (!accounts) return INCOMPLETE_FLEET();
  const parts: Fleet[] = new Array(accounts.length);
  let registered: Registered[] | null = null;
  // The registrations read is one more task in the same FLEET_CONCURRENCY budget.
  const tasks = [...accounts.map((account, i) => async () => {
    parts[i] = await fetch(fleetUrl(account), { signal })
      .then((r) => (r.ok ? r.json() : null)).then(parseFleet).catch(INCOMPLETE_FLEET);
  }), async () => {
    registered = await fetch(REGISTRATIONS_URL, { signal })
      .then((r) => (r.ok ? r.json() : null)).then(parseRegistrations).catch(() => null);
  }];
  let next = 0;
  const lane = async () => { for (let i = next++; i < tasks.length; i = next++) await tasks[i](); };
  await Promise.all(Array.from({ length: Math.min(FLEET_CONCURRENCY, tasks.length) }, lane));
  const clusters: FleetCluster[] = [];
  const seen = new Set<string>();
  for (const c of parts.flatMap((p) => p.clusters)) {
    const key = c.arn ?? c.id;
    if (!seen.has(key)) { seen.add(key); clusters.push(c); }
  }
  // `self` and the host's numeric id name the same account (listings report numeric ids; the registry reports
  // `self` when the server has no HOST_ACCOUNT_ID). Without a known host id only `self` itself is the host.
  const hostId = hostAccountOf(accountsBody);
  const account = (id: string | undefined) => (id === 'self' || (hostId !== null && id === hostId) ? 'host' : id);
  const identity = (c: { accountId?: string; region?: string; name: string }) => `${account(c.accountId)}|${c.region}|${c.name}`;
  const known = new Set(clusters.map(identity));
  const names = clusters.map((c) => c.id);
  for (const r of (registered ?? []) as Registered[]) {
    if (!known.has(identity(r))) { known.add(identity(r)); names.push(r.id); }
  }
  return { clusters, names, incomplete: signal.aborted || registered === null || parts.some((p) => p.incomplete),
    wildcard: [...new Set(parts.flatMap((p) => p.wildcard))].sort() };
}
