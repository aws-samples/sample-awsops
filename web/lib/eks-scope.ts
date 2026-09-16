import { currentAccountId } from './account';
import { listAccounts } from './accounts';
import { listAccountRegions, listScanScope } from './account-regions';
import { parseEksClusterId } from './eks-cluster-id';
import { EksScopeError } from './eks-context';
import { getAllowedClusters } from './eks-registry';

export interface EksTarget { accountId: string; region: string }
export interface EksScopeIssue extends EksTarget { message: string }
export interface ScopedEksRegistration extends EksTarget { id: string; name: string }
const ACCOUNT_RE = /^(?:self|\d{12})$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const TARGET_CAP = 12;
const FLEET_CAP = 100;

class ScopeError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

function selection(params: URLSearchParams, plural: string, singular: string): string[] | '__all__' | undefined {
  if (params.getAll(plural).length > 1 || params.getAll(singular).length > 1) {
    throw new ScopeError(`Repeated ${plural} selection`, 400);
  }
  const raw = params.get(plural) ?? params.get(singular);
  if (params.has(plural) && params.has(singular) && params.get(plural) !== params.get(singular)) {
    throw new ScopeError(`Conflicting ${plural} selection`, 400);
  }
  if (raw === null) return undefined;
  if (raw === '__all__') return '__all__';
  const values = [...new Set(raw.split(','))];
  const valid = plural === 'accounts' ? ACCOUNT_RE : REGION_RE;
  if (values.length > 100 || values.some(value => !valid.test(value))) {
    throw new ScopeError(`Invalid ${plural} selection`, 400);
  }
  return values;
}

/** Resolve the UI scope once, with bounded account/region fan-out and no member→host fallback. */
export async function getEksScope(params: URLSearchParams, registrations?: Set<string>): Promise<{
  targets: EksTarget[]; truncated: boolean; errors?: EksScopeIssue[];
}> {
  const accounts = selection(params, 'accounts', 'account') ?? ['self'];
  const regions = selection(params, 'regions', 'region');
  const host = currentAccountId();
  const deploymentRegion = process.env.AWS_REGION || 'ap-northeast-2';
  const hostOnly = accounts !== '__all__' && accounts.every(id => id === 'self' || id === host);
  if (hostOnly && regions === undefined) {
    return { targets: [{ accountId: 'self', region: deploymentRegion }], truncated: false };
  }
  let registered: Awaited<ReturnType<typeof listAccounts>>;
  let enabledRegions: Awaited<ReturnType<typeof listAccountRegions>>;
  let scanScope: Awaited<ReturnType<typeof listScanScope>>;
  try {
    [registered, enabledRegions, scanScope] = await Promise.all([listAccounts(), listAccountRegions(), listScanScope()]);
  } catch {
    throw new ScopeError('EKS account/region registry is unavailable', 503);
  }
  const enabled = registered.filter(account => account.enabled && (!account.isHost || account.accountId === host));
  const canonical = (id: string) => id === host ? 'self' : id;
  const ids = accounts === '__all__'
    ? [...new Set(enabled.map(account => canonical(account.accountId)))]
    : [...new Set(accounts.map(canonical))];
  for (const id of ids) {
    if (id !== 'self' && !enabled.some(account => account.accountId === id)) {
      throw new ScopeError('EKS account is not registered or is disabled', 403);
    }
  }
  // Discovery cannot certify every AWS region from the configured-region table.
  // Known registrations extend wildcard scope, but discovery explicitly stays partial.
  // Fleet callers already have the complete registration set and need no discovery cap.
  const knownRegistrations = registrations ?? (regions === '__all__' ? await getAllowedClusters(true) : new Set<string>());
  const targets: EksTarget[] = [];
  const errors: EksScopeIssue[] = [];
  for (const accountId of ids) {
    const row = enabled.find(account => accountId === 'self' ? account.isHost || account.accountId === host : account.accountId === accountId);
    const actualId = row?.accountId ?? host;
    const configured = enabledRegions
      .filter(entry => entry.enabled && entry.accountId === actualId)
      .map(entry => entry.region)
      .filter(region => REGION_RE.test(region));
    const allowed = scanScope.find(entry => entry.accountId === actualId)?.regions ?? [];
    const wildcard = accountId === 'self' || allowed.includes('*');
    let selected = regions === '__all__'
      ? configured
      : regions ?? [row?.region || deploymentRegion];
    if (regions === '__all__' && wildcard) {
      const knownRegions = [...knownRegistrations].flatMap(id => {
        const parsed = parseEksClusterId(id);
        if (!parsed) return [];
        const owner = !parsed.accountId || parsed.accountId === host ? 'self' : parsed.accountId;
        return owner === accountId ? [parsed.region ?? deploymentRegion] : [];
      });
      selected = [...configured, ...knownRegions, row?.region || deploymentRegion];
      if (registrations === undefined) {
        errors.push({ accountId, region: '__all__',
          message: 'All-region discovery covers configured and registered regions only. Select an explicit region to query another region.' });
      }
    }
    for (const region of [...new Set(selected)]) {
      if (!REGION_RE.test(region)) throw new ScopeError('Registered EKS region is invalid', 503);
      if (accountId !== 'self' && !allowed.includes('*') && !allowed.includes(region)) {
        throw new ScopeError('EKS region is not enabled for this account', 403);
      }
      targets.push({ accountId, region });
    }
  }
  return {
    targets: registrations === undefined ? targets.slice(0, TARGET_CAP) : targets,
    truncated: registrations === undefined && targets.length > TARGET_CAP,
    ...(errors.length ? { errors } : {}),
  };
}

/** Fleet selection compares the complete identity, so an identical host name cannot match a member. */
export async function getScopedEksRegistrations(params: URLSearchParams): Promise<{
  clusters: ScopedEksRegistration[]; truncated: boolean;
}> {
  const allowed = await getAllowedClusters(true);
  const scope = await getEksScope(params, allowed);
  const host = currentAccountId();
  const region = process.env.AWS_REGION || 'ap-northeast-2';
  const selected = new Set(scope.targets.map(target => `${target.accountId}|${target.region}`));
  const clusters: ScopedEksRegistration[] = [];
  for (const id of allowed) {
    const parsed = parseEksClusterId(id);
    if (!parsed) continue;
    const accountId = !parsed.accountId || parsed.accountId === host ? 'self' : parsed.accountId;
    const clusterRegion = parsed.region ?? region;
    if (selected.has(`${accountId}|${clusterRegion}`)) {
      clusters.push({ id, name: parsed.name, accountId, region: clusterRegion });
    }
  }
  return { clusters: clusters.slice(0, FLEET_CAP), truncated: scope.truncated || clusters.length > FLEET_CAP };
}

/** Upstream messages may contain credentials; only application-owned scope errors are public. */
export function eksErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ScopeError || error instanceof EksScopeError ? error.message : fallback;
}

/** Preserve the existing status contract separately from the public-message trust boundary. */
export function eksErrorStatus(error: unknown, fallback = 500): number {
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
    return [400, 403, 404, 409, 503].includes(error.status) ? error.status : fallback;
  }
  return fallback;
}

export async function mapEksConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, 3) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await fn(items[index]);
    }
  }));
  return output;
}
