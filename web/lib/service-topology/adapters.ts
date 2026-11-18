import { eniOwnerResolver, type EniOwnerInput, type EniUnresolved } from '../eni-owner';
import type { PodRow } from '../eks-resources';
import type { Binding, ScopeDomain, SourceEvidence, IdentityResolution } from './types';

// A Kubernetes list establishes placement at capture time. Pod creation time alone does
// not prove that the observed address was assigned throughout a preceding NFM window.
export function podBindings(rows: readonly PodRow[], clusterArn: string, evidence: SourceEvidence): Binding[] {
  const arn = /^arn:aws(?:-[a-z0-9-]+)?:eks:([a-z0-9-]+):(\d{12}):cluster\/([\w-]+)$/.exec(clusterArn);
  if (!arn || arn[1] !== evidence.region || arn[2] !== evidence.account || evidence.capturedAt == null) return [];
  return rows
    .filter((p) => p.status !== 'Succeeded' && p.status !== 'Failed')
    .flatMap((p) =>
      [...new Set([...(p.podIPs ?? []), ...(p.podIP ? [p.podIP] : [])])].map((ip) => ({
        account: evidence.account,
        region: evidence.region,
        vpc: evidence.vpc,
        ip,
        kind: 'pod' as const,
        nativeId: p.uid ?? '',
        label: p.namespace + '/' + p.name,
        authority: clusterArn,
        evidence,
        confidence: p.hostNetwork || !p.uid || !['Pending', 'Running'].includes(p.status) ? 'context' : 'observed',
        window: { start: evidence.capturedAt!, end: evidence.capturedAt! },
      })),
    );
}

const eniStatus: Record<EniUnresolved, IdentityResolution['status']> = {
  ecs_managed: 'context',
  secondary_ip: 'context',
  owner_not_synced: 'unmatched',
  owner_unknown: 'unmatched',
  owner_inventory_incomplete: 'ambiguous',
  owner_ambiguous: 'ambiguous',
};

/** A saved ENI record describes configuration at capture. Historical flow binding requires separate evidence. */
export function inventoryOwners(scope: ScopeDomain, input: EniOwnerInput, incomplete: ReadonlySet<string>) {
  const rows: EniOwnerInput = {};
  for (const kind of Object.keys(input) as (keyof EniOwnerInput)[]) {
    rows[kind] = input[kind]?.filter((r) => r.account_id === scope.account && r.region === scope.region);
  }
  const resolver = eniOwnerResolver(rows, incomplete);
  return (ip: string, vpc = scope.vpc) => {
    if (!scope.account || !scope.region || !vpc) return { status: 'unsupported' as const, reason: 'missing_scope' };
    const result = resolver.resolve(scope.region, vpc, ip);
    if (!result) return { status: 'unmatched' as const, reason: 'no_binding' };
    if ('reason' in result) return { status: eniStatus[result.reason], reason: result.reason, eniId: result.eniId };
    return { status: 'context' as const, reason: 'cached_configuration', owner: result.owner };
  };
}
