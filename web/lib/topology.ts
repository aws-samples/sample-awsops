// Pure infra-topology graph builder — reactflow-independent. Builds a VPC→Subnet→resource
// hierarchy from already-synced inventory rows. Ported from v1 src/app/topology/page.tsx.

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));

export type TopoKind = 'vpc' | 'subnet' | 'ec2' | 'rds' | 'alb';
export interface TopoNode { id: string; kind: TopoKind; label: string }
export interface TopoEdge { id: string; source: string; target: string }
export interface TopoGraph { nodes: TopoNode[]; edges: TopoEdge[] }

// Inventory rows are flattened by the page as { resource_id, region, ...data }.
export interface TopoInput {
  vpc?: Row[]; subnet?: Row[]; ec2?: Row[]; rds?: Row[]; alb?: Row[];
}

/**
 * Build the topology graph. Parent→child edges:
 *   subnet.vpc_id → VPC, ec2.subnet_id → Subnet (fallback ec2.vpc_id → VPC), rds/alb.vpc_id → VPC.
 * Edges are emitted only when BOTH endpoints exist as nodes (no dangling edges). Nodes dedup by id.
 */
export function buildTopology(input: TopoInput): TopoGraph {
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const ids = new Set<string>();
  const edgeIds = new Set<string>();

  const addNode = (id: string, kind: TopoKind, label: string) => {
    if (id.endsWith(':') || ids.has(id)) return; // skip empty resource_id + dedup
    ids.add(id);
    nodes.push({ id, kind, label });
  };
  const addEdge = (source: string, target: string) => {
    if (!ids.has(source) || !ids.has(target)) return; // both endpoints must be real nodes
    const id = `${source}->${target}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, source, target });
  };

  // 1) nodes first so edge endpoint checks resolve
  for (const v of input.vpc ?? []) addNode(`vpc:${str(v.resource_id)}`, 'vpc', str(v.name) || str(v.resource_id));
  for (const s of input.subnet ?? []) addNode(`subnet:${str(s.resource_id)}`, 'subnet', str(s.name) || str(s.resource_id));
  for (const e of input.ec2 ?? []) addNode(`ec2:${str(e.resource_id)}`, 'ec2', str(e.name) || str(e.resource_id));
  for (const r of input.rds ?? []) addNode(`rds:${str(r.resource_id)}`, 'rds', str(r.resource_id));
  for (const a of input.alb ?? []) addNode(`alb:${str(a.resource_id)}`, 'alb', str(a.dns_name) || str(a.resource_id));

  // 2) edges
  for (const s of input.subnet ?? []) addEdge(`vpc:${str(s.vpc_id)}`, `subnet:${str(s.resource_id)}`);
  for (const e of input.ec2 ?? []) {
    const subnetId = `subnet:${str(e.subnet_id)}`;
    if (e.subnet_id && ids.has(subnetId)) addEdge(subnetId, `ec2:${str(e.resource_id)}`);
    else addEdge(`vpc:${str(e.vpc_id)}`, `ec2:${str(e.resource_id)}`); // orphan → fall back to VPC
  }
  for (const r of input.rds ?? []) addEdge(`vpc:${str(r.vpc_id)}`, `rds:${str(r.resource_id)}`);
  for (const a of input.alb ?? []) addEdge(`vpc:${str(a.vpc_id)}`, `alb:${str(a.resource_id)}`);

  return { nodes, edges };
}
