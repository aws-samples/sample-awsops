import type {
  E2eCorrelationReason, E2eEdge, E2eEvidence, E2eGraph, E2eInput, E2eLayer, E2eNode, E2eSelection, E2eView,
  E2eSourceStatus, E2eServiceQuality, E2eNetworkQuality,
} from './e2e-topology-types';

// Pure composition of loaded evidence. No SDK, fetch, clock, or layout dependency.
type Meta = Record<string, unknown>;
type Side = 'local' | 'remote';
const record = (value: unknown): Meta =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Meta : {};
const text = (value: unknown): string => typeof value === 'string' && value.trim() ? value : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown): string[] => list(value).map(text).filter(Boolean);
const sourceStatus = (value: unknown): E2eSourceStatus =>
  value === 'complete' || value === 'partial' || value === 'unavailable' ? value : 'unknown';
const sourceTime = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
function serviceQuality(value: unknown): E2eServiceQuality {
  const snapshot = record(value), c = record(snapshot.collection);
  let readStatus: E2eServiceQuality['readStatus'] =
    c.readStatus === 'ok' || c.readStatus === 'partial' || c.readStatus === 'unavailable' ? c.readStatus : 'unknown';
  const flag = (v: unknown) => typeof v === 'boolean' ? v : v === undefined && readStatus !== 'unknown' ? false : null;
  const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const readTruncated = flag(c.readTruncated), metadataTruncated = flag(c.metadataTruncated);
  const nodeDrops = count(c.nodeDrops), edgeDrops = count(c.edgeDrops);
  const inputTruncated = flag(c.inputTruncated), graphTruncated = flag(c.graphTruncated);
  // API row completeness cannot restore competitors dropped before persistence.
  // The current materializer records both loss counts, including zero; absent
  // legacy counts cannot certify uniqueness in the surviving stored rows.
  if (readStatus === 'ok' && (nodeDrops === null || edgeDrops === null)) readStatus = 'unknown';
  if (readStatus === 'ok' && (readTruncated || metadataTruncated || inputTruncated || graphTruncated
    || nodeDrops! > 0 || edgeDrops! > 0 || snapshot.capped === true || text(snapshot.from))) readStatus = 'partial';
  if ((c.readTruncated !== undefined && readTruncated === null)
    || (c.metadataTruncated !== undefined && metadataTruncated === null)
    || (c.inputTruncated !== undefined && inputTruncated === null)
    || (c.graphTruncated !== undefined && graphTruncated === null)
    || (c.nodeDrops !== undefined && nodeDrops === null)
    || (c.edgeDrops !== undefined && edgeDrops === null)
    || (snapshot.capped !== undefined && typeof snapshot.capped !== 'boolean')
    || (snapshot.from !== undefined && typeof snapshot.from !== 'string')) readStatus = 'unknown';
  return { status: ['ok', 'empty', 'partial', 'error', 'unavailable', 'unknown'].includes(text(c.status)) ? text(c.status) : 'unknown',
    stale: typeof c.stale === 'boolean' ? c.stale : null, readStatus, readTruncated, metadataTruncated,
    nodeDrops, edgeDrops, inputTruncated, graphTruncated };
}
function networkQuality(value: unknown, observations: unknown): E2eNetworkQuality {
  const raw = record(value);
  const categories = ['INTRA_AZ', 'INTER_AZ', 'INTER_VPC', 'INTER_REGION', 'AMAZON_S3', 'AMAZON_DYNAMODB', 'UNCLASSIFIED'];
  const categoryList = (v: unknown): E2eNetworkQuality['failedCategories'] =>
    Array.isArray(v) && v.every(item => categories.includes(item)) ? [...new Set(v)] : null;
  const failedCategories = categoryList(raw.failedCategories), cappedCategories = categoryList(raw.cappedCategories);
  const windows = record(raw.windowQuality);
  const windowQuality: E2eNetworkQuality['windowQuality'] = raw.windowQuality && !Array.isArray(raw.windowQuality)
    && typeof raw.windowQuality === 'object' && Object.entries(windows).every(([key, quality]) =>
      categories.includes(key) && (quality === 'verified' || quality === 'unknown')) ? { ...windows } : null;
  for (const observation of list(observations).map(record)) {
    const category = text(observation.category) as keyof NonNullable<E2eNetworkQuality['windowQuality']>;
    if (!categories.includes(category)) continue;
    if (windowQuality && !windowQuality[category]) windowQuality[category] = 'unknown';
    if (cappedCategories && observation.capped === true && !cappedCategories.includes(category)) cappedCategories.push(category);
  }
  let status = sourceStatus(raw.status);
  if (status !== 'unavailable' && (!failedCategories || !cappedCategories || !windowQuality)) status = 'unknown';
  else if (status === 'complete' && (failedCategories!.length || cappedCategories!.length
    || Object.values(windowQuality!).includes('unknown'))) status = 'partial';
  return { status, failedCategories, cappedCategories, windowQuality };
}
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
  parentMembers?: ReadonlySet<string>[];
}

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

function membershipId(type: 'ip' | 'instance', value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 64) return null;
  if (type === 'instance') return /^i-[0-9a-f]+$/.test(value) ? value : null;
  const ipv6 = value.includes(':');
  if (!(ipv6 ? /^[\da-fA-F:.]+$/ : /^(?:\d{1,3}\.){3}\d{1,3}$/).test(value)) return null;
  try {
    const host = new URL(ipv6 ? `http://[${value}]/` : `http://${value}/`).hostname;
    return ipv6 || host === value ? host : null;
  } catch { return null; }
}

function parentMembership(row: Meta) {
  const type = row.target_type;
  let raw = row.target_health_descriptions;
  try { if (typeof raw === 'string') raw = JSON.parse(raw); } catch { return null; }
  if ((type !== 'ip' && type !== 'instance') || !Array.isArray(raw)) return null;
  const ids = new Set<string>();
  for (const item of raw) {
    const id = membershipId(type, record(record(item).Target).Id);
    if (id === null) return null;
    ids.add(id);
  }
  return { type, count: raw.length, ids };
}

function targetIndex(nodes: E2eNode[], edges: E2eEdge[], complete: boolean) {
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
  const membershipCache = new Map<Meta, ReturnType<typeof parentMembership>>();
  let unresolvedTargetGroups = 0;
  for (const node of nodes) {
    if (node.layer !== 'configuration' || node.kind !== 'target') continue;
    const type = node.meta.targetType;
    if (type !== 'ip' && type !== 'instance') continue;
    const parents = scopes.get(node.id) ?? [];
    const rows = parents.map(meta => record(meta.row));
    const common = (field: string): string => {
      // Scope padding cannot make a blocked competitor appear disjoint.
      // Keep source labels and physical account claims verbatim.
      const values = rows.map(row => {
        const value = text(row[field]);
        return field === 'region' || field === 'vpc_id' ? value.trim() : value;
      });
      const value = values[0];
      return value && values.every(candidate => candidate === value) ? value : '';
    };
    // Missing/conflicting dimensions are unknown, not evidence of a disjoint scope.
    const region = common('region'), vpcId = common('vpc_id'), accountId = common('account_id');
    const limited = (node.meta.membersTruncated !== undefined && (!Number.isSafeInteger(node.meta.membersTruncated)
      || Number(node.meta.membersTruncated) !== 0))
      || (node.meta.count !== undefined && (!Number.isSafeInteger(node.meta.count)
        || Number(node.meta.count) < 0 || Number(node.meta.count) > list(node.meta.members).length));
    if (limited) unresolvedTargetGroups++;
    let parentMembers: ReadonlySet<string>[] | undefined;
    const count = node.meta.count, truncated = node.meta.membersTruncated;
    if (limited && complete && rows.length && node.meta.id === undefined
      && Array.isArray(node.meta.members) && typeof count === 'number' && Number.isSafeInteger(count)
      && count >= node.meta.members.length
      && (truncated === undefined || Number.isSafeInteger(truncated) && truncated === count - node.meta.members.length)) {
      const shown = node.meta.members.map(member => {
        const values = targetValues({ members: [member] });
        return values.length === 1 ? membershipId(type, values[0]) : null;
      });
      const full = rows.map(row => {
        if (!membershipCache.has(row)) membershipCache.set(row, parentMembership(row));
        return membershipCache.get(row);
      });
      if (full.every(proof => proof?.type === type && proof.count >= count
        && shown.every(id => id !== null && proof.ids.has(id)))) parentMembers = full.map(proof => proof!.ids);
    }
    // Empty value is a private wildcard: hidden members can contest any matching network scope.
    for (const value of [...targetValues(node.meta), ...(limited ? [''] : [])]) {
      const k = key(type, value);
      const entries = index.get(k) ?? [];
      const memberEvidence = list(node.meta.memberIdentities).map(record).filter(member => text(member.id) === value);
      const evidence = [node.meta, ...parents, ...rows, ...memberEvidence];
      // Retain blocked candidates in the index: dropping one would let a competing
      // record win merely because the conflicting evidence was hidden.
      entries.push({
        node, type, value, region, vpcId, ...(!value && parentMembers ? { parentMembers } : {}),
        accountId: /^\d{12}$/.test(accountId) ? accountId : '',
        blocked: !value || !region || !vpcId || evidence.some(meta => ownershipVeto(meta, region, vpcId)),
        cached: evidence.some(cachedConfiguration),
        // Preserve every identity veto. Only the producer's configuration-only
        // marker may be ignored for CONTEXT, with no other withholding evidence.
        contextAllowed: Boolean(value && region && vpcId) && evidence.some(cachedConfiguration)
          && evidence.every(meta => !ownershipVeto(
            meta.ownership_evidence === 'cached_configuration' && meta.ownership_reason === 'eks_not_enumerated'
              ? { ...meta, ownership_reason: undefined } : meta, region, vpcId,
          )),
      });
      index.set(k, entries);
    }
  }
  return { index, unresolvedTargetGroups };
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
      account === 'self' || Boolean(target.accountId && account === target.accountId))
    && workload.scopes.some(meta => meta.region === target.region
      && (meta.accountId === 'self' || Boolean(target.accountId && meta.accountId === target.accountId)))) return;
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
  const graph: E2eGraph = {
    nodes: [], edges: [],
    summary: {
      configuredNodes: 0, serviceNodes: 0, networkFlows: 0,
      correlatedEndpoints: 0, unmatchedEndpoints: 0, ambiguousEndpoints: 0,
      observationsUnsupported: input.account !== 'self',
      quality: { configuration: sourceStatus(input.quality?.configuration),
        services: serviceQuality(input.services), network: networkQuality(input.quality?.network, input.network),
        unresolvedTargetGroups: 0 },
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
      meta: { ...record(node.meta), capturedAt: sourceTime(node.captured_at),
        snapshotCapturedAt: sourceTime(input.services?.captured_at) },
    });
  }
  summary.serviceNodes = nodes.length - summary.configuredNodes;
  for (const raw of list(input.services?.edges)) {
    const edge = record(raw);
    addEdge({
      source: nodeId('service', input.account, text(edge.source)),
      target: nodeId('service', input.account, text(edge.target)),
      relation: text(edge.rel), evidence: 'service', directed: true,
      meta: { confidence: edge.confidence, snapshotCapturedAt: sourceTime(input.services?.captured_at) },
    });
  }
  const { index: targets, unresolvedTargetGroups } = targetIndex(nodes, edges, summary.quality.configuration === 'complete');
  summary.quality.unresolvedTargetGroups = unresolvedTargetGroups;
  const workloads = workloadIndex(nodes, edges);

  const correlate = (endpoint: E2eNode, side: Side) => {
    const data = record(endpoint.meta.endpoint);
    const region = text(data.region), vpcId = text(data.vpcId);
    const candidates = new Map<string, TargetIdentity>();
    if (region && vpcId) {
      for (const [type, value] of [['ip', text(data.ip)], ['instance', text(data.instanceId)]] as const) {
        if (!value) continue;
        for (const candidate of [...(targets.get(key(type, value)) ?? []), ...(targets.get(key(type, '')) ?? [])]) {
          if ((candidate.region && candidate.region !== region) || (candidate.vpcId && candidate.vpcId !== vpcId)) continue;
          const member = !candidate.value && membershipId(type, value);
          // Absence only: full TG rows never promote hidden members or supply pod identity.
          if (member && candidate.parentMembers?.every(ids => !ids.has(member))) continue;
          candidates.set(candidate.node.id, candidate);
        }
      }
    }
    const blocked = [...candidates.values()].some(candidate => candidate.blocked && !candidate.contextAllowed);
    const target = !blocked && candidates.size === 1 ? [...candidates.values()][0] : undefined;
    // A monitor's name-derived cluster is a display hint, never identity evidence.
    const { cluster, conflict } = targetWorkload(target, data);
    const namespace = text(data.podNamespace), pod = text(data.podName);
    const matches = cluster && namespace && pod
      ? [...(workloads.get(key(cluster, namespace, pod)) ?? [])] : [];
    // Do not choose a winner among conflicting scopes, target records, or workload memberships.
    const scopeReasons = target ? matches.map(workload => workloadScopeReason(workload, target)) : [];
    const reason: E2eCorrelationReason | undefined = summary.quality.configuration !== 'complete' ? 'configuration_unverified'
      : candidates.size > 1 ? 'configuration_conflict'
      : blocked ? 'configuration_unverified'
      : conflict ? 'pod_identity_conflict'
      : matches.length > 1 || scopeReasons.includes('workload_conflict') ? 'workload_conflict'
      : scopeReasons.find(Boolean);
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
        label: target.cached ? 'Cached configured endpoint record' : 'Configured endpoint record',
        meta: {
          match: target.type === 'ip' ? 'ip-region-vpc' : 'instance-region-vpc',
          ownership: 'unverified', ownership_evidence: target.cached ? 'cached_configuration' : 'configured_record',
          ...(target.node.meta.targetCapturedAt !== undefined ? { targetCapturedAt: target.node.meta.targetCapturedAt } : {}),
          account: input.account, region, vpcId, [target.type === 'ip' ? 'ip' : 'instanceId']: target.value,
        },
      });
    }
    if (cluster && namespace && pod && summary.quality.services.readStatus !== 'ok') {
      endpoint.meta.workloadReadStatus = summary.quality.services.readStatus;
    }
    if (matches.length === 1 && summary.quality.services.readStatus === 'ok') {
      addEdge({
        source: endpoint.id, target: matches[0].node.id, relation: 'same-identity',
        evidence: 'identity', directed: false, label: 'Configured pod identity',
        meta: {
          match: 'configured-cluster', ownership: 'unverified',
          account: input.account, cluster, namespace, pod, side,
          viaTarget: target!.node.id, region, vpcId,
          ...(target!.accountId ? { accountId: target!.accountId } : {}),
        },
      });
    }
    const correlated = Boolean((target && !target.cached) || (matches.length && summary.quality.services.readStatus === 'ok'));
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
      addNode({
        id: connectionId, kind: 'connection', label: text(observation.metric) || '네트워크 관측', layer: 'network',
        meta: {
          flow: { ...flow }, metric: observation.metric, unit: observation.unit,
          monitor: observation.monitor, cluster: observation.cluster, category: observation.category,
          rangeSec: observation.rangeSec, capped: observation.capped,
          windowQuality: summary.quality.network.windowQuality?.[text(observation.category) as keyof NonNullable<E2eNetworkQuality['windowQuality']>] ?? 'unknown',
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

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function connectionMeasure(node: E2eNode) {
  if (node.layer !== 'network' || node.kind !== 'connection') return undefined;
  const flow = record(node.meta.flow);
  const metric = text(node.meta.metric).trim();
  const unit = (text(node.meta.unit) || text(flow.unit)).trim();
  if (!flow.local || typeof flow.local !== 'object' || Array.isArray(flow.local)
    || !flow.remote || typeof flow.remote !== 'object' || Array.isArray(flow.remote)
    || !metric || !unit || typeof flow.value !== 'number' || !Number.isFinite(flow.value) || flow.value < 0) return undefined;
  return { metric, unit, value: flow.value };
}

/** Choose groups deterministically; raw magnitudes are comparable only within one metric/unit. */
function compareConnections(a: E2eNode, b: E2eNode): number {
  const left = connectionMeasure(a), right = connectionMeasure(b);
  if (left && right) {
    return Number(right.metric === 'DATA_TRANSFERRED') - Number(left.metric === 'DATA_TRANSFERRED')
      || compareText(left.metric, right.metric) || compareText(left.unit, right.unit)
      || right.value - left.value || compareText(a.id, b.id);
  }
  return Number(Boolean(right)) - Number(Boolean(left)) || compareText(a.id, b.id);
}

/** Select from eligible, uncapped nodes when choosing a primary flow for a later view. */
export function mainE2eConnection(nodes: E2eNode[]): E2eNode | undefined {
  let best: E2eNode | undefined;
  for (const node of nodes) {
    if (connectionMeasure(node) && (!best || compareConnections(node, best) < 0)) best = node;
  }
  return best;
}

/** Stable complete ranking for consumers that need more than the primary observation. */
export function rankE2eConnections(nodes: readonly E2eNode[]): E2eNode[] {
  return nodes.filter(node => connectionMeasure(node) !== undefined).sort(compareConnections);
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
    selected = reachable(matches, selected);
  }
  // Complete only admitted connections from eligible network evidence. This is
  // not another reachability pass: attached/shared context never grants transit.
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
  matches.sort((a, b) => networkRank(a) - networkRank(b)
    || (groupOf.has(a) && groupOf.has(b)
      ? compareConnections(byId.get(groupOf.get(a)!)!, byId.get(groupOf.get(b)!)!) : 0)
    || compareText(a, b));
  if (focusId) add(focusId);
  const explicitFits = new Set([...(focusId && selected.has(focusId) ? [focusId] : []), ...matches]).size <= maxNodes;
  const nonNetworkFits = new Set([...(focusId && selected.has(focusId) ? [focusId] : []),
    ...matches.filter(id => !groupOf.has(id))]).size <= maxNodes;
  // Reserve fitting non-network hits, then complete matching observations before
  // spending the budget on isolated connection glyphs.
  if (nonNetworkFits) for (const id of matches) if (!groupOf.has(id)) add(id);
  if (focusId && groupOf.has(focusId)) addGroup(groupOf.get(focusId)!);
  for (const id of matches) {
    const connection = groupOf.get(id);
    if (connection) addGroup(connection);
    else add(id);
  }
  // A tiny budget may only fit an explicit partial observation. Disclose it below.
  if (explicitFits && !admittedGroups.size) for (const id of matches) add(id);
  const orderedGroups = [...groups.keys()].sort((a, b) => {
    const pinned = (id: string) => [...groups.get(id)!].some(member => visibleIds.has(member));
    return Number(pinned(b)) - Number(pinned(a)) || compareConnections(byId.get(a)!, byId.get(b)!);
  });
  for (const connection of orderedGroups) addGroup(connection);
  // Remaining explicit hits outrank optional context but cannot displace reserved edges.
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
  const omittedCategories = new Map<string, number>();
  for (const [id, members] of groups) {
    if ([...members].every(member => visibleIds.has(member))
      && (groupEdges.get(id) ?? []).every(edge => visibleEdgeIds.has(edge.id))) continue;
    const node = byId.get(id)!;
    const category = (text(node.meta.category) || text(record(node.meta.flow).category)).trim() || 'UNKNOWN';
    omittedCategories.set(category, (omittedCategories.get(category) ?? 0) + 1);
  }
  return {
    nodes, edges: visibleEdges, matchedNodes,
    omittedNodes: selected.size - nodes.length,
    omittedEdges: selectedEdges.length - visibleEdges.length,
    omittedCategories: Object.fromEntries([...omittedCategories].sort(([a], [b]) => compareText(a, b))),
  };
}
