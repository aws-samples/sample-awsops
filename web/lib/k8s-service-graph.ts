// Pure namespaced service-graph builder for the K8s map (React-free, deterministic: sorted by id).
// Nodes: gateway (Ingress) · service · datastore. Pods/Nodes are detail-only (serviceDetail).
// Never-misattribute rules (carried over from the former 4-column K8s map builder):
//  - Service→Pod comes ONLY from core Endpoints READY addresses: the targetRef pod identity
//    (preferred) or a same-namespace IP that resolves to exactly ONE non-hostNetwork pod.
//    hostNetwork pods carry the node IP, so an IP never identifies one of them.
//  - Service→datastore comes from DB refs on the linked pods' workloads; refs on workloads not
//    behind any Service are disclosed in `notes`, never attached elsewhere.
//  - Secret refs are names shown in the detail panel; they never create nodes or edges.
//  - Trace calls (k8s-trace-overlay.ts, already workload-level) attach only when each workload is
//    fronted by exactly ONE Service (and a datastore host matches at most one node); anything else
//    is skipped and counted in `notes`, never guessed.
import type { ServiceRow, EndpointRow, IngressRow } from './eks-incluster';
import { nodePodKeys, nodeReadyText, type PodRow, type NodeRow } from './eks-resources';
import type { DbRef, SecretRef } from './eks-db-refs';
import type { DbResource } from './db-ref-resolve';
import type { TraceOverlay } from './k8s-trace-overlay';
import { extractManagedDbHosts } from './db-endpoint';
import { matchDnsToGateways, type DnsRecord } from './k8s-dns';

export type Evidence = 'trace' | 'config' | 'routing';
export type GKind = 'dns' | 'gateway' | 'service' | 'datastore';
export interface GNode {
  id: string; kind: GKind; label: string; namespace: string | null; sub?: string;
  status?: 'ok' | 'warn' | 'bad' | 'neutral'; meta: Record<string, unknown>;
}
export interface GEdge { id: string; source: string; target: string; evidence: Evidence[]; metric?: { rps?: number; errorRate?: number } }
export interface ServiceGraph {
  namespaces: { name: string; serviceIds: string[]; system: boolean }[];
  nodes: GNode[]; edges: GEdge[]; notes: string[];
}

export interface GraphInput {
  services: ServiceRow[]; endpoints: EndpointRow[]; pods: PodRow[]; nodes: NodeRow[]; ingresses: IngressRow[];
  dbRefs: (DbRef & { resource: DbResource | null })[]; secretRefs: SecretRef[];
  trace: TraceOverlay | null; dns: DnsRecord[];
}
export interface ServiceDetail {
  pods: PodRow[]; nodes: (NodeRow & { readyText: string })[];
  callers: GNode[]; callees: GNode[]; datastores: GNode[]; secretRefs: string[];
}

export const SYSTEM_NAMESPACES: ReadonlySet<string> = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

// Strongest evidence first (trace-observed > config-inferred > routing-configured).
const EVIDENCE_ORDER: Evidence[] = ['trace', 'config', 'routing'];
const svcId = (ns: string, name: string) => `svc:${ns}/${name}`;
const wlKey = (ns: string, name: string) => `${ns}/${name}`;
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** svc id → pods behind its Endpoints READY addresses (sorted by pod name). */
function servicePods(input: GraphInput): Map<string, PodRow[]> {
  const byName = new Map<string, PodRow>();
  const byIp = new Map<string, PodRow[]>();
  for (const p of input.pods) {
    byName.set(`${p.namespace}/${p.name}`, p);
    for (const ip of new Set([p.podIP, ...(p.podIPs ?? [])])) {
      if (!ip) continue;
      const k = `${p.namespace}|${ip}`;
      byIp.set(k, [...(byIp.get(k) ?? []), p]);
    }
  }
  const out = new Map<string, PodRow[]>();
  const services = new Set(input.services.map((s) => svcId(s.namespace, s.name)));
  for (const ep of input.endpoints) {
    const id = svcId(ep.namespace, ep.name);
    if (!services.has(id)) continue;
    const pods = new Map<string, PodRow>();
    for (const t of ep.targets) {
      if (t.pod) {
        const p = byName.get(`${ep.namespace}/${t.pod}`);
        if (p) pods.set(p.name, p);
        continue;
      }
      const cands = byIp.get(`${ep.namespace}|${t.ip}`) ?? [];
      if (cands.length === 1 && !cands[0].hostNetwork) pods.set(cands[0].name, cands[0]);
    }
    if (pods.size) out.set(id, [...pods.values()].sort((a, b) => cmp(a.name, b.name)));
  }
  return out;
}

const workloadsOf = (pods: PodRow[]) =>
  [...new Set(pods.map((p) => p.workload).filter((w): w is string => !!w))].sort(cmp);

function datastoreId(ref: DbRef & { resource: DbResource | null }): { id: string; resolved: boolean } {
  if (ref.resource?.id) return { id: `ds:${ref.resource.type}:${ref.resource.id}`, resolved: true };
  return { id: `ds:${ref.kind}:${ref.host.toLowerCase()}`, resolved: false };
}

export function buildServiceGraph(input: GraphInput): ServiceGraph {
  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  const addEdge = (source: string, target: string, ev: Evidence) => {
    const id = `${source}->${target}`;
    const e = edges.get(id);
    if (!e) edges.set(id, { id, source, target, evidence: [ev] });
    else if (!e.evidence.includes(ev)) e.evidence = EVIDENCE_ORDER.filter((x) => x === ev || e.evidence.includes(x));
  };

  const podsBySvc = servicePods(input);
  const svcByWorkload = new Map<string, string[]>(); // ns/workload → fronting svc ids
  for (const s of input.services) {
    const id = svcId(s.namespace, s.name);
    const pods = podsBySvc.get(id) ?? [];
    const workloads = workloadsOf(pods);
    for (const w of workloads) {
      const k = wlKey(s.namespace, w);
      svcByWorkload.set(k, [...(svcByWorkload.get(k) ?? []), id]);
    }
    nodes.set(id, {
      id, kind: 'service', label: s.name, namespace: s.namespace, sub: `${s.type} · ${s.clusterIP}`,
      status: 'neutral', meta: { ...s, podCount: pods.length, workloads },
    });
  }

  for (const ing of input.ingresses) {
    const id = `gw:${ing.namespace}/${ing.name}`;
    nodes.set(id, {
      id, kind: 'gateway', label: ing.name, namespace: ing.namespace,
      sub: ing.lbHostname || ing.className || undefined, status: 'neutral', meta: { ...ing },
    });
    for (const b of ing.backends) {
      const target = svcId(ing.namespace, b.service);
      if (nodes.get(target)?.kind === 'service') addEdge(id, target, 'routing');
    }
  }

  // LoadBalancer Services with a provisioned hostname are gateways too. Ids: Ingress gateways are
  // `gw:<ns>/<name>`, LB Services `gw:lb:<ns>/<svcName>` (the extra `lb:` segment keeps them collision-free).
  const gatewayHosts: { id: string; host: string }[] = [];
  for (const ing of input.ingresses) if (ing.lbHostname) gatewayHosts.push({ id: `gw:${ing.namespace}/${ing.name}`, host: ing.lbHostname });
  for (const s of input.services) {
    if (s.type !== 'LoadBalancer' || !s.lbHostname) continue;
    const id = `gw:lb:${s.namespace}/${s.name}`;
    nodes.set(id, {
      id, kind: 'gateway', label: s.name, namespace: s.namespace, sub: s.lbHostname, status: 'neutral',
      meta: { name: s.name, namespace: s.namespace, lbHostname: s.lbHostname, source: 'service' },
    });
    addEdge(id, svcId(s.namespace, s.name), 'routing');
    gatewayHosts.push({ id, host: s.lbHostname });
  }
  // DNS → gateway by exact host equality only; records matching nothing create no nodes.
  for (const { record, gatewayHost } of matchDnsToGateways(input.dns ?? [], gatewayHosts.map((g) => g.host))) {
    const dnsName = record.name.trim().toLowerCase().replace(/\.+$/, '');
    const dnsId = `dns:${dnsName}`;
    if (!nodes.has(dnsId)) {
      nodes.set(dnsId, { id: dnsId, kind: 'dns', label: dnsName, namespace: null, status: 'neutral', meta: { name: dnsName } });
    }
    for (const g of gatewayHosts) {
      if (g.host.toLowerCase().replace(/\.+$/, '') === gatewayHost.toLowerCase().replace(/\.+$/, '')) addEdge(dnsId, g.id, 'routing');
    }
  }

  let unlinkedRefs = 0;
  for (const ref of input.dbRefs) {
    const fronts = svcByWorkload.get(wlKey(ref.workload.namespace, ref.workload.name));
    if (!fronts) { unlinkedRefs++; continue; }
    const { id, resolved } = datastoreId(ref);
    const host = ref.host.toLowerCase();
    const existing = nodes.get(id);
    if (existing) {
      const hosts = existing.meta.hosts as string[];
      if (!hosts.includes(host)) existing.meta.hosts = [...hosts, host].sort(cmp);
    } else {
      const r = ref.resource;
      nodes.set(id, {
        id, kind: 'datastore', namespace: null, status: 'neutral',
        label: resolved && r ? r.id : host,
        sub: resolved && r ? r.type : ref.kind,
        meta: resolved && r
          ? { unresolved: false, kind: ref.kind, type: r.type, resourceId: r.id, region: r.region, accountId: r.accountId, hosts: [host] }
          : { unresolved: true, kind: ref.kind, hosts: [host] },
      });
    }
    for (const s of fronts) addEdge(s, id, 'config');
  }

  let unmappedTrace = input.trace?.available ? (input.trace.skipped ?? 0) : 0;
  const traceOmitted = input.trace?.available ? input.trace.omitted : 0;
  if (input.trace?.available) {
    const soleService = (ns: string, name: string) => {
      const fronts = svcByWorkload.get(wlKey(ns, name));
      return fronts && fronts.length === 1 ? fronts[0] : null;
    };
    for (const c of input.trace.workloadCalls) {
      const source = soleService(c.fromWorkload.namespace, c.fromWorkload.name);
      let target: string | null = null;
      if ('workload' in c.to) target = soleService(c.to.workload.namespace, c.to.workload.name);
      else {
        const host = c.to.datastoreHost.toLowerCase();
        const matches = [...nodes.values()].filter((n) => n.kind === 'datastore' && (n.meta.hosts as string[]).includes(host));
        const managed = extractManagedDbHosts(host);
        if (matches.length === 1) target = matches[0].id;
        else if (matches.length === 0 && managed.length === 1 && managed[0].host === host) {
          target = `ds:${managed[0].kind}:${host}`;
          nodes.set(target, {
            id: target, kind: 'datastore', namespace: null, status: 'neutral', label: host, sub: managed[0].kind,
            meta: { unresolved: true, kind: managed[0].kind, hosts: [host] },
          });
        }
      }
      if (!source || !target) { unmappedTrace++; continue; }
      if (source !== target) addEdge(source, target, 'trace');
    }
  }

  const nsMap = new Map<string, string[]>();
  for (const n of nodes.values()) {
    if (n.namespace === null) continue;
    if (!nsMap.has(n.namespace)) nsMap.set(n.namespace, []);
    if (n.kind === 'service') nsMap.get(n.namespace)!.push(n.id);
  }
  const namespaces = [...nsMap.entries()].sort(([a], [b]) => cmp(a, b))
    .map(([name, ids]) => ({ name, serviceIds: ids.sort(cmp), system: SYSTEM_NAMESPACES.has(name) }));

  const notes: string[] = [];
  if (unlinkedRefs) notes.push(`${unlinkedRefs} datastore reference(s) from workloads not behind a Service are not shown.`);
  if (unmappedTrace) notes.push(`${unmappedTrace} trace-observed call(s) could not be mapped to exactly one Service or datastore and are not shown.`);
  if (traceOmitted) notes.push(`The trace snapshot was only partially read (${traceOmitted} record(s) not inspected); trace-observed calls are not shown.`);

  return { namespaces, nodes: [...nodes.values()].sort(byId), edges: [...edges.values()].sort(byId), notes };
}

/**
 * Namespace view filter, applied to the INPUT before `buildServiceGraph` so a hidden namespace
 * vanishes entirely: its Services, Ingresses, Endpoints, Pods, DB/Secret refs are dropped, and a
 * trace call with either end in a hidden namespace is dropped too (an edge to a hidden node is
 * never drawn, and never counted as "unmapped" in `notes`). Nodes and DNS are cluster-scoped and kept.
 */
export function filterGraphInputByNamespace(input: GraphInput, visible: (namespace: string) => boolean): GraphInput {
  const trace = input.trace?.available
    ? { ...input.trace, workloadCalls: input.trace.workloadCalls.filter((c) =>
      visible(c.fromWorkload.namespace) && (!('workload' in c.to) || visible(c.to.workload.namespace))) }
    : input.trace;
  return {
    ...input,
    services: input.services.filter((s) => visible(s.namespace)),
    endpoints: input.endpoints.filter((e) => visible(e.namespace)),
    pods: input.pods.filter((p) => visible(p.namespace)),
    ingresses: input.ingresses.filter((i) => visible(i.namespace)),
    dbRefs: input.dbRefs.filter((r) => visible(r.workload.namespace)),
    secretRefs: input.secretRefs.filter((r) => visible(r.workload.namespace)),
    trace,
  };
}

const EMPTY_DETAIL = (): ServiceDetail => ({ pods: [], nodes: [], callers: [], callees: [], datastores: [], secretRefs: [] });

export function serviceDetail(graph: ServiceGraph, input: GraphInput, serviceId: string): ServiceDetail {
  const svc = graph.nodes.find((n) => n.id === serviceId);
  if (!svc || svc.kind !== 'service' || svc.namespace === null) return EMPTY_DETAIL();
  const ns = svc.namespace;
  const byNodeId = new Map(graph.nodes.map((n) => [n.id, n]));

  const pods = servicePods(input).get(serviceId) ?? [];
  const placed = new Set(pods.map((p) => p.node).filter(Boolean));
  // nodePodKeys: by name, plus instance id for EC2-view (aws-api) rows named by private DNS.
  const nodes = input.nodes.filter((n) => nodePodKeys(n).some((k) => placed.has(k))).sort((a, b) => cmp(a.name, b.name))
    .map((n) => ({ ...n, readyText: nodeReadyText(n) }));

  const callers: GNode[] = []; const callees: GNode[] = []; const datastores: GNode[] = [];
  for (const e of graph.edges) {
    if (e.target === serviceId) { const n = byNodeId.get(e.source); if (n) callers.push(n); }
    if (e.source === serviceId) {
      const n = byNodeId.get(e.target);
      if (n) (n.kind === 'datastore' ? datastores : callees).push(n);
    }
  }

  const workloads = new Set(workloadsOf(pods));
  const secretRefs = [...new Set(input.secretRefs
    .filter((r) => r.workload.namespace === ns && workloads.has(r.workload.name)).map((r) => r.secret))].sort(cmp);

  return { pods, nodes, callers: callers.sort(byId), callees: callees.sort(byId), datastores: datastores.sort(byId), secretRefs };
}
