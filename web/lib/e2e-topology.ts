import type {
  E2eEdge, E2eEvidence, E2eGraph, E2eInput, E2eLayer, E2eNode, E2eSelection, E2eView,
} from './e2e-topology-types';

// Pure composition of loaded evidence. No SDK, fetch, clock, or layout dependency.
type Meta = Record<string, unknown>;
type Side = 'local' | 'remote';
const record = (value: unknown): Meta =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Meta : {};
const text = (value: unknown): string => typeof value === 'string' && value.trim() ? value : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown): string[] => list(value).map(text).filter(Boolean);
// Tuple encoding avoids collisions from separators occurring in source IDs or names.
const key = (...parts: string[]): string => JSON.stringify(parts);
const nodeId = (layer: E2eLayer, account: string, ...parts: string[]): string =>
  `${layer}:${key(account, ...parts)}`;

interface TargetIdentity {
  node: E2eNode;
  type: 'ip' | 'instance';
  value: string;
  region: string;
  vpcId: string;
}

/** Grouped targets expose only a capped list, not all members in the TG's inventory row. */
function targetValues(meta: Meta): string[] {
  const result = new Set<string>();
  if (text(meta.id)) result.add(text(meta.id));
  for (const member of strings(meta.members)) {
    const withPort = member.match(/^([^:]+):\d+$/);
    const bracketed = member.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracketed) result.add(bracketed[1]);
    else if (withPort) result.add(withPort[1]);
    else if (!member.includes(':')) result.add(member);
    // An unbracketed IPv6 member could be an address OR address:port. Do not guess.
    // Exact IPv6 addresses remain usable through the single-target meta.id.
  }
  return [...result];
}

function targetIndex(nodes: E2eNode[], edges: E2eEdge[]): Map<string, TargetIdentity[]> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const scopes = new Map<string, Meta[]>();
  for (const edge of edges) {
    const source = byId.get(edge.source);
    if (edge.evidence !== 'configuration' || source?.kind !== 'tg') continue;
    const rows = scopes.get(edge.target) ?? [];
    rows.push(record(source.meta.row));
    scopes.set(edge.target, rows);
  }
  const index = new Map<string, TargetIdentity[]>();
  for (const node of nodes) {
    if (node.layer !== 'configuration' || node.kind !== 'target') continue;
    const type = node.meta.targetType;
    if (type !== 'ip' && type !== 'instance') continue;
    const rows = scopes.get(node.id) ?? [];
    if (!rows.length || rows.some(row => !text(row.region) || !text(row.vpc_id))) continue;
    const region = text(rows[0].region), vpcId = text(rows[0].vpc_id);
    // A target without one coherent scope cannot prove an endpoint's identity.
    if (rows.some(row => row.region !== region || row.vpc_id !== vpcId)) continue;
    for (const value of targetValues(node.meta)) {
      const k = key(region, vpcId, type, value);
      const entries = index.get(k) ?? [];
      entries.push({ node, type, value, region, vpcId });
      index.set(k, entries);
    }
  }
  return index;
}

function workloadIndex(nodes: E2eNode[]): Map<string, Set<E2eNode>> {
  const index = new Map<string, Set<E2eNode>>();
  for (const node of nodes) {
    if (node.layer !== 'service' || node.kind !== 'workload') continue;
    const cluster = text(node.meta.cluster), namespace = text(node.meta.namespace);
    if (!cluster || !namespace) continue;
    for (const pod of strings(node.meta.pods)) {
      const k = key(cluster, namespace, pod);
      const matches = index.get(k) ?? new Set<E2eNode>();
      matches.add(node);
      index.set(k, matches);
    }
  }
  return index;
}

function targetWorkload(target: TargetIdentity | undefined, endpoint: Meta): { cluster: string; conflict: boolean } {
  const meta = target?.node.meta;
  if (!meta || meta.resolved !== 'eks') return { cluster: '', conflict: false };
  let identity = meta;
  if (Array.isArray(meta.members)) {
    // Group metadata retains the first replica's pod. Only the exact shown member
    // can validate another replica; absent member evidence permits a bare IP join only.
    const members = list(meta.memberIdentities).map(record).filter(member => text(member.id) === target!.value);
    if (!members.length) return { cluster: '', conflict: false };
    const identities = new Set(members.map(member => key(text(member.pod), text(member.namespace))));
    if (identities.size !== 1) return { cluster: '', conflict: true };
    identity = members[0];
  }
  const pod = text(identity.pod), namespace = text(identity.namespace);
  const conflict = Boolean(
    (pod && text(endpoint.podName) && pod !== endpoint.podName)
    || (namespace && text(endpoint.podNamespace) && namespace !== endpoint.podNamespace),
  );
  const completeMember = !Array.isArray(meta.members) || Boolean(pod && namespace);
  return { cluster: completeMember ? text(meta.cluster) : '', conflict };
}

/** Fixed-field tuples are independent of object/row ordering and tolerate malformed metadata. */
function observationIdentity(observation: Meta, flow: Meta): string {
  const endpointIdentity = (endpoint: unknown) => {
    const data = record(endpoint);
    return ['ip', 'instanceId', 'subnetId', 'az', 'vpcId', 'region', 'podName', 'podNamespace', 'serviceName']
      .map(field => text(data[field]));
  };
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return JSON.stringify([
    ['monitor', 'metric', 'category', 'startTime', 'endTime', 'queriedAt'].map(field => text(observation[field])),
    number(observation.rangeSec), endpointIdentity(flow.local), endpointIdentity(flow.remote),
    number(flow.targetPort), text(flow.category), text(flow.snatIp), text(flow.dnatIp),
    number(flow.value), text(flow.unit), text(observation.unit),
    [...new Set(strings(flow.traversed))].sort(), [...new Set(strings(flow.traversedIds))].sort(),
  ]);
}

/** Keep source records separate; identity edges express correlation, never a traced request. */
export function buildE2eGraph(input: E2eInput): E2eGraph {
  const graph: E2eGraph = {
    nodes: [], edges: [],
    summary: {
      configuredNodes: 0, serviceNodes: 0, networkFlows: 0,
      correlatedEndpoints: 0, unmatchedEndpoints: 0, ambiguousEndpoints: 0,
      observationsUnsupported: input.account !== 'self',
    },
  };
  const { nodes, edges, summary } = graph;
  const present = new Set<string>();
  const edgeOccurrences = new Map<string, number>();
  const addNode = (node: E2eNode) => {
    if (present.has(node.id)) return;
    present.add(node.id);
    nodes.push(node);
  };
  const addEdge = (edge: Omit<E2eEdge, 'id'>) => {
    if (present.has(edge.source) && present.has(edge.target)) {
      const identity = key(input.account, edge.source, edge.target, edge.evidence, edge.relation);
      const occurrence = edgeOccurrences.get(identity) ?? 0;
      edgeOccurrences.set(identity, occurrence + 1);
      edges.push({ ...edge, id: `edge:${key(identity, String(occurrence))}` });
    }
  };
  for (const raw of list(input.configured?.nodes)) {
    const node = record(raw), id = text(node.id);
    if (!id) continue;
    addNode({
      id: nodeId('configuration', input.account, id), layer: 'configuration',
      kind: text(node.kind), label: text(node.label) || id, meta: { ...record(node.meta) },
    });
  }
  summary.configuredNodes = nodes.length;
  for (const raw of list(input.configured?.edges)) {
    const edge = record(raw);
    addEdge({
      source: nodeId('configuration', input.account, text(edge.source)),
      target: nodeId('configuration', input.account, text(edge.target)),
      relation: 'configuration', evidence: 'configuration', directed: true,
      ...(text(edge.label) ? { label: text(edge.label) } : {}),
      meta: { confidence: edge.confidence },
    });
  }
  // Neither observation source carries attribution for the selected external/all account.
  if (summary.observationsUnsupported) return graph;

  for (const raw of list(input.services?.nodes)) {
    const node = record(raw), id = text(node.id);
    if (!id) continue;
    addNode({
      id: nodeId('service', input.account, id), layer: 'service',
      kind: text(node.kind), label: text(node.label) || id,
      meta: { ...record(node.meta), capturedAt: input.services?.captured_at ?? null },
    });
  }
  summary.serviceNodes = nodes.length - summary.configuredNodes;
  for (const raw of list(input.services?.edges)) {
    const edge = record(raw);
    addEdge({
      source: nodeId('service', input.account, text(edge.source)),
      target: nodeId('service', input.account, text(edge.target)),
      relation: text(edge.rel), evidence: 'service', directed: true,
      meta: { confidence: edge.confidence, capturedAt: input.services?.captured_at ?? null },
    });
  }
  const targets = targetIndex(nodes, edges);
  const workloads = workloadIndex(nodes);

  const correlate = (endpoint: E2eNode, side: Side) => {
    const data = record(endpoint.meta.endpoint);
    const region = text(data.region), vpcId = text(data.vpcId);
    const candidates = new Map<string, TargetIdentity>();
    if (region && vpcId) {
      for (const [type, value] of [['ip', text(data.ip)], ['instance', text(data.instanceId)]] as const) {
        if (!value) continue;
        for (const candidate of targets.get(key(region, vpcId, type, value)) ?? []) {
          candidates.set(candidate.node.id, candidate);
        }
      }
    }
    const target = candidates.size === 1 ? [...candidates.values()][0] : undefined;
    // A monitor's name-derived cluster is a display hint, never identity evidence.
    const { cluster, conflict } = targetWorkload(target, data);
    const namespace = text(data.podNamespace), pod = text(data.podName);
    const matches = cluster && namespace && pod
      ? [...(workloads.get(key(cluster, namespace, pod)) ?? [])] : [];
    // Do not choose a winner among conflicting scopes, target records, or workload memberships.
    if (candidates.size > 1 || matches.length > 1 || conflict) {
      endpoint.meta.correlation = 'ambiguous';
      summary.ambiguousEndpoints++;
      return;
    }
    if (target) {
      addEdge({
        source: endpoint.id, target: target.node.id, relation: 'same-identity',
        evidence: 'identity', directed: false,
        meta: {
          match: target.type === 'ip' ? 'ip-region-vpc' : 'instance-region-vpc',
          account: input.account, region, vpcId, [target.type === 'ip' ? 'ip' : 'instanceId']: target.value,
        },
      });
    }
    if (matches.length === 1) {
      addEdge({
        source: endpoint.id, target: matches[0].id, relation: 'same-identity',
        evidence: 'identity', directed: false,
        meta: {
          match: 'configured-cluster',
          account: input.account, cluster, namespace, pod, side,
          viaTarget: target!.node.id, region, vpcId,
        },
      });
    }
    endpoint.meta.correlation = target || matches.length ? 'correlated' : 'unmatched';
    if (target || matches.length) summary.correlatedEndpoints++;
    else summary.unmatchedEndpoints++;
  };

  const flowOccurrences = new Map<string, number>();
  list(input.network).forEach(rawObservation => {
    const observation = record(rawObservation);
    list(observation.rows).forEach(rawFlow => {
      if (!rawFlow || typeof rawFlow !== 'object' || Array.isArray(rawFlow)) return;
      const flow = record(rawFlow);
      const identity = observationIdentity(observation, flow);
      const occurrence = flowOccurrences.get(identity) ?? 0;
      flowOccurrences.set(identity, occurrence + 1);
      const connectionId = nodeId('network', input.account, 'connection', identity, String(occurrence));
      addNode({
        id: connectionId, kind: 'connection', label: text(observation.metric) || '네트워크 관측', layer: 'network',
        meta: {
          flow: rawFlow, metric: observation.metric, unit: observation.unit,
          monitor: observation.monitor, cluster: observation.cluster, category: observation.category,
          rangeSec: observation.rangeSec, capped: observation.capped,
          ...(observation.startTime !== undefined ? { startTime: observation.startTime } : {}),
          ...(observation.endTime !== undefined ? { endTime: observation.endTime } : {}),
          ...(observation.queriedAt !== undefined ? { queriedAt: observation.queriedAt } : {}),
        },
      });
      summary.networkFlows++;
      for (const side of ['local', 'remote'] as const) {
        const data = record(flow[side]);
        const endpoint: E2eNode = {
          id: nodeId('network', input.account, 'endpoint', identity, String(occurrence), side),
          kind: 'endpoint', layer: 'network',
          label: text(data.podName) || text(data.instanceId) || text(data.ip)
            || (side === 'local' ? '로컬 엔드포인트' : '원격 엔드포인트'),
          meta: { endpoint: { ...data }, side, connectionId },
        };
        addNode(endpoint);
        addEdge({
          source: endpoint.id, target: connectionId, relation: side,
          evidence: 'network', directed: false, meta: { side },
        });
        correlate(endpoint, side);
      }

      // The input list's order is retained in meta.flow for inspection, never as hop edges.
      const constructs = new Set(strings(flow.traversedIds));
      const representedTypes = new Set([...constructs].map(value => value.split(':')[0]));
      for (const type of strings(flow.traversed)) if (!representedTypes.has(type)) constructs.add(type);
      for (const construct of constructs) {
        const colon = construct.indexOf(':');
        const type = colon < 0 ? construct : construct.slice(0, colon);
        const componentId = colon < 0 ? '' : construct.slice(colon + 1);
        const id = componentId
          ? nodeId('network', input.account, 'construct', type, componentId)
          : nodeId('network', input.account, 'construct', connectionId, type);
        addNode({
          id, kind: 'construct', layer: 'network', label: componentId ? construct : type,
          meta: { type, ...(componentId ? { componentId } : { connectionId }) },
        });
        addEdge({
          source: connectionId, target: id, relation: 'traversed-construct',
          evidence: 'context', directed: false,
        });
      }
    });
  });
  return graph;
}

/** Shared canvas/view search; empty queries match every eligible node. */
export function matchesE2eQuery(node: E2eNode, query: string): boolean {
  query = query.trim().toLowerCase();
  if (!query) return true;
  if (node.id.toLowerCase() === query) return true;
  // Network IDs/link references encode an entire connection. Searching their
  // internals would make a remote endpoint falsely match the local pod or metric.
  const metadata = node.layer === 'network'
    ? Object.entries(node.meta).filter(([field]) => field !== 'connectionId').map(([, value]) => value)
    : node.meta;
  const pending: unknown[] = [node.label, node.kind, node.layer, metadata];
  if (node.layer !== 'network') pending.push(node.id);
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' || typeof value === 'number') {
      if (String(value).toLowerCase().includes(query)) return true;
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const nested of Object.values(value)) pending.push(nested);
    }
  }
  return false;
}

const bound = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

/** Enabled relations keep their endpoints, including cross-layer identity/context evidence. */
export function filterE2eGraph(graph: E2eGraph, evidence?: E2eEvidence[]): Pick<E2eGraph, 'nodes' | 'edges'> {
  const present = new Set(graph.nodes.map(node => node.id));
  const enabled = evidence === undefined ? null : new Set(evidence);
  const edges = graph.edges.filter(edge => present.has(edge.source) && present.has(edge.target)
    && (!enabled || enabled.has(edge.evidence)));
  const incident = new Set(edges.flatMap(edge => [edge.source, edge.target]));
  const nodes = graph.nodes.filter(node => {
    const ownEvidence = node.layer === 'network' && node.kind === 'construct' ? 'context' : node.layer;
    return !enabled || enabled.has(ownEvidence) || incident.has(node.id);
  });
  return { nodes, edges };
}

/**
 * Focus/search select connected evidence in both directions, preserving edge direction for display.
 * Context attaches once after traversal: a shared NAT/TGW never grants transit reachability.
 * matchedNodes counts query hits (or selected nodes without a query); omissions count display caps
 * only, after evidence/focus/search filters.
 */
export function selectE2eGraph(graph: E2eGraph, selection: E2eSelection): E2eView {
  const filtered = filterE2eGraph(graph, selection.evidence);
  const byId = new Map(filtered.nodes.map(node => [node.id, node]));
  const edges = filtered.edges;
  const eligible = new Set(byId.keys());
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.evidence === 'context') continue;
    for (const [source, target] of [[edge.source, edge.target], [edge.target, edge.source]]) {
      const neighbors = adjacency.get(source) ?? [];
      neighbors.push(target);
      adjacency.set(source, neighbors);
    }
  }
  const reachable = (seeds: string[], allowed: Set<string>): Set<string> => {
    const visited = new Set(seeds.filter(id => allowed.has(id)));
    const queue = [...visited];
    for (let i = 0; i < queue.length; i++) {
      for (const next of adjacency.get(queue[i]) ?? []) {
        if (allowed.has(next) && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    // Use a snapshot so even chains of context relations do not become traversable.
    const traversed = new Set(visited);
    for (const edge of edges) {
      if (edge.evidence !== 'context') continue;
      if (traversed.has(edge.source) && allowed.has(edge.target)) visited.add(edge.target);
      if (traversed.has(edge.target) && allowed.has(edge.source)) visited.add(edge.source);
    }
    return visited;
  };
  const focusId = selection.focusId && eligible.has(selection.focusId) ? selection.focusId : null;
  let selected = focusId ? reachable([focusId], eligible) : eligible;
  const query = selection.query?.trim().toLowerCase() ?? '';
  let matchedNodes = selected.size;
  let matches: string[] = [];
  if (query) {
    matches = [...selected].filter(id => matchesE2eQuery(byId.get(id)!, query));
    matchedNodes = matches.length;
    selected = reachable(matches, selected);
  }
  const selectedEdges = edges.filter(edge => selected.has(edge.source) && selected.has(edge.target));
  const maxNodes = bound(selection.maxNodes, 350);
  const maxEdges = bound(selection.maxEdges, 700);
  const visibleIds = new Set<string>();
  const add = (id: string) => {
    if (selected.has(id) && visibleIds.size < maxNodes) visibleIds.add(id);
  };
  const groups = new Map<string, Set<string>>();
  const groupEdges = new Map<string, E2eEdge[]>();
  const groupOf = new Map<string, string>();
  const identityContext = new Map<string, Set<string>>();
  for (const id of selected) {
    if (byId.get(id)?.kind === 'connection' && byId.get(id)?.layer === 'network') {
      groups.set(id, new Set([id]));
      groupOf.set(id, id);
    }
  }
  for (const edge of selectedEdges) {
    if (edge.evidence === 'network') {
      for (const [connection, endpoint] of [[edge.source, edge.target], [edge.target, edge.source]]) {
        if (groups.has(connection) && byId.get(endpoint)?.kind === 'endpoint') {
          groups.get(connection)!.add(endpoint);
          groupOf.set(endpoint, connection);
          const connections = groupEdges.get(connection) ?? [];
          connections.push(edge);
          groupEdges.set(connection, connections);
        }
      }
    }
    if (edge.evidence === 'identity') {
      for (const [source, target] of [[edge.source, edge.target], [edge.target, edge.source]]) {
        const context = identityContext.get(source) ?? new Set<string>();
        context.add(target);
        identityContext.set(source, context);
      }
    }
  }
  const reservedNetworkEdges = new Set<string>();
  const addGroup = (connection: string) => {
    const group = groups.get(connection)!;
    const missing = [...group].filter(id => !visibleIds.has(id));
    const requiredEdges = (groupEdges.get(connection) ?? []).filter(edge => !reservedNetworkEdges.has(edge.id));
    if (missing.length > maxNodes - visibleIds.size
      || requiredEdges.length > maxEdges - reservedNetworkEdges.size) return;
    // Never spend the residual budget on half of an unselected connection.
    for (const id of group) add(id);
    for (const edge of requiredEdges) reservedNetworkEdges.add(edge.id);
    for (const id of group) {
      for (const context of [...(identityContext.get(id) ?? [])].sort()) add(context);
    }
  };
  const networkRank = (id: string) => byId.get(id)?.kind === 'connection' ? 0 : groupOf.has(id) ? 1 : 2;
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  matches.sort((a, b) => networkRank(a) - networkRank(b) || compare(a, b));
  if (focusId) add(focusId);
  if (new Set([...(focusId && selected.has(focusId) ? [focusId] : []), ...matches]).size <= maxNodes) {
    // When all explicit hits fit, none may be displaced by a traversal neighbor.
    for (const id of matches) add(id);
    for (const edge of selectedEdges) {
      if (edge.evidence === 'network' && visibleIds.has(edge.source) && visibleIds.has(edge.target)) {
        reservedNetworkEdges.add(edge.id);
      }
    }
  } else {
    // An overfull query must still show complete matching observations before
    // spending the budget on hundreds of matching configuration records.
    for (const id of matches) {
      const connection = groupOf.get(id);
      if (connection) addGroup(connection);
      add(id);
    }
  }
  const orderedGroups = [...groups.keys()].sort((a, b) => {
    const pinned = (id: string) => [...groups.get(id)!].some(member => visibleIds.has(member));
    return Number(pinned(b)) - Number(pinned(a)) || compare(a, b);
  });
  for (const connection of orderedGroups) addGroup(connection);
  for (const id of selected) if (!groupOf.has(id)) add(id);
  const nodes = [...visibleIds].map(id => byId.get(id)!);
  const edgePriority: Record<E2eEvidence, number> = { network: 0, identity: 1, context: 2, service: 3, configuration: 4 };
  const visibleEdges = selectedEdges
    .filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .sort((a, b) => edgePriority[a.evidence] - edgePriority[b.evidence])
    .slice(0, maxEdges);
  return {
    nodes, edges: visibleEdges, matchedNodes,
    omittedNodes: selected.size - nodes.length,
    omittedEdges: selectedEdges.length - visibleEdges.length,
  };
}
