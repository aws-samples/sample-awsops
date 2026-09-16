import type { VpcConnectivity } from './vpc-connectivity-types';

export type VpcConnectionNode = {
  id: string; kind: 'vpc' | 'tgw' | 'peering' | 'unknown'; label: string;
  accountId: string | null; region: string | null; source: boolean; details: Record<string, string | null>;
};
export type VpcConnectionEdge = {
  id: string; source: string; target: string; kind: 'tgw' | 'peering'; label: string; recordId: string;
};
export type VpcConnectionGraph = {
  nodes: VpcConnectionNode[]; edges: VpcConnectionEdge[];
  omitted: { inactive: number; unresolved: number; capped: number };
};

type Gateway = VpcConnectivity['transitGateways'][number];
const key = (...parts: (string | null)[]) => JSON.stringify(parts);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Configuration relationships, not traffic directions, routing or transit reachability.
 * Counters count distinct records: inactive roots hide their entire groups; unresolved
 * includes withheld conflicts and explicit unknown peers; capped counts rejected paths.
 * These categories can overlap (an unknown peer's path can also exceed the display cap).
 */
export function buildVpcConnectionGraph(data: VpcConnectivity): VpcConnectionGraph {
  const { source } = data;
  const scoped = (kind: string, id: string) => key(kind, source.accountId, source.region, id);
  const nodes = new Map<string, VpcConnectionNode>(), edges = new Map<string, VpcConnectionEdge>();
  const inactive = new Set<string>(), unresolved = new Set<string>(), capped = new Set<string>();
  const origin: VpcConnectionNode = {
    id: key(source.ownerId ? 'vpc' : 'source', source.ownerId ?? source.accountId, source.region, source.vpcId),
    kind: 'vpc', label: source.name || source.vpcId, accountId: source.ownerId ?? source.accountId,
    region: source.region, source: true,
    details: { vpcId: source.vpcId, ownerId: source.ownerId, queryAccountId: source.accountId, cidr: source.cidr ?? null },
  };
  nodes.set(origin.id, origin);
  // Inspect every claim before admitting edges; no first/last duplicate can win.
  const claims = new Map<string, string>(), blocked = new Set<string>();
  function claim(record: string, signature: string) {
    if (claims.has(record) && claims.get(record) !== signature) blocked.add(record);
    else claims.set(record, signature);
  }
  function attachmentClaim(g: Gateway, r: Gateway | Gateway['peers'][number], identity: string) {
    claim(scoped('tgw', r.attachmentId), key(g.id, identity, r.state, r.routeTableId, r.associationState));
  }
  for (const p of data.peerings) {
    claim(scoped('peering', p.id), key(p.state, p.peer.vpcId, p.peer.accountId, p.peer.region, p.peer.cidr));
  }
  for (const g of data.transitGateways) {
    attachmentClaim(g, g, origin.id);
    for (const p of g.peers) attachmentClaim(g, p, key('vpc', p.accountId, source.region, p.vpcId));
  }
  blocked.forEach(id => unresolved.add(id));
  function eligible(record: string, state: string, active: string) {
    if (blocked.has(record)) return false;
    if (state !== active) { inactive.add(record); return false; }
    return true;
  }
  const attempted = new Set<string>();
  function admit(record: string, pathNodes: VpcConnectionNode[], pathEdges: VpcConnectionEdge[]) {
    if (attempted.has(record)) return;
    attempted.add(record);
    const extraNodes = new Set(pathNodes.filter(n => !nodes.has(n.id)).map(n => n.id)).size;
    const extraEdges = new Set(pathEdges.filter(e => !edges.has(e.id)).map(e => e.id)).size;
    if (nodes.size + extraNodes > 300 || edges.size + extraEdges > 500) { capped.add(record); return; }
    for (const node of pathNodes) {
      const prior = nodes.get(node.id);
      nodes.set(node.id, { ...(prior ?? node), details: { ...prior?.details, ...node.details } });
    }
    for (const edge of pathEdges) if (!edges.has(edge.id)) edges.set(edge.id, edge);
  }
  function peer(vpcId: string | null, accountId: string | null, region: string | null, record: string, recordId: string): VpcConnectionNode {
    const known = !!(vpcId && accountId && region);
    if (!known) unresolved.add(record);
    return {
      id: known ? key('vpc', accountId, region, vpcId) : key('unknown', record),
      kind: known ? 'vpc' : 'unknown', label: vpcId ?? recordId, accountId, region, source: false,
      details: { vpcId, ...(!known ? { reason: 'missing_identity' } : {}) },
    };
  }
  function edge(kind: VpcConnectionEdge['kind'], recordId: string, from: string, to: string, leg = ''): VpcConnectionEdge {
    return { id: key('edge', scoped(kind, recordId), leg), kind, recordId, source: from, target: to, label: recordId };
  }
  function gateway(g: Gateway, record: Gateway | Gateway['peers'][number] = g): VpcConnectionNode {
    return {
      id: scoped('tgw', g.id), kind: 'tgw', label: g.id, accountId: null, region: source.region, source: false,
      details: {
        transitGatewayId: g.id, queryAccountId: source.accountId,
        [`${record.attachmentId}.attachmentId`]: record.attachmentId,
        [`${record.attachmentId}.vpcId`]: 'vpcId' in record ? record.vpcId : source.vpcId,
        [`${record.attachmentId}.state`]: record.state,
        [`${record.attachmentId}.routeTableId`]: record.routeTableId,
        [`${record.attachmentId}.associationState`]: record.associationState,
      },
    };
  }
  const groups = [...data.transitGateways]
    .sort((a, b) => compare(key(a.id, a.attachmentId), key(b.id, b.attachmentId)))
    .filter(g => eligible(scoped('tgw', g.attachmentId), g.state, 'available'));
  // Reserve source TGW links and complete PCX paths before large peer expansions.
  for (const g of groups) {
    const hub = gateway(g), rootEdge = edge('tgw', g.attachmentId, origin.id, hub.id);
    admit(scoped('tgw', g.attachmentId), [origin, hub], [rootEdge]);
  }
  for (const p of [...data.peerings].sort((a, b) => compare(a.id, b.id))) {
    if (!eligible(scoped('peering', p.id), p.state, 'active')) continue;
    const connection: VpcConnectionNode = {
      id: scoped('peering', p.id), kind: 'peering', label: p.id, accountId: null, region: source.region, source: false,
      details: { peeringId: p.id, state: p.state, peerCidr: p.peer.cidr, queryAccountId: source.accountId },
    };
    const remote = peer(p.peer.vpcId, p.peer.accountId, p.peer.region, connection.id, p.id);
    admit(connection.id, [origin, connection, remote], [
      edge('peering', p.id, origin.id, connection.id, 'source'),
      edge('peering', p.id, connection.id, remote.id, 'peer'),
    ]);
  }
  const peers = groups.flatMap(g => g.peers.map(p => ({ g, p }))).sort((a, b) =>
    compare(key(a.g.id, a.p.attachmentId, a.g.attachmentId), key(b.g.id, b.p.attachmentId, b.g.attachmentId)));
  for (const { g, p } of peers) {
    const record = scoped('tgw', p.attachmentId);
    if (!eligible(record, p.state, 'available')) continue;
    const hub = gateway(g, p), remote = peer(p.vpcId, p.accountId, source.region, record, p.attachmentId);
    admit(record, [origin, hub, remote], [
      edge('tgw', g.attachmentId, origin.id, hub.id), edge('tgw', p.attachmentId, hub.id, remote.id),
    ]);
  }
  return {
    nodes: [...nodes.values()], edges: [...edges.values()],
    omitted: { inactive: inactive.size, unresolved: unresolved.size, capped: capped.size },
  };
}
