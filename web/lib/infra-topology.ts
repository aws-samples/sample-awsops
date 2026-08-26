// ADR-043 Step 2 — single source for the RESOURCE-RELATIONSHIP (infra) graph ontology.
// Pure TS (no I/O), mirroring how flow-topology.ts is the single source for the traffic-flow graph.
// Emits resource -> vpc/subnet/sg placement edges from synced inventory. The materializer
// (graph-store.rebuildInfraGraph) and any future consumer reuse this — no rule duplication.

export type Row = Record<string, unknown>;
export interface InfraNode { id: string; kind: string; label: string; meta?: Record<string, unknown> }
export interface InfraEdge { id: string; source: string; target: string; rel: string }
export interface InfraGraph { nodes: InfraNode[]; edges: InfraEdge[] }
// inventory rows: { resource_type, resource_id, region, data:{...} } (data carries vpc_id / subnet / sg ids)
export interface InfraInput { resources: Row[]; vpcs: Row[]; subnets: Row[]; securityGroups: Row[] }

const str = (v: unknown): string => (v == null ? '' : String(v));

// pull ids from the many shapes a row uses: 'sg-x' | {GroupId} | {SubnetId} | {Id} | availability_zones[].SubnetId
export function idsFrom(v: unknown): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v])
    .map((x) => {
      if (typeof x === 'string') return x;
      const o = (x ?? {}) as Record<string, unknown>;
      return str(o.GroupId ?? o.group_id ?? o.SubnetId ?? o.subnet_id ?? o.Id);
    })
    .filter(Boolean);
}

// human name for an inventory row (Name tag / group_name / title), else its id.
function nameOf(row: Row): string {
  const d = (row.data ?? {}) as Record<string, unknown>;
  const tags = (d.tags ?? {}) as Record<string, unknown>;
  return str(tags.Name ?? d.group_name ?? d.title ?? d.name ?? row.resource_id);
}

export function buildInfraGraph(input: InfraInput): InfraGraph {
  const nodes = new Map<string, InfraNode>();
  const edges = new Map<string, InfraEdge>();
  const addNode = (id: string, kind: string, label: string, meta?: Record<string, unknown>) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, label, meta });
  };
  const addEdge = (source: string, target: string, rel: string) => {
    const id = `${rel}:${source}->${target}`;
    if (!edges.has(id)) edges.set(id, { id, source, target, rel });
  };

  // 1) network nodes from inventory first, so their real names + default-SG flag win over id fallbacks.
  for (const v of input.vpcs) addNode(`vpc:${str(v.resource_id)}`, 'vpc', nameOf(v));
  for (const s of input.subnets) addNode(`subnet:${str(s.resource_id)}`, 'subnet', nameOf(s), {
    vpc: str((s.data as Row)?.vpc_id) || undefined,
  });
  for (const g of input.securityGroups) {
    addNode(`sg:${str(g.resource_id)}`, 'sg', nameOf(g), {
      default: str((g.data as Row)?.group_name) === 'default',
    });
  }

  // 2) resource nodes + placement edges (only resources that actually carry network context)
  for (const r of input.resources) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const vpcId = str(d.vpc_id);
    const subnetIds = [...new Set([...idsFrom(d.subnet_id), ...idsFrom(d.subnet_ids), ...idsFrom(d.subnets), ...idsFrom(d.availability_zones)])];
    const sgIds = [...new Set([...idsFrom(d.security_groups), ...idsFrom(d.security_group_ids), ...idsFrom(d.vpc_security_group_ids)])];
    if (!vpcId && subnetIds.length === 0 && sgIds.length === 0) continue;
    const rid = `${str(r.resource_type)}:${str(r.resource_id)}`;
    // meta.host bridges this node to the trace-topology layer's db-node infra_ref (graph-store.ts
    // resolveInfraRef): only rds rows carry endpoint_address today, so this is a no-op for other types.
    const host = str(d.endpoint_address);
    addNode(rid, str(r.resource_type), nameOf(r), {
      invType: str(r.resource_type), resourceId: str(r.resource_id),
      ...(host ? { host } : {}),
    });
    if (vpcId) { addNode(`vpc:${vpcId}`, 'vpc', vpcId); addEdge(rid, `vpc:${vpcId}`, 'infra:in_vpc'); }
    for (const sid of subnetIds) { addNode(`subnet:${sid}`, 'subnet', sid); addEdge(rid, `subnet:${sid}`, 'infra:in_subnet'); }
    for (const gid of sgIds) { addNode(`sg:${gid}`, 'sg', gid); addEdge(rid, `sg:${gid}`, 'infra:uses_sg'); }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
