import { containsWindow, overlapsDomain, qualifyEvidence, validWindow } from './evidence';
import type { Binding, EndpointClaim, IdentityResolution, SourceEvidence } from './types';

function address(raw: string): string | null {
  if (/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(raw))
    return raw.split('.').every((n) => Number(n) <= 255) ? raw : null;
  if (!raw.includes(':') || !/^[a-f\d:.]+$/i.test(raw)) return null;
  try {
    return new URL('http://[' + raw + ']/').hostname.slice(1, -1);
  } catch {
    return null;
  }
}

export function buildEntityIndex(bindings: readonly Binding[], vetoes: readonly SourceEvidence[]) {
  const byAddress = new Map<string, Binding[]>();
  for (const item of bindings) {
    const ip = address(item.ip);
    if (!ip) continue;
    const same = byAddress.get(ip);
    if (same) same.push(item);
    else byAddress.set(ip, [item]);
  }
  return { byAddress, vetoes };
}

function key(b: Binding) {
  return JSON.stringify([b.kind, b.account, b.region, b.vpc, b.authority, b.nativeId]);
}

export function resolveEndpoint(claim: EndpointClaim, index: ReturnType<typeof buildEntityIndex>): IdentityResolution {
  const candidates = new Set<string>(),
    evidence = new Set<string>();
  const finish = (status: IdentityResolution['status'], reason: string | null): IdentityResolution => ({
    status,
    reason,
    entityId: status === 'matched' ? [...candidates][0] : null,
    candidateIds: [...candidates].sort(),
    evidenceIds: [...evidence].sort(),
  });
  const ip = address(claim.ip);
  if (!ip || !claim.account || !claim.region || !claim.vpc) return finish('unsupported', 'missing_scope_or_address');
  if (!validWindow(claim.window)) return finish('ambiguous', 'unverified_window');
  let blocked = false,
    observed = false;
  for (const veto of index.vetoes) {
    if (overlapsDomain(veto, claim)) {
      blocked = true;
      evidence.add(veto.id);
    }
  }
  for (const b of index.byAddress.get(ip) ?? []) {
    if (!overlapsDomain(b, claim)) continue;
    const qualified = qualifyEvidence(b.evidence, claim, claim.window);
    // Only a trusted binding with complete scope/time evidence may exclude a prior owner.
    if (
      qualified === 'qualified' &&
      validWindow(b.window) &&
      (b.window.end < claim.window.start || b.window.start > claim.window.end)
    )
      continue;
    evidence.add(b.evidence.id);
    if (
      !b.nativeId ||
      !b.authority ||
      b.account !== claim.account ||
      b.region !== claim.region ||
      b.vpc !== claim.vpc ||
      qualified !== 'qualified' ||
      !containsWindow(b.window, claim.window)
    )
      blocked = true;
    if (b.nativeId && b.authority) candidates.add(key(b));
    observed ||= b.confidence === 'observed';
  }
  if (candidates.size > 1) return finish('ambiguous', 'conflicting_owners');
  if (blocked) return finish('ambiguous', 'owner_inventory_incomplete');
  if (!candidates.size) return finish('unmatched', 'no_binding');
  return observed ? finish('matched', null) : finish('context', 'inferred_or_cached');
}

// A single snapshot can explain present placement without asserting historical IP ownership.
export function currentPodContext(claim: EndpointClaim, podLabel: string, index: ReturnType<typeof buildEntityIndex>) {
  const ip = address(claim.ip);
  if (
    !ip ||
    !claim.account ||
    !claim.region ||
    !claim.vpc ||
    !validWindow(claim.window) ||
    index.vetoes.some((v) => overlapsDomain(v, claim))
  )
    return null;
  const hits = (index.byAddress.get(ip) ?? []).filter((b) => overlapsDomain(b, claim));
  if (
    !hits.length ||
    hits.some(
      (b) =>
        b.kind !== 'pod' ||
        b.label !== podLabel ||
        !b.nativeId ||
        !b.authority ||
        b.confidence !== 'observed' ||
        qualifyEvidence(b.evidence, claim, b.window) !== 'qualified',
    )
  )
    return null;
  const ids = new Set(hits.map(key));
  return ids.size === 1 ? { id: key(hits[0]), binding: hits[0] } : null;
}
