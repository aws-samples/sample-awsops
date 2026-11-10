import { createHash } from 'node:crypto';
import type { TraceIdentity, TraceSpan, ServiceGraphCall } from './trace-source';
import { queueClaimMeta, queueDestinationArn } from './trace-evidence';

export interface TraceNode { id: string; kind: string; label: string; meta: Record<string, unknown> }
export interface InstanceObservation {
  instance_id: string;
  instance_ref: string;
  database_ref: string;
  correlation_id: string;
  account: string;
  region: string;
  db_host: string;
  /** Latest span start for this (instance_ref, database_ref) pair; correlation_id names that span. */
  observed_at_ms: number;
  /** Earliest span start for the same pair (additive; equals observed_at_ms for one span). */
  first_observed_at_ms: number;
  /** Number of spans merged into this pair. */
  observation_count: number;
  source_id?: string;
  provenance: 'trace_span';
}
export interface TraceEdge {
  source: string; target: string; rel: string; confidence: string;
  meta: {
    spanCount: number; metricCount: number;
    instance_observations?: InstanceObservation[];
    instance_observations_omitted?: number;
    /** Claimed instance→DB pairs that could not be bound to inventory (edge-level disclosure). */
    instance_observations_unbound?: number;
  };
}
export interface InfraNodeLike { id: string; kind?: string; meta?: Record<string, unknown> | null }
const INSTANCE_OBSERVATION_CAP = 200;
const INSTANCE_ID = /^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
const EC2_ARN = /^arn:(aws(?:-[a-z0-9-]+)?):ec2:([a-z0-9-]+):(\d{12}):instance\/(i-(?:[0-9a-f]{8}|[0-9a-f]{17}))$/;

/** Backend identity remains explicit: unknown scope must not join unrelated datasources. */
function scope(identity: TraceIdentity): string {
  return JSON.stringify([
    identity.sourceId ?? '', identity.accountId ?? '', identity.region ?? '',
    identity.environment ?? '', identity.serviceNamespace ?? '',
    identity.k8sCluster ?? '', identity.k8sNamespace ?? '',
  ]);
}

function nodeId(kind: string, identity: TraceIdentity, name: string): string {
  // Raw telemetry labels can exceed PostgreSQL's B-tree index entry limit.
  const key = createHash('sha256').update(JSON.stringify([scope(identity), name])).digest('hex');
  return `${kind}:${key}`;
}

const resourceScope = ({ sourceId, accountId, region, environment }: TraceIdentity): TraceIdentity =>
  ({ sourceId, accountId, region, environment });

function spanKey(sourceId: string | undefined, traceId: string, spanId: string): string {
  return JSON.stringify([sourceId ?? '', traceId, spanId]);
}

export function resolveInfraRef(dbHost: string | undefined, infraNodes: InfraNodeLike[]): string | undefined {
  if (!dbHost) return undefined;
  const host = dbHost.toLowerCase();
  const exact = infraNodes.filter(node => String(node.meta?.host ?? '').toLowerCase() === host);
  if (exact.length) return exact.length === 1 ? exact[0].id : undefined;
  const prefixes = infraNodes.filter(node => String(node.meta?.host ?? '').toLowerCase().startsWith(`${host}.`));
  return prefixes.length === 1 ? prefixes[0].id : undefined;
}

function exactEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host.length > 253 || !host.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
  return host;
}

/** Unknown scope and conflicting EC2 claims cannot become a resource binding. */
function claimedInstance(span: TraceSpan): string | undefined {
  const instances = new Set<string>();
  for (const [field, claim] of [['cloud', span.cloudResourceId], ['host', span.hostId],
    ['instance', span.serviceInstanceId]] as const) {
    if (!claim) continue;
    if (INSTANCE_ID.test(claim)) instances.add(claim);
    else if (claim.startsWith('arn:')) {
      const arn = EC2_ARN.exec(claim);
      if (!arn || arn[2] !== span.region || arn[3] !== span.accountId) return undefined;
      instances.add(arn[4]);
    } else if (field === 'cloud') return undefined;
  }
  return instances.size === 1 ? [...instances][0] : undefined;
}

function observedInstanceDatabasePair(
  span: TraceSpan, infraNodes: InfraNodeLike[], trustedHostAccountId?: string,
): InstanceObservation | null | undefined {
  // undefined: no EC2 claim to bind; null: a claimed pair that cannot be bound (disclosed on its edge).
  if (!span.dbHost || ![span.cloudResourceId, span.hostId, span.serviceInstanceId].some(claim =>
    claim && (INSTANCE_ID.test(claim) || /^arn:[^:]+:ec2:/.test(claim)))) return undefined;
  const account = span.accountId, region = span.region, observedAt = Math.floor(span.startMs);
  if (!account || !/^\d{12}$/.test(account)
    || !region || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+-\d+$/.test(region)
    || !Number.isSafeInteger(observedAt) || observedAt < 0) return null;
  const instanceId = claimedInstance(span), host = exactEndpoint(span.dbHost);
  if (!instanceId || !host) return null;
  const scoped = infraNodes.filter(node => {
    const inventoryAccount = node.meta?.inventoryAccount;
    const actualAccount = inventoryAccount === 'self' && /^\d{12}$/.test(trustedHostAccountId ?? '')
      ? trustedHostAccountId : inventoryAccount;
    return actualAccount === account && node.meta?.region === region;
  });
  const instances = scoped.filter(node => node.kind === 'ec2' && node.meta?.resourceId === instanceId);
  const databases = scoped.filter(node => node.kind === 'rds'
    && typeof node.meta?.resourceId === 'string' && node.meta.resourceId.length > 0
    && exactEndpoint(node.meta.host) === host);
  if (instances.length !== 1 || databases.length !== 1) return null;
  // A pair is attached to its own DB edge, rather than reconstructed from aggregate service bindings.
  const correlationId = createHash('sha256').update(JSON.stringify([
    span.sourceId ?? '', span.traceId, span.spanId, instances[0].id, databases[0].id,
  ])).digest('hex');
  return {
    instance_id: instanceId, instance_ref: instances[0].id, database_ref: databases[0].id,
    correlation_id: correlationId, account, region, db_host: host,
    observed_at_ms: observedAt, first_observed_at_ms: observedAt, observation_count: 1,
    ...(span.sourceId ? { source_id: span.sourceId } : {}),
    provenance: 'trace_span',
  };
}

/** A dependency graph from sampled spans, source-aggregated span rows and metric calls.
 *  Counts describe evidence, never a probability of correctness. */
export function buildTraceGraph(
  spans: TraceSpan[],
  metricCalls: ServiceGraphCall[],
  infraNodes: InfraNodeLike[],
  trustedHostAccountId?: string,
) {
  const nodes = new Map<string, TraceNode>();
  const edges = new Map<string, TraceEdge>();
  let orphanSpans = 0;
  let invalidSpans = 0;
  let unresolvedMessaging = 0;
  // Per-edge pair index: the cap bounds distinct (instance, database) pairs, so a chatty
  // instance cannot crowd out another instance that shares the same database.
  const pairIndex = new WeakMap<TraceEdge, { kept: Map<string, InstanceObservation>; omitted: Set<string> }>();
  const valid = spans.filter((s) => {
    if (s.traceId && s.spanId && s.service) return true;
    invalidSpans++;
    return false;
  });
  const byId = new Map(valid.map((s) => [spanKey(s.sourceId, s.traceId, s.spanId), s]));
  const serviceNode = (service: string, identity: TraceIdentity) => {
    const id = nodeId('svc', identity, service);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id, kind: 'service', label: service.slice(0, 240),
        meta: {
          service, sourceId: identity.sourceId ?? null,
          accountId: identity.accountId ?? null, region: identity.region ?? null,
          environment: identity.environment ?? null, serviceNamespace: identity.serviceNamespace ?? null,
          cluster: identity.k8sCluster ?? null, namespace: identity.k8sNamespace ?? null,
          spanCount: 0, errorSpanCount: 0, unknownStatusSpanCount: 0,
          sampledDurationMs: 0, traceIds: [],
        },
      });
    }
    return id;
  };
  const edge = (source: string, target: string, rel: string, spanCount = 1, metricCount = 0) => {
    const key = JSON.stringify([source, target, rel]);
    const current = edges.get(key);
    if (current) {
      current.meta.spanCount += spanCount;
      current.meta.metricCount += metricCount;
      return current;
    } else {
      const added: TraceEdge = { source, target, rel, confidence: 'observed', meta: { spanCount, metricCount } };
      edges.set(key, added);
      return added;
    }
  };

  for (const span of byId.values()) {
    // An aggregate row stands for `weight` spans; a raw span for one.
    const w = Number.isSafeInteger(span.weight) && span.weight! > 0 ? span.weight! : 1;
    const sid = serviceNode(span.service, span);
    const meta = nodes.get(sid)!.meta;
    meta.spanCount = Number(meta.spanCount) + w;
    if (span.status === 'error') meta.errorSpanCount = Number(meta.errorSpanCount) + w;
    if (!span.status || span.status === 'unset') meta.unknownStatusSpanCount = Number(meta.unknownStatusSpanCount) + w;
    meta.sampledDurationMs = Number(meta.sampledDurationMs) + Math.max(0, Number(span.durationMs) || 0);
    const traceIds = meta.traceIds as string[];
    if (traceIds.length < 20 && !traceIds.includes(span.traceId)) traceIds.push(span.traceId);

    if (span.parentSpanId) {
      const parent = byId.get(spanKey(span.sourceId, span.traceId, span.parentSpanId));
      if (parent) {
        const parentId = serviceNode(parent.service, parent);
        if (parentId !== sid) edge(parentId, sid, 'calls');
      } else orphanSpans++;
    }
    for (const link of span.links ?? []) {
      const linked = byId.get(spanKey(span.sourceId, link.traceId, link.spanId));
      if (linked) {
        const linkedId = serviceNode(linked.service, linked);
        if (linkedId !== sid) edge(linkedId, sid, 'linked');
      } else orphanSpans++;
    }
    if (span.dbSystem) {
      const name = `${span.dbSystem}:${span.dbHost ?? 'unknown'}/${span.dbName ?? ''}`;
      const id = nodeId('db', resourceScope(span), name);
      // Infra lookup is only safe for host-scoped observations; foreign accounts must not
      // match an identically named host in the local materialized inventory.
      const isHost = !span.accountId || span.accountId === 'self'
        || (trustedHostAccountId !== undefined && /^\d{12}$/.test(trustedHostAccountId)
          && span.accountId === trustedHostAccountId);
      const infraRef = isHost
        ? resolveInfraRef(span.dbHost, infraNodes) : undefined;
      nodes.set(id, {
        id, kind: 'db', label: name,
        meta: { system: span.dbSystem, host: span.dbHost ?? null, dbName: span.dbName ?? null,
          sourceId: span.sourceId ?? null, environment: span.environment ?? null,
          accountId: span.accountId ?? null, region: span.region ?? null,
          ...(infraRef ? { infra_ref: infraRef } : {}) },
      });
      const queryEdge = edge(sid, id, 'queries', w);
      // Only an outbound client call is evidence that this instance queried the database;
      // SERVER/PRODUCER/etc. spans carrying db attributes keep the service→DB edge only.
      const observation = span.kind === 'CLIENT'
        ? observedInstanceDatabasePair(span, infraNodes, trustedHostAccountId) : undefined;
      if (observation === null) queryEdge.meta.instance_observations_unbound = (queryEdge.meta.instance_observations_unbound ?? 0) + w;
      else if (observation) {
        observation.observation_count = w;
        const first = Number.isSafeInteger(span.firstStartMs) && span.firstStartMs! >= 0
          ? Math.min(span.firstStartMs!, observation.observed_at_ms) : observation.observed_at_ms;
        observation.first_observed_at_ms = first;
        const observations = queryEdge.meta.instance_observations ??= [];
        let index = pairIndex.get(queryEdge);
        if (!index) pairIndex.set(queryEdge, index = { kept: new Map(), omitted: new Set() });
        const key = JSON.stringify([observation.instance_ref, observation.database_ref]);
        const existing = index.kept.get(key);
        if (existing) {
          existing.observation_count += w;
          existing.first_observed_at_ms = Math.min(existing.first_observed_at_ms, first);
          if (observation.observed_at_ms > existing.observed_at_ms
            || (observation.observed_at_ms === existing.observed_at_ms
              && observation.correlation_id > existing.correlation_id)) {
            existing.observed_at_ms = observation.observed_at_ms;
            existing.correlation_id = observation.correlation_id;
          }
        } else if (observations.length < INSTANCE_OBSERVATION_CAP) {
          index.kept.set(key, observation);
          observations.push(observation);
        } else if (!index.omitted.has(key)) {
          // Omitted counts distinct pairs, matching the distinct-pair cap.
          index.omitted.add(key);
          queryEdge.meta.instance_observations_omitted = (queryEdge.meta.instance_observations_omitted ?? 0) + 1;
        }
      }
    }
    if (span.k8sNamespace && span.k8sDeployment) {
      const name = `${span.k8sNamespace}/${span.k8sDeployment}`;
      const id = nodeId('workload', span, name);
      if (!nodes.has(id)) nodes.set(id, {
        id, kind: 'workload', label: name,
        meta: { namespace: span.k8sNamespace, deployment: span.k8sDeployment,
          cluster: span.k8sCluster ?? null, environment: span.environment ?? null,
          sourceId: span.sourceId ?? null, pods: [] },
      });
      const pods = nodes.get(id)!.meta.pods as string[];
      for (const pod of span.k8sPods ?? (span.k8sPod ? [span.k8sPod] : [])) if (!pods.includes(pod)) pods.push(pod);
      edge(sid, id, 'runs_on', w);
    }
    if (span.messagingSystem && span.messagingDestination) {
      const destination = span.messagingDestination.trim();
      const qualified = queueDestinationArn(destination);
      const name = `${span.messagingSystem}:${destination}`;
      if (!qualified && !span.messagingBroker) {
        unresolvedMessaging++;
        continue; // A bare topic/queue name is not evidence of a shared broker.
      }
      // Join the same claimed ARN across callers, isolated by datasource/environment.
      // It is telemetry, not AWS-verified attribution; never bridge queues into inventory.
      const identity = qualified ? {
        sourceId: span.sourceId, environment: span.environment,
        region: qualified.region ?? '', accountId: qualified.accountId,
      } : {
        // Caller scope isolates broker observations; it is not a claim about the queue.
        ...resourceScope(span), k8sCluster: span.k8sCluster,
        // A short service DNS name is resolved relative to the workload namespace.
        k8sNamespace: span.messagingBroker?.includes('.') ? undefined : span.k8sNamespace,
      };
      const id = nodeId('queue', identity,
        JSON.stringify([span.messagingSystem, qualified ? null : span.messagingBroker,
          destination]));
      nodes.set(id, { id, kind: 'queue', label: name,
        meta: queueClaimMeta({ system: span.messagingSystem, destination,
          broker: qualified ? null : span.messagingBroker ?? null,
          cluster: qualified ? null : span.k8sCluster ?? null,
          sourceId: span.sourceId ?? null, environment: span.environment ?? null }) });
      if (span.kind === 'PRODUCER') edge(sid, id, 'publishes', w);
      if (span.kind === 'CONSUMER') edge(id, sid, 'consumes', w);
    }
  }
  // Trace spans name databases and queues with host-qualified identity. Metric rows only carry
  // Tempo's server label (a db.name such as "admin"), so they draw those nodes only when no
  // span evidence exists; otherwise the same database would appear twice under two names.
  const spanEvidence = byId.size > 0;
  for (const call of metricCalls) {
    if (!Number.isFinite(call.count) || call.count <= 0) continue;
    if (call.evidence === 'trace') {
      const client = serviceNode(call.client, call.clientIdentity ?? {});
      const server = serviceNode(call.server, call.serverIdentity ?? {});
      if (client !== server) edge(client, server, call.rel ?? 'calls', call.count, 0);
      continue;
    }
    const clientIdentity = call.clientIdentity ?? {}, serverIdentity = call.serverIdentity ?? {};
    if (call.connectionType === 'database' || call.connectionType === 'messaging_system') {
      if (spanEvidence) continue;
      const database = call.connectionType === 'database';
      const scoped = resourceScope({ ...clientIdentity, ...serverIdentity });
      const id = nodeId(database ? 'db' : 'queue', scoped, `metric:${call.server}`);
      if (!nodes.has(id)) nodes.set(id, database ? {
        id, kind: 'db', label: call.server.slice(0, 240),
        meta: { system: null, host: null, dbName: null, metricServer: call.server,
          sourceId: scoped.sourceId ?? null, environment: scoped.environment ?? null,
          accountId: scoped.accountId ?? null, region: scoped.region ?? null, provenance: 'service_graph_metric' },
      } : {
        id, kind: 'queue', label: call.server.slice(0, 240),
        meta: queueClaimMeta({ system: null, destination: call.server, broker: null, cluster: null,
          sourceId: scoped.sourceId ?? null, environment: scoped.environment ?? null,
          provenance: 'service_graph_metric' }),
      });
      edge(serviceNode(call.client, clientIdentity), id, database ? 'queries' : 'publishes', 0, call.count);
      continue;
    }
    if (call.connectionType === 'virtual_node') {
      // Tempo names an uninstrumented caller "user"; otherwise the uninstrumented side is the server.
      const clientVirtual = call.client === 'user';
      const external = (name: string, identity: TraceIdentity) => {
        const id = nodeId('ext', resourceScope(identity), name);
        if (!nodes.has(id)) nodes.set(id, { id, kind: 'external', label: name.slice(0, 240),
          meta: { name, sourceId: identity.sourceId ?? null, environment: identity.environment ?? null,
            provenance: 'service_graph_metric' } });
        return id;
      };
      edge(clientVirtual ? external(call.client, clientIdentity) : serviceNode(call.client, clientIdentity),
        clientVirtual ? serviceNode(call.server, serverIdentity) : external(call.server, serverIdentity),
        'calls', 0, call.count);
      continue;
    }
    edge(serviceNode(call.client, clientIdentity),
      serviceNode(call.server, serverIdentity), 'calls', 0, call.count);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], orphanSpans, invalidSpans,
    unresolvedMessaging };
}
