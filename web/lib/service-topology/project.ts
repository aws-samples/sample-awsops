import { buildEntityIndex, resolveEndpoint } from './identity';
import type { Binding, EndpointClaim, SourceEvidence } from './types';

export interface PeerObservation {
  id: string;
  sourceId: string;
  local: EndpointClaim;
  remote: EndpointClaim;
}

/** Project row/side records only after arbitration. An unbound endpoint stays observation-local.
 * No cross-vantage addition of measurement values and no inferred call direction. */
export function projectPeers(
  observations: readonly PeerObservation[],
  bindings: readonly Binding[],
  vetoes: readonly SourceEvidence[],
) {
  const index = buildEntityIndex(bindings, vetoes);
  const entities = new Map<string, Set<string>>(),
    peers = new Map<string, Set<string>>();
  const endpoint = (o: PeerObservation, side: 'local' | 'remote', ref: string) => {
    const resolution = resolveEndpoint(o[side], index);
    const id = resolution.entityId ?? JSON.stringify(['endpoint', o.sourceId, o.id, side]);
    const refs = entities.get(id) ?? new Set();
    refs.add(ref);
    entities.set(id, refs);
    return { id, resolution };
  };
  const rows = observations.map((o) => {
    const ref = JSON.stringify([o.sourceId, o.id]);
    const local = endpoint(o, 'local', ref),
      remote = endpoint(o, 'remote', ref);
    const pair = JSON.stringify([local.id, remote.id].sort());
    const refs = peers.get(pair) ?? new Set();
    refs.add(ref);
    peers.set(pair, refs);
    return { ref, local, remote };
  });
  return { entities, peers, rows };
}
