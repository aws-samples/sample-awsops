import { currentAccountId } from './account';
import { getAccount } from './accounts';
import { listScanScope } from './account-regions';
import { parseEksClusterId, qualifiedEksClusterId } from './eks-cluster-id';

export interface EksClusterContext {
  id: string;
  name: string;
  /** Host always uses "self"; qualified IDs still contain the actual numeric account. */
  accountId: string;
  region: string;
}

export class EksScopeError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'EksScopeError';
  }
}

const ACCOUNT_RE = /^(?:self|\d{12})$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

function selection(params: URLSearchParams, key: string, pattern: RegExp): string | undefined {
  const values = params.getAll(key);
  if (!values.length) return undefined;
  if (values.length !== 1 || /\s/.test(values[0]) || !pattern.test(values[0])) {
    throw new EksScopeError(`Invalid EKS ${key}`, 400);
  }
  return values[0];
}

/** Resolve scope before cache/auth lookups. A bare name is only a legacy host/default
 * registration; selecting any other account/region produces a distinct ARN key. */
export async function resolveEksCluster(id: string, params = new URLSearchParams()): Promise<EksClusterContext> {
  // Collection aliases must never silently turn a bare-name detail request into
  // a host/default-region read. Even matching singular/plural values are rejected.
  if (params.has('accounts') || params.has('regions')) {
    throw new EksScopeError('Single-cluster requests require singular account and region parameters', 400);
  }
  const parsed = parseEksClusterId(id);
  if (!parsed) throw new EksScopeError('Invalid EKS cluster identifier', 400);
  const account = selection(params, 'account', ACCOUNT_RE);
  const region = selection(params, 'region', REGION_RE);
  const host = currentAccountId();
  const deploymentRegion = process.env.AWS_REGION || 'ap-northeast-2';
  const canonicalAccount = (value: string) => value === host ? 'self' : value;
  if (parsed.accountId && account && canonicalAccount(parsed.accountId) !== canonicalAccount(account)) {
    throw new EksScopeError('Conflicting EKS account', 400);
  }
  if (parsed.region && region && parsed.region !== region) {
    throw new EksScopeError('Conflicting EKS region', 400);
  }
  const accountId = canonicalAccount(parsed.accountId ?? account ?? 'self');
  let targetRegion = parsed.region ?? region ?? deploymentRegion;
  if (accountId !== 'self') {
    try {
      const target = await getAccount(accountId);
      // Never accept a second, inconsistent host row as permission to use host credentials.
      if (!target?.enabled || target.isHost || target.accountId !== accountId) {
        throw new EksScopeError('EKS account is not registered or is disabled', 403);
      }
      targetRegion = parsed.region ?? region ?? target.region;
      const scope = (await listScanScope()).find(entry => entry.accountId === accountId);
      if (!scope || (!scope.regions.includes('*') && !scope.regions.includes(targetRegion))) {
        throw new EksScopeError('EKS region is not enabled for this account', 403);
      }
    } catch (error) {
      if (error instanceof EksScopeError) throw error;
      throw new EksScopeError('EKS account/region registry is unavailable', 503);
    }
  }
  if (!REGION_RE.test(targetRegion) || /\s/.test(targetRegion)) {
    throw new EksScopeError('Invalid EKS region', 400);
  }
  if (accountId === 'self' && targetRegion === deploymentRegion) {
    return { id: parsed.name, name: parsed.name, accountId, region: targetRegion };
  }
  const numericAccount = accountId === 'self' ? host : accountId;
  if (!/^\d{12}$/.test(numericAccount)) throw new EksScopeError('Host account identity is unavailable', 503);
  return {
    id: qualifiedEksClusterId(parsed.name, numericAccount, targetRegion),
    name: parsed.name, accountId, region: targetRegion,
  };
}
