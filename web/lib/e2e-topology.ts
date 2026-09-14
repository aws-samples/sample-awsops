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
const capturedTime = (value: unknown): string | null => value instanceof Date && Number.isFinite(value.getTime())
  ? value.toISOString() : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
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
  const host = input.account === 'self';
  const coverage = host ? input.networkCoverage : undefined;
  const observations = host ? list(input.network).map(record) : [];
  const categories = (rows: Meta[]) => rows.map(row => text(row.category)).filter(Boolean) as E2eGraph['coverage']['network']['cappedCategories'];
  const cappedCategories = [...new Set([
    ...(coverage?.cappedCategories ?? []), ...categories(observations.filter(row => row.capped === true)),
  ])];
  const collection = host ? input.services?.collection : undefined;
  const graph: E2eGraph = {
    nodes: [], edges: [],
    coverage: {
      service: collection ? { ...collection,
        ...(collection.sources ? { sources: collection.sources.map(source => ({ ...source,
          ...(source.reasons ? { reasons: [...source.reasons] } : {}) })) } : {}),
      } : { status: 'unknown', stale: true },
      network: {
        status: !host ? 'unsupported' : coverage?.status === 'partial' || observations.some(o => !o.startTime || !o.endTime
          || !(Date.parse(text(o.startTime)) < Date.parse(text(o.endTime)) )) || cappedCategories.length || coverage?.failedCategories.length
          || Object.keys(coverage?.errors ?? {}).length ? 'partial' : coverage ? 'complete' : 'unknown',
        successfulCategories: [...new Set(categories(observations))],
        failedCategories: coverage ? [...coverage.failedCategories] : null,
        cappedCategories, errors: coverage ? { ...coverage.errors } : null,
        windowQuality: { ...coverage?.windowQuality },
      },
    },
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
  const appendLayer = (layer: 'configuration' | 'service', source: unknown) => {
    const data = record(source), extra = { capturedAt: capturedTime(data.captured_at) };
    for (const raw of list(data.nodes)) {
      const node = record(raw), id = text(node.id);
      const meta = record(node.meta);
      const capturedAt = layer === 'configuration'
        ? capturedTime(meta.capturedAt) ?? capturedTime(record(meta.row).captured_at) ?? extra.capturedAt : extra.capturedAt;
      if (id) addNode({ id: nodeId(layer, input.account, id), layer, kind: text(node.kind),
        label: text(node.label) || id, meta: { ...meta, capturedAt } });
    }
    for (const raw of list(data.edges)) {
      const edge = record(raw);
      addEdge({ source: nodeId(layer, input.account, text(edge.source)),
        target: nodeId(layer, input.account, text(edge.target)),
        relation: layer === 'configuration' ? 'configuration' : text(edge.rel), evidence: layer, directed: true,
        ...(layer === 'configuration' && text(edge.label) ? { label: text(edge.label) } : {}),
        meta: { confidence: edge.confidence, ...extra } });
    }
  };
  appendLayer('configuration', input.configured);
  summary.configuredNodes = nodes.length;
  if (summary.observationsUnsupported) return graph;
  appendLayer('service', input.services);
  summary.serviceNodes = nodes.length - summary.configuredNodes;
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
    // Neither monitor nor configured-cluster names verify a trace workload's immutable scope.
    const localCluster = side === 'local' ? monitorCluster : '';
    const cluster = localCluster || targetCluster;
    const namespace = text(data.podNamespace), pod = text(data.podName);
    const matches = cluster && namespace && pod
      ? [...(workloads.get(key(cluster, namespace, pod)) ?? [])] : [];
    // Do not choose a winner among conflicting scopes, target records, or workload memberships.
    const conflictingClusters = localCluster && targetCluster && localCluster !== targetCluster;
    const targetNamespace = text(target?.node.meta.namespace);
    // A grouped workload carries one representative pod, not per-member pod metadata.
    const targetPod = target && text(target.node.meta.id) === target.value
      && target.node.meta.members === undefined && target.node.meta.count === undefined
      ? text(target.node.meta.pod) : '';
    const conflictingOwner = (targetNamespace && namespace && targetNamespace !== namespace)
      || (targetPod && pod && targetPod !== pod);
    const conflictingWorkloadType = target?.node.meta.resolved === 'ecs' && (!!pod || !!namespace || matches.length > 0);
    if (candidates.size > 1 || matches.length > 1 || conflictingClusters || conflictingOwner || conflictingWorkloadType
      || target?.node.meta.resolved === 'ambiguous'
      || ['cached_configuration', 'scope_unverified'].includes(text(target?.node.meta.ownership_evidence))) {
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
          configurationCapturedAt: target.node.meta.capturedAt,
          account: input.account, region, vpcId, [target.type === 'ip' ? 'ip' : 'instanceId']: target.value,
        },
      });
    }
    if (matches.length === 1) {
      addEdge({
        source: endpoint.id, target: matches[0].id, relation: 'name-context',
        evidence: 'context', directed: false,
        meta: {
          match: localCluster ? 'monitor-cluster' : 'configured-cluster',
          account: input.account, cluster, namespace, pod, side,
          ...(!localCluster && target ? { viaTarget: target.node.id, region, vpcId } : {}),
        },
      });
    }
    endpoint.meta.correlation = target ? 'correlated' : matches.length ? 'context' : 'unmatched';
    if (target) summary.correlatedEndpoints++;
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
export function matchesE2eQuery(node: E2eNode, query: string): boolean {
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

/** Shared eligibility for search, focus and traversal, before display limits. */
export function filterE2eEvidence(graph: E2eGraph, enabled?: E2eEvidence[]): E2eGraph {
  const ids = new Set(graph.nodes.map(node => node.id));
  const evidence = enabled === undefined ? null : new Set(enabled);
  const edges = graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)
    && (!evidence || evidence.has(edge.evidence)));
  const incident = new Set(edges.flatMap(edge => [edge.source, edge.target]));
  const nodes = graph.nodes.filter(node => {
    const ownEvidence = node.layer === 'network' && node.kind === 'construct' ? 'context' : node.layer;
    return !evidence || evidence.has(ownEvidence) || incident.has(node.id);
  });
  return { ...graph, nodes, edges };
}

type ConnectionGroup = { nodes: Set<string>; edges: Set<string> };
function connectionGroups(edges: E2eEdge[], byId: Map<string, E2eNode>): Map<string, ConnectionGroup> {
  const groups = new Map<string, ConnectionGroup>();
  for (const edge of edges) {
    if (edge.evidence !== 'network') continue;
    const id = [edge.source, edge.target].find(id => byId.get(id)?.kind === 'connection');
    if (!id) continue;
    const group = groups.get(id) ?? { nodes: new Set<string>(), edges: new Set<string>() };
    group.nodes.add(edge.source).add(edge.target); group.edges.add(edge.id);
    groups.set(id, group);
  }
  return groups;
}

/**
 * Focus/search select connected evidence in both directions, preserving edge direction for display.
 * Context attaches once after traversal: a shared NAT/TGW never grants transit reachability.
 * matchedNodes counts query hits (or selected nodes without a query); omissions count display caps
 * only, after evidence/focus/search filters.
 */
export function selectE2eGraph(graph: E2eGraph, selection: E2eSelection): E2eView {
  const filtered = filterE2eEvidence(graph, selection.evidence);
  const byId = new Map(filtered.nodes.map(node => [node.id, node]));
  const { edges } = filtered;
  const allGroups = connectionGroups(edges, byId);
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
    // Attach context once, then direct stored service neighbors; never traverse context again.
    for (const evidence of ['context', 'service'] as const) {
      const traversed = new Set(visited);
      for (const edge of edges) {
        if (edge.evidence !== evidence) continue;
        if (traversed.has(edge.source) && allowed.has(edge.target)) visited.add(edge.target);
        if (traversed.has(edge.target) && allowed.has(edge.source)) visited.add(edge.source);
      }
    }
    // Context may admit a connection or endpoint; complete its own unit without transit.
    const touched = new Set(visited);
    for (const group of allGroups.values()) {
      if ([...group.nodes].some(id => touched.has(id))) {
        for (const id of group.nodes) if (allowed.has(id)) visited.add(id);
      }
    }
    return visited;
  };
  const validFocus = selection.focusId && eligible.has(selection.focusId) ? selection.focusId : null;
  let selected = validFocus ? reachable([validFocus], eligible) : eligible;
  const query = selection.query?.trim().toLowerCase() ?? '';
  let matchedNodes = selected.size;
  if (query) {
    const matches = [...selected].filter(id => matchesE2eQuery(byId.get(id)!, query));
    matchedNodes = matches.length;
    selected = reachable(matches, selected);
    // An explicit focus and all exact query hits take precedence over traversal neighbors.
    if (validFocus && selected.has(validFocus)) {
      selected = new Set([validFocus, ...selected]);
    }
  }
  const selectedEdges = edges.filter(edge => selected.has(edge.source) && selected.has(edge.target));
  const maxNodes = bound(selection.maxNodes, 350);
  let ordered = selected;
  if (!validFocus && !query) {
    const incidentEdges = new Map<string, E2eEdge[]>();
    for (const edge of selectedEdges) {
      for (const id of [edge.source, edge.target]) {
        const adjacent = incidentEdges.get(id) ?? [];
        adjacent.push(edge);
        incidentEdges.set(id, adjacent);
      }
    }
    const neighbors = (ids: string[], kinds: E2eEvidence[]) => ids.flatMap(id =>
      (incidentEdges.get(id) ?? []).filter(edge => kinds.includes(edge.evidence))
        .map(edge => edge.source === id ? edge.target : edge.source));
    ordered = new Set<string>();
    const append = (ids: string[], whole = false): boolean => {
      const additions = [...new Set(ids)].filter(id => selected.has(id) && !ordered.has(id));
      if (whole && ordered.size + additions.length > maxNodes) return false;
      for (const id of additions.slice(0, maxNodes - ordered.size)) ordered.add(id);
      return true;
    };
    const connections = filtered.nodes.filter(node => node.layer === 'network' && node.kind === 'connection');
    const services = filtered.nodes.filter(node => node.layer === 'service');
    const groupedNetwork = new Set<string>();
    const context: string[] = [];
    // Interleave observations and services. A hot workload must not pull in endpoints whose
    // connections were omitted; each connection and its eligible endpoints enter together.
    for (let i = 0; i < Math.max(connections.length, services.length); i++) {
      if (connections[i]) {
        const id = connections[i].id;
        const endpoints = neighbors([id], ['network']);
        const group = [id, ...endpoints];
        group.forEach(node => groupedNetwork.add(node));
        if (append(group, true)) {
          const associations = neighbors(endpoints, ['identity', 'context']);
          append(associations);
          append(neighbors(associations, ['service']));
          // Configured parents and traversed constructs are context, never transit hops.
          context.push(...neighbors(associations, ['configuration']), ...neighbors([id], ['context']));
        }
      }
      if (services[i]) {
        const id = services[i].id;
        append([id, ...neighbors([id], ['service', 'identity'])
          .filter(next => byId.get(next)?.layer !== 'network')]);
      }
    }
    append(context);
    // Do not reintroduce a partial flow while filling remaining space with inventory.
    append([...selected].filter(id => !groupedNetwork.has(id)));
  }
  // Apply the same indivisible flow unit to overview, focus and search, including edge limits.
  const maxEdges = bound(selection.maxEdges, 700);
  const membership = new Map<string, ConnectionGroup>();
  for (const group of connectionGroups(selectedEdges, byId).values()) {
    for (const id of group.nodes) membership.set(id, group);
  }
  const visibleIds = new Set<string>(), requiredEdges = new Set<string>();
  for (const id of ordered) {
    const group = membership.get(id);
    const additions = [id, ...(group?.nodes ?? [])].filter(node => !visibleIds.has(node));
    const unique = [...new Set(additions)];
    const addedEdges = [...(group?.edges ?? [])].filter(edge => !requiredEdges.has(edge));
    if (visibleIds.size + unique.length > maxNodes || requiredEdges.size + addedEdges.length > maxEdges) continue;
    unique.forEach(node => visibleIds.add(node));
    addedEdges.forEach(edge => requiredEdges.add(edge));
  }
  const edgePriority: Record<E2eEvidence, number> = { network: 0, identity: 1, service: 2, context: 3, configuration: 4 };
  const visibleEdges = selectedEdges
    .filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .sort((a, b) => edgePriority[a.evidence] - edgePriority[b.evidence])
    .slice(0, maxEdges);
  // Only context edges that survived the final edge budget can support a construct.
  for (const id of visibleIds) {
    if (byId.get(id)?.kind === 'construct' && !visibleEdges.some(edge => edge.evidence === 'context'
      && (edge.source === id && visibleIds.has(edge.target) || edge.target === id && visibleIds.has(edge.source)))) {
      visibleIds.delete(id);
    }
  }
  const nodes = [...visibleIds].map(id => byId.get(id)!);
  return {
    nodes, edges: visibleEdges, matchedNodes, coverage: graph.coverage,
    omittedNodes: selected.size - nodes.length,
    omittedEdges: selectedEdges.length - visibleEdges.length,
  };
}
