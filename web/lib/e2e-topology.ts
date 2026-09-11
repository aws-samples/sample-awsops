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
  const addNode = (node: E2eNode) => {
    if (present.has(node.id)) return;
    present.add(node.id);
    nodes.push(node);
  };
  const addEdge = (edge: Omit<E2eEdge, 'id'>) => {
    if (present.has(edge.source) && present.has(edge.target)) {
      edges.push({ ...edge, id: `edge:${key(input.account, String(edges.length))}` });
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

  const correlate = (endpoint: E2eNode, monitorCluster: string, side: Side) => {
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
    const targetCluster = target?.node.meta.resolved === 'eks' ? text(target.node.meta.cluster) : '';
    const localCluster = side === 'local' ? monitorCluster : '';
    const cluster = localCluster || targetCluster;
    const namespace = text(data.podNamespace), pod = text(data.podName);
    const matches = cluster && namespace && pod
      ? [...(workloads.get(key(cluster, namespace, pod)) ?? [])] : [];
    // Do not choose a winner among conflicting scopes, target records, or workload memberships.
    const conflictingClusters = localCluster && targetCluster && localCluster !== targetCluster;
    if (candidates.size > 1 || matches.length > 1 || conflictingClusters) {
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
          match: localCluster ? 'monitor-cluster' : 'configured-cluster',
          account: input.account, cluster, namespace, pod, side,
          ...(!localCluster && target ? { viaTarget: target.node.id, region, vpcId } : {}),
        },
      });
    }
    endpoint.meta.correlation = target || matches.length ? 'correlated' : 'unmatched';
    if (target || matches.length) summary.correlatedEndpoints++;
    else summary.unmatchedEndpoints++;
  };

  list(input.network).forEach((rawObservation, observationIndex) => {
    const observation = record(rawObservation);
    list(observation.rows).forEach((rawFlow, rowIndex) => {
      if (!rawFlow || typeof rawFlow !== 'object' || Array.isArray(rawFlow)) return;
      const flow = record(rawFlow);
      const connectionId = nodeId('network', input.account, 'connection', String(observationIndex), String(rowIndex));
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
          id: nodeId('network', input.account, 'endpoint', String(observationIndex), String(rowIndex), side),
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
        correlate(endpoint, text(observation.cluster), side);
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

/** Search metadata values as well as visible labels; malformed/cyclic metadata stays harmless. */
function matchesQuery(node: E2eNode, query: string): boolean {
  const pending: unknown[] = [node.id, node.label, node.kind, node.meta];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' || typeof value === 'number') {
      if (String(value).toLowerCase().includes(query)) return true;
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      pending.push(...Object.values(value));
    }
  }
  return false;
}

const bound = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

/**
 * Focus/search select connected evidence in both directions, preserving edge direction for display.
 * Context attaches once after traversal: a shared NAT/TGW never grants transit reachability.
 * matchedNodes counts query hits (or selected nodes without a query); omissions count display caps
 * only, after evidence/focus/search filters.
 */
export function selectE2eGraph(graph: E2eGraph, selection: E2eSelection): E2eView {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const evidence = selection.evidence === undefined ? null : new Set(selection.evidence);
  const edges = graph.edges.filter(edge => byId.has(edge.source) && byId.has(edge.target)
    && (!evidence || evidence.has(edge.evidence)));
  const incident = new Set(edges.flatMap(edge => [edge.source, edge.target]));
  const eligible = new Set(graph.nodes.filter(node => {
    const ownEvidence: E2eEvidence = node.layer === 'network' && node.kind === 'construct' ? 'context' : node.layer;
    return !evidence || evidence.has(ownEvidence) || incident.has(node.id);
  }).map(node => node.id));
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
  let selected = selection.focusId
    ? reachable([selection.focusId], eligible) : eligible;
  const query = selection.query?.trim().toLowerCase() ?? '';
  let matchedNodes = selected.size;
  if (query) {
    const matches = [...selected].filter(id => matchesQuery(byId.get(id)!, query));
    matchedNodes = matches.length;
    selected = reachable(matches, selected);
    // An explicit focus and all exact query hits take precedence over traversal neighbors.
    if (selection.focusId && selected.has(selection.focusId)) {
      selected = new Set([selection.focusId, ...selected]);
    }
  }
  const selectedEdges = edges.filter(edge => selected.has(edge.source) && selected.has(edge.target));
  const nodes = [...selected].slice(0, bound(selection.maxNodes, 350)).map(id => byId.get(id)!);
  const visibleIds = new Set(nodes.map(node => node.id));
  const visibleEdges = selectedEdges
    .filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .slice(0, bound(selection.maxEdges, 700));
  return {
    nodes, edges: visibleEdges, matchedNodes,
    omittedNodes: selected.size - nodes.length,
    omittedEdges: selectedEdges.length - visibleEdges.length,
  };
}
