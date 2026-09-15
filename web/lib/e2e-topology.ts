import type {
  E2eCorrelationReason, E2eEdge, E2eEvidence, E2eGraph, E2eInput, E2eLabelKey, E2eLayer, E2eNode, E2eSelection, E2eView,
} from './e2e-topology-types';

// Pure composition of loaded evidence. No SDK, fetch, clock, or layout dependency.
type Meta = Record<string, unknown>;
type Side = 'local' | 'remote';
const record = (value: unknown): Meta =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Meta : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown): string[] => list(value).map(text).filter(Boolean);
const generatedLabel = (labelKey: E2eLabelKey) => ({ label: labelKey, labelKey });
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
  accountId: string;
  blocked: boolean;
  cached: boolean;
  contextAllowed: boolean;
}
type TargetScope = Pick<TargetIdentity, 'node' | 'type' | 'region' | 'vpcId'>;

const hasMarker = (value: unknown): boolean => {
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false;
};

/** Negative ownership evidence is monotonic; nested display candidates are never proof. */
function ownershipVeto(meta: Meta, region: string, vpcId: string): boolean {
  if (meta.resolved === 'ambiguous' || hasMarker(meta.ambiguity)
    || meta.ownership_evidence === 'scope_unverified' || hasMarker(meta.ownership_reason)
    || meta.e2e_correlation_blocked === true) return true;
  // Retain legacy node vetoes; actual producer read quality is caller-owned configurationComplete.
  const reads = record(meta.ownershipRead);
  return ['targetGroup', 'ecsTask', 'subnet'].some(field => hasMarker(reads[field]) && reads[field] !== 'ok')
    || reads.eksUnknown === true
    || (Array.isArray(reads.eksRegions) && !strings(reads.eksRegions).includes(region))
    || strings(reads.eksScopes).includes(`${region}|${vpcId}|`);
}

const cachedConfiguration = (meta: Meta): boolean =>
  meta.ownership_evidence === 'cached_configuration' || record(meta.ownershipRead).configurationOnly === true;

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

function targetIndex(nodes: E2eNode[], edges: E2eEdge[], hostAccountId: string): {
  shown: Map<string, TargetIdentity[]>; truncated: TargetScope[];
} {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const scopes = new Map<string, Meta[]>();
  for (const edge of edges) {
    const source = byId.get(edge.source);
    if (edge.evidence !== 'configuration' || source?.kind !== 'tg') continue;
    const rows = scopes.get(edge.target) ?? [];
    rows.push(source.meta);
    scopes.set(edge.target, rows);
  }
  const index = new Map<string, TargetIdentity[]>();
  const truncated: TargetScope[] = [];
  for (const node of nodes) {
    if (node.layer !== 'configuration' || node.kind !== 'target') continue;
    const type = node.meta.targetType;
    if (type !== 'ip' && type !== 'instance') continue;
    const parents = scopes.get(node.id) ?? [];
    const rows = parents.map(meta => record(meta.row));
    const common = (field: string): string => {
      const value = text(rows[0]?.[field]);
      return value && rows.every(row => row[field] === value) ? value : '';
    };
    // Missing/conflicting dimensions are unknown, not evidence of a disjoint scope.
    const region = common('region'), vpcId = common('vpc_id');
    // Count displayed records before ID deduplication: one IP on two ports is two members.
    // Hidden membership carries scope uncertainty only, never a target/pod identity.
    if ((typeof node.meta.membersTruncated === 'number' && node.meta.membersTruncated > 0)
      || (typeof node.meta.count === 'number' && node.meta.count > list(node.meta.members).length)) {
      truncated.push({ node, type, region, vpcId });
    }
    // Only the trusted host may resolve the configuration's relative self sentinel.
    // Numeric configuration scope must also agree; traces never supply this authority.
    const accounts = rows.map(row => row.account_id === 'self' ? hostAccountId : text(row.account_id));
    const accountId = accounts[0] && accounts.every(account => account === accounts[0]) ? accounts[0] : '';
    const accountBlocked = rows.some(row => hasMarker(row.account_id) && row.account_id !== 'self'
      && (!hostAccountId || row.account_id !== hostAccountId));
    for (const value of targetValues(node.meta)) {
      const k = key(type, value);
      const entries = index.get(k) ?? [];
      const memberEvidence = list(node.meta.memberIdentities).map(record).filter(member => text(member.id) === value);
      const evidence = [node.meta, ...parents, ...rows, ...memberEvidence];
      // Retain blocked candidates in the index: dropping one would let a competing
      // record win merely because the conflicting evidence was hidden.
      entries.push({
        node, type, value, region, vpcId,
        accountId: /^\d{12}$/.test(accountId) ? accountId : '',
        blocked: accountBlocked || !region || !vpcId || evidence.some(meta => ownershipVeto(meta, region, vpcId)),
        cached: evidence.some(cachedConfiguration),
        // Preserve every identity veto. Only the producer's configuration-only
        // marker may be ignored for CONTEXT, with no other withholding evidence.
        contextAllowed: !accountBlocked && Boolean(region && vpcId) && evidence.some(cachedConfiguration)
          && evidence.every(meta => !ownershipVeto(
            meta.ownership_evidence === 'cached_configuration' && meta.ownership_reason === 'eks_not_enumerated'
              ? { ...meta, ownership_reason: undefined } : meta, region, vpcId,
          )),
      });
      index.set(k, entries);
    }
  }
  return { shown: index, truncated };
}

interface WorkloadIdentity {
  node: E2eNode;
  scopes: Meta[];
}

function workloadIndex(nodes: E2eNode[], edges: E2eEdge[]): Map<string, Set<WorkloadIdentity>> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const parents = new Map<string, Meta[]>();
  for (const edge of edges) {
    const source = byId.get(edge.source);
    if (edge.evidence !== 'service' || edge.relation !== 'runs_on' || source?.layer !== 'service') continue;
    const scopes = parents.get(edge.target) ?? [];
    scopes.push(source.meta);
    parents.set(edge.target, scopes);
  }
  const index = new Map<string, Set<WorkloadIdentity>>();
  for (const node of nodes) {
    if (node.layer !== 'service' || node.kind !== 'workload') continue;
    const cluster = text(node.meta.cluster), namespace = text(node.meta.namespace);
    if (!cluster || !namespace) continue;
    const identity = { node, scopes: [node.meta, ...(parents.get(node.id) ?? [])] };
    for (const pod of strings(node.meta.pods)) {
      const k = key(cluster, namespace, pod);
      const matches = index.get(k) ?? new Set<WorkloadIdentity>();
      matches.add(identity);
      index.set(k, matches);
    }
  }
  return index;
}

function workloadScopeReason(workload: WorkloadIdentity, target: TargetIdentity): E2eCorrelationReason | undefined {
  // Real trace producers retain scope on incoming services. Never decode workload IDs.
  // A relative "self" claim cannot corroborate a numeric account without the TG row.
  const claims = (field: string) => workload.scopes.map(meta => meta[field])
    .filter(value => value !== undefined && value !== null && value !== '');
  const regions = claims('region'), accounts = claims('accountId');
  if (regions.length > 0 && regions.every(region => region === target.region)
    && accounts.length > 0 && accounts.every(account =>
      account === 'self' || Boolean(target.accountId && account === target.accountId))) return;
  const conflict = regions.some(region => /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(text(region)) && region !== target.region)
    || accounts.some(account => /^\d{12}$/.test(text(account)) && target.accountId && account !== target.accountId);
  return conflict ? 'workload_conflict' : 'workload_scope_unverified';
}

function targetWorkload(target: TargetIdentity | undefined, endpoint: Meta): { cluster: string; conflict: boolean } {
  const meta = target?.node.meta;
  if (!meta || target?.blocked || target?.cached || meta.resolved !== 'eks') return { cluster: '', conflict: false };
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
  const completeMatch = Boolean(pod && namespace && pod === endpoint.podName && namespace === endpoint.podNamespace);
  return { cluster: completeMatch ? text(meta.cluster) : '', conflict };
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
  const hostAccountId = typeof input.hostAccountId === 'string' && /^\d{12}$/.test(input.hostAccountId)
    ? input.hostAccountId : '';
  const failedCategories = strings(input.networkRead?.failedCategories);
  const unknownWindowCategories = strings(input.networkRead?.unknownWindowCategories);
  const readStatus = input.networkRead?.status ?? 'unknown';
  const graph: E2eGraph = {
    nodes: [], edges: [],
    summary: {
      configuredNodes: 0, serviceNodes: 0, networkFlows: 0,
      correlatedEndpoints: 0, unmatchedEndpoints: 0, ambiguousEndpoints: 0,
      observationsUnsupported: input.account !== 'self',
      configurationComplete: input.configurationComplete === true,
      servicesComplete: input.servicesComplete === true && Number.isFinite(Date.parse(text(input.services?.captured_at))),
      networkRead: {
        status: input.account !== 'self' ? 'unsupported'
          : readStatus === 'complete' && (failedCategories.length || unknownWindowCategories.length) ? 'partial' : readStatus,
        failedCategories, unknownWindowCategories,
      },
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
      kind: text(node.kind), label: text(node.label) || id,
      meta: { ...record(node.meta),
        ...(!summary.configurationComplete && node.kind === 'target' ? { e2e_correlation_blocked: true } : {}) },
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
  const { shown: targets, truncated } = targetIndex(nodes, edges, hostAccountId);
  const workloads = workloadIndex(nodes, edges);

  const correlate = (endpoint: E2eNode, side: Side) => {
    const data = record(endpoint.meta.endpoint);
    const region = text(data.region), vpcId = text(data.vpcId);
    const overlaps = (scope: TargetScope) =>
      !(scope.region && region && scope.region !== region) && !(scope.vpcId && vpcId && scope.vpcId !== vpcId);
    const unverifiedScope = Boolean(text(data.ip) || text(data.instanceId)) && (!region || !vpcId);
    const candidates = new Map<string, TargetIdentity>();
    if (region && vpcId) {
      for (const [type, value] of [['ip', text(data.ip)], ['instance', text(data.instanceId)]] as const) {
        if (!value) continue;
        for (const candidate of targets.get(key(type, value)) ?? []) {
          if (!overlaps(candidate)) continue;
          candidates.set(candidate.node.id, candidate);
        }
      }
    }
    // A shown member may use its own group; an unseen member in another overlapping
    // group prevents false uniqueness. Missing scope never establishes disjointness.
    const hiddenCompetitor = truncated.some(scope => !candidates.has(scope.node.id) && overlaps(scope)
      && Boolean(text(data[scope.type === 'ip' ? 'ip' : 'instanceId'])));
    const blocked = unverifiedScope || hiddenCompetitor
      || [...candidates.values()].some(candidate => candidate.blocked && !candidate.contextAllowed);
    const target = !blocked && candidates.size === 1 ? [...candidates.values()][0] : undefined;
    // A monitor's name-derived cluster is a display hint, never identity evidence.
    const { cluster, conflict } = targetWorkload(target, data);
    const namespace = text(data.podNamespace), pod = text(data.podName);
    const matches = cluster && namespace && pod
      ? [...(workloads.get(key(cluster, namespace, pod)) ?? [])] : [];
    // Do not choose a winner among conflicting scopes, target records, or workload memberships.
    const scopeReasons = target ? matches.map(workload => workloadScopeReason(workload, target)) : [];
    const reason: E2eCorrelationReason | undefined = candidates.size > 1 ? 'configuration_conflict'
      : blocked ? 'configuration_unverified'
      : conflict ? 'pod_identity_conflict'
      : matches.length > 1 || scopeReasons.includes('workload_conflict') ? 'workload_conflict'
      // Retain visible vetoes before withholding a survivor's unverified uniqueness.
      : scopeReasons.find(Boolean) ?? (matches.length > 0 && !summary.servicesComplete ? 'service_source_unverified' : undefined);
    if (reason) {
      endpoint.meta.correlation = 'ambiguous';
      endpoint.meta.correlationReason = reason;
      summary.ambiguousEndpoints++;
      return;
    }
    if (target) {
      addEdge({
        source: endpoint.id, target: target.node.id, relation: 'configured-endpoint-match',
        evidence: target.cached ? 'context' : 'identity', directed: false,
        ...generatedLabel(target.cached ? 'cached_configured_endpoint_record' : 'configured_endpoint_record'),
        meta: {
          match: target.type === 'ip' ? 'ip-region-vpc' : 'instance-region-vpc',
          ownership: 'unverified', ownership_evidence: target.cached ? 'cached_configuration' : 'configured_record',
          ...(target.node.meta.targetCapturedAt !== undefined ? { targetCapturedAt: target.node.meta.targetCapturedAt } : {}),
          account: input.account, region, vpcId, [target.type === 'ip' ? 'ip' : 'instanceId']: target.value,
        },
      });
    }
    if (matches.length === 1) {
      addEdge({
        source: endpoint.id, target: matches[0].node.id, relation: 'same-identity',
        evidence: 'identity', directed: false, ...generatedLabel('configured_pod_identity'),
        meta: {
          match: 'configured-cluster', ownership: 'unverified',
          account: input.account, cluster, namespace, pod, side,
          viaTarget: target!.node.id, region, vpcId,
          ...(target!.accountId ? { accountId: target!.accountId } : {}),
        },
      });
    }
    const correlated = Boolean((target && !target.cached) || matches.length);
    endpoint.meta.correlation = correlated ? 'correlated' : 'unmatched';
    if (!correlated) endpoint.meta.correlationReason = target?.cached ? 'context_only' : 'no_match';
    if (correlated) summary.correlatedEndpoints++;
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
      // Flat NFM fields must not write through to the loader's cached row.
      const projectedFlow = { ...flow };
      for (const side of ['local', 'remote']) {
        if (flow[side] && typeof flow[side] === 'object' && !Array.isArray(flow[side])) {
          projectedFlow[side] = { ...record(flow[side]) };
        }
      }
      for (const field of ['traversed', 'traversedIds']) {
        if (Array.isArray(flow[field])) projectedFlow[field] = [...flow[field]];
      }
      addNode({
        id: connectionId, kind: 'connection', layer: 'network',
        ...(text(observation.metric) ? { label: text(observation.metric) } : generatedLabel('network_observation')),
        meta: {
          flow: projectedFlow, metric: observation.metric, unit: observation.unit,
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
        const label = text(data.podName) || text(data.instanceId) || text(data.ip);
        const endpoint: E2eNode = {
          id: nodeId('network', input.account, 'endpoint', identity, String(occurrence), side),
          kind: 'endpoint', layer: 'network',
          ...(label ? { label } : generatedLabel(side === 'local' ? 'local_endpoint' : 'remote_endpoint')),
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
      const constructs = new Set(strings(flow.traversedIds).filter(value => text(value.split(':')[0])));
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

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Measured connections only: DATA_TRANSFERRED first, then source-order metric/unit
 * groups. Compare finite nonnegative values only within a group; stable IDs break ties. */
export function rankE2eConnections(nodes: readonly E2eNode[]): E2eNode[] {
  const groups = new Map<string, number>();
  const measured = nodes.flatMap(node => {
    const flow = record(node.meta.flow), value = flow.value;
    const metric = text(node.meta.metric).trim(), unit = (text(node.meta.unit) || text(flow.unit)).trim();
    if (node.kind !== 'connection' || node.layer !== 'network' || !metric || !unit
      || !flow.local || typeof flow.local !== 'object' || Array.isArray(flow.local)
      || !flow.remote || typeof flow.remote !== 'object' || Array.isArray(flow.remote)
      || typeof value !== 'number' || !Number.isFinite(value) || value < 0) return [];
    const group = key(metric, unit);
    if (!groups.has(group)) groups.set(group, groups.size);
    return [{ node, metric, group: groups.get(group)!, value }];
  });
  return measured.sort((a, b) => Number(b.metric === 'DATA_TRANSFERRED') - Number(a.metric === 'DATA_TRANSFERRED')
    || a.group - b.group || b.value - a.value || compare(a.node.id, b.node.id)).map(item => item.node);
}

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
    selected = reachable(focusId ? [focusId, ...matches] : matches, selected);
  }
  // A context-reached endpoint selects its own observation, too. Separate passes
  // make completion edge-order independent without traversing identity/context again.
  for (const edge of edges) {
    if (edge.evidence !== 'network') continue;
    for (const [connection, endpoint] of [[edge.source, edge.target], [edge.target, edge.source]]) {
      if (selected.has(endpoint) && byId.get(endpoint)?.kind === 'endpoint'
        && byId.get(connection)?.kind === 'connection') selected.add(connection);
    }
  }
  for (const edge of edges) {
    if (edge.evidence !== 'network') continue;
    for (const [connection, endpoint] of [[edge.source, edge.target], [edge.target, edge.source]]) {
      if (selected.has(connection) && byId.get(connection)?.kind === 'connection'
        && byId.get(endpoint)?.kind === 'endpoint') selected.add(endpoint);
    }
  }
  if (!query) matchedNodes = selected.size;
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
  const admittedGroups = new Set<string>();
  const addGroup = (connection: string) => {
    const group = groups.get(connection)!;
    const missing = [...group].filter(id => !visibleIds.has(id));
    const requiredEdges = (groupEdges.get(connection) ?? []).filter(edge => !reservedNetworkEdges.has(edge.id));
    if (missing.length > maxNodes - visibleIds.size
      || requiredEdges.length > maxEdges - reservedNetworkEdges.size) return;
    // Never spend the residual budget on half of an unselected connection.
    for (const id of group) add(id);
    for (const edge of requiredEdges) reservedNetworkEdges.add(edge.id);
    admittedGroups.add(connection);
  };
  const networkRank = (id: string) => byId.get(id)?.kind === 'connection' ? 0 : groupOf.has(id) ? 1 : 2;
  const ranks = new Map(rankE2eConnections(filtered.nodes).map((node, i) => [node.id, i]));
  const ranked = (id: string) => ranks.get(groupOf.get(id) ?? id) ?? ranks.size;
  const groupDistances = (seeds: string[]) => {
    const distances = new Map(seeds.filter(id => selected.has(id)).map(id => [id, 0]));
    const queue = [...distances.keys()];
    for (let i = 0; i < queue.length; i++) {
      for (const next of adjacency.get(queue[i]) ?? []) {
        if (selected.has(next) && !distances.has(next)) {
          distances.set(next, distances.get(queue[i])! + 1);
          queue.push(next);
        }
      }
    }
    const result = new Map<string, number>();
    const offer = (id: string, distance: number) => {
      const group = groupOf.get(id);
      if (group) result.set(group, Math.min(result.get(group) ?? Infinity, distance));
    };
    for (const [id, distance] of distances) offer(id, distance);
    // Rank directly attached cached records/constructs without using them as transit.
    for (const edge of selectedEdges) {
      if (edge.evidence !== 'context') continue;
      for (const [source, target] of [[edge.source, edge.target], [edge.target, edge.source]]) {
        if (distances.has(source)) offer(target, distances.get(source)! + 1);
      }
    }
    return result;
  };
  const focusDistances = groupDistances(focusId ? [focusId] : []);
  const matchDistances = groupDistances(matches);
  const distance = (distances: Map<string, number>, id: string) => distances.get(id) ?? selected.size + 1;
  matches.sort((a, b) => networkRank(a) - networkRank(b) || ranked(a) - ranked(b) || compare(a, b));
  if (focusId) add(focusId);
  const explicitFits = new Set([...(focusId && selected.has(focusId) ? [focusId] : []), ...matches]).size <= maxNodes;
  // Preserve fitting non-network hits, then admit whole matching observations.
  if (explicitFits) for (const id of matches) if (!groupOf.has(id)) add(id);
  if (focusId && groupOf.has(focusId)) addGroup(groupOf.get(focusId)!);
  const orderedGroups = [...groups.keys()].sort((a, b) => {
    return distance(focusDistances, a) - distance(focusDistances, b)
      || distance(matchDistances, a) - distance(matchDistances, b)
      || ranked(a) - ranked(b) || compare(a, b);
  });
  for (const connection of orderedGroups) addGroup(connection);
  // Residual explicit hits still outrank optional context; incomplete groups are disclosed below.
  for (const id of matches) add(id);
  // Complete observation groups before optional identity neighbors consume the budget.
  for (const connection of orderedGroups) {
    if (!admittedGroups.has(connection)) continue;
    for (const id of groups.get(connection)!) {
      for (const context of [...(identityContext.get(id) ?? [])].sort()) add(context);
    }
  }
  for (const id of selected) if (!groupOf.has(id)) add(id);
  const nodes = [...visibleIds].map(id => byId.get(id)!);
  const edgePriority: Record<E2eEvidence, number> = { network: 0, identity: 1, context: 2, service: 3, configuration: 4 };
  const visibleEdges = selectedEdges
    .filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .sort((a, b) => edgePriority[a.evidence] - edgePriority[b.evidence]
      || Number(reservedNetworkEdges.has(b.id)) - Number(reservedNetworkEdges.has(a.id)))
    .slice(0, maxEdges);
  const visibleEdgeIds = new Set(visibleEdges.map(edge => edge.id));
  const omittedCategories = [...new Set([...groups].filter(([connection, members]) =>
    [...members].some(id => !visibleIds.has(id))
    || (groupEdges.get(connection) ?? []).some(edge => !visibleEdgeIds.has(edge.id)),
  ).map(([connection]) => text(byId.get(connection)!.meta.category)).filter(Boolean))].sort();
  return {
    nodes, edges: visibleEdges, matchedNodes, omittedCategories,
    omittedNodes: selected.size - nodes.length,
    omittedEdges: selectedEdges.length - visibleEdges.length,
  };
}
