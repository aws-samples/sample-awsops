import { createHash } from 'node:crypto';
import type { TraceIdentity, TraceSpan, ServiceGraphCall } from './trace-source';
import { queueClaimMeta, queueDestinationArn } from './trace-evidence';

export interface TraceNode { id: string; kind: string; label: string; meta: Record<string, unknown> }
export interface TraceEdge {
  source: string; target: string; rel: string; confidence: string;
  meta: { spanCount: number; metricCount: number };
}
export interface InfraNodeLike { id: string; kind?: string; meta?: Record<string, unknown> | null }

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
  for (const node of infraNodes) {
    const candidate = String(node.meta?.host ?? '').toLowerCase();
    if (candidate && (candidate === host || candidate.startsWith(`${host}.`))) return node.id;
  }
  return undefined;
}

/** A sampled dependency graph. Counts describe evidence, never a probability of correctness. */
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
    } else {
      edges.set(key, { source, target, rel, confidence: 'observed', meta: { spanCount, metricCount } });
    }
  };

  for (const span of byId.values()) {
    const sid = serviceNode(span.service, span);
    const meta = nodes.get(sid)!.meta;
    meta.spanCount = Number(meta.spanCount) + 1;
    if (span.status === 'error') meta.errorSpanCount = Number(meta.errorSpanCount) + 1;
    if (!span.status || span.status === 'unset') meta.unknownStatusSpanCount = Number(meta.unknownStatusSpanCount) + 1;
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
          ...(infraRef ? { infra_ref: infraRef } : {}) },
      });
      edge(sid, id, 'queries');
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
      if (span.k8sPod && !pods.includes(span.k8sPod)) pods.push(span.k8sPod);
      edge(sid, id, 'runs_on');
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
      if (span.kind === 'PRODUCER') edge(sid, id, 'publishes');
      if (span.kind === 'CONSUMER') edge(id, sid, 'consumes');
    }
  }
  for (const call of metricCalls) {
    if (!Number.isFinite(call.count) || call.count <= 0) continue;
    edge(serviceNode(call.client, call.clientIdentity ?? {}),
      serviceNode(call.server, call.serverIdentity ?? {}), 'calls', 0, call.count);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], orphanSpans, invalidSpans, unresolvedMessaging };
}
