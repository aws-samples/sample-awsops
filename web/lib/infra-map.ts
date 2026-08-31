// Pure MapGraph builder for the /topology/infra columnar map views (gap-audit L163).
// React-free: unit-tested with vitest; the ReactFlow rendering lives in
// components/topology/MapCanvas.tsx.

export type MapKind =
  | 'igw' | 'tgw' | 'vpc' | 'subnet' | 'ec2' | 'alb' | 'nlb' | 'rds' | 'nat'
  | 'ingress' | 'service' | 'pod' | 'node';

export interface MapNode {
  id: string;            // `${kind}:${resourceId}` — unique across kinds
  kind: MapKind;
  column: number;
  label: string;
  sub?: string;
  badge?: string;
  status?: 'ok' | 'warn' | 'bad' | 'neutral';
  meta: Record<string, unknown>; // searchable extras (ids, IPs, types)
}
export interface MapEdge { source: string; target: string }
export interface MapGraph { nodes: MapNode[]; edges: MapEdge[] }

export interface InvRow { resource_id: string; account_id?: string | null; region: string | null; data: Record<string, unknown> }

/** Node id scoped by account+region — inventory_resources' key is (type, account, region, id). */
export function invNodeId(kind: MapKind, r: InvRow): string {
  return `${kind}:${r.account_id ?? 'self'}/${r.region ?? ''}/${r.resource_id}`;
}

export interface TgwAttachmentLite { tgwId: string; resourceType: string; resourceId: string; state?: string }

export interface InfraMapInput {
  igw: InvRow[]; tgw: InvRow[]; vpc: InvRow[]; subnet: InvRow[];
  ec2: InvRow[]; alb: InvRow[]; nlb: InvRow[]; rds: InvRow[]; nat: InvRow[];
  /** VPC attachments from GET /api/tgw?ids=… (live) — optional; absent → TGW nodes render edge-less. */
  tgwAttachments?: TgwAttachmentLite[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

const EC2_STATUS: Record<string, MapNode['status']> = {
  running: 'ok', stopped: 'warn', terminated: 'bad', 'shutting-down': 'bad',
  pending: 'neutral', stopping: 'warn',
};

/** Loadbalancer rows carry subnet membership as availability_zones[].SubnetId. */
function lbSubnets(data: Record<string, unknown>): string[] {
  const azs = Array.isArray(data.availability_zones) ? data.availability_zones : [];
  return azs
    .map((a) => str((a as Record<string, unknown>).SubnetId ?? (a as Record<string, unknown>).subnet_id))
    .filter(Boolean);
}

export function buildInfraMap(input: InfraMapInput): MapGraph {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const scopeKey = (r: InvRow, raw: string) => `${r.account_id ?? 'self'}|${r.region ?? ''}|${raw}`;
  // raw AWS id, scoped to the row's own account+region → node id
  const vpcNode = new Map(input.vpc.map((r) => [scopeKey(r, r.resource_id), invNodeId('vpc', r)]));
  const subnetNode = new Map(input.subnet.map((r) => [scopeKey(r, r.resource_id), invNodeId('subnet', r)]));
  const subnetVpc = new Map(input.subnet.map((r) => [scopeKey(r, r.resource_id), str(r.data.vpc_id)]));
  // raw VPC id → node ids across all scopes (TGW attachments carry no account/region)
  const vpcByRaw = new Map<string, string[]>();
  for (const r of input.vpc) {
    const list = vpcByRaw.get(r.resource_id) ?? [];
    list.push(invNodeId('vpc', r));
    vpcByRaw.set(r.resource_id, list);
  }
  const label = (r: InvRow) => str(r.data.name) || r.resource_id;
  const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));

  // ── column 0: External (IGW · TGW) ─────────────────────────────────────
  for (const r of [...input.igw].sort(byKey(label))) {
    nodes.push({ id: invNodeId('igw', r), kind: 'igw', column: 0, label: label(r), sub: r.resource_id, status: 'neutral', meta: r.data });
    const atts = Array.isArray(r.data.attachments) ? (r.data.attachments as Record<string, unknown>[]) : [];
    for (const a of atts) {
      const v = vpcNode.get(scopeKey(r, str(a.VpcId ?? a.vpc_id)));
      if (v) edges.push({ source: invNodeId('igw', r), target: v });
    }
  }
  for (const r of [...input.tgw].sort(byKey(label))) {
    nodes.push({
      id: invNodeId('tgw', r), kind: 'tgw', column: 0, label: label(r),
      sub: str(r.data.description) || r.resource_id,
      status: str(r.data.state) === 'available' ? 'ok' : 'warn', meta: r.data,
    });
  }
  for (const a of input.tgwAttachments ?? []) {
    if (a.resourceType !== 'vpc') continue;
    // Only an 'available' attachment is live connectivity (allowlist — pending/initiating/
    // pendingAcceptance/failed/deleting must not render as an existing edge). A row with no
    // state field (older/partial sources) keeps drawing — unknown ≠ known-dead.
    if (a.state && a.state !== 'available') continue;
    const matches = vpcByRaw.get(a.resourceId) ?? [];
    if (matches.length !== 1) continue; // 0 = unknown vpc, >1 = ambiguous across scopes — never guess
    for (const t of [...input.tgw]) {
      if (t.resource_id === a.tgwId) edges.push({ source: invNodeId('tgw', t), target: matches[0] });
    }
  }

  // ── column 1: VPC ──────────────────────────────────────────────────────
  for (const r of [...input.vpc].sort(byKey(label))) {
    nodes.push({
      id: invNodeId('vpc', r), kind: 'vpc', column: 1, label: label(r),
      sub: `${str(r.data.cidr_block)} · ${r.resource_id}`,
      badge: r.data.is_default === true ? 'default' : undefined, status: 'neutral', meta: r.data,
    });
  }

  // ── column 2: Subnet (sorted by vpc, az, name) ─────────────────────────
  const subnetSort = (r: InvRow) => `${str(r.data.vpc_id)}|${str(r.data.availability_zone)}|${label(r)}`;
  for (const r of [...input.subnet].sort(byKey(subnetSort))) {
    const pub = r.data.map_public_ip_on_launch === true;
    nodes.push({
      id: invNodeId('subnet', r), kind: 'subnet', column: 2, label: label(r),
      sub: str(r.data.cidr_block),
      badge: [str(r.data.availability_zone), pub ? 'auto-public-ip' : ''].filter(Boolean).join(' · '),
      status: 'neutral', meta: r.data,
    });
    const v = vpcNode.get(scopeKey(r, str(r.data.vpc_id)));
    if (v) edges.push({ source: v, target: invNodeId('subnet', r) });
  }

  // ── column 3: Compute (EC2 · ALB · NLB · RDS; sorted by vpc, subnet, kind, name) ──
  type ComputeEntry = { r: InvRow; kind: MapKind; subnets: string[]; vpc: string };
  const compute: ComputeEntry[] = [
    ...input.ec2.map((r) => ({ r, kind: 'ec2' as MapKind, subnets: [str(r.data.subnet_id)].filter(Boolean), vpc: str(r.data.vpc_id) })),
    ...input.alb.map((r) => ({ r, kind: 'alb' as MapKind, subnets: lbSubnets(r.data), vpc: str(r.data.vpc_id) })),
    ...input.nlb.map((r) => ({ r, kind: 'nlb' as MapKind, subnets: lbSubnets(r.data), vpc: str(r.data.vpc_id) })),
    // The synced rds row carries vpc_id but no subnet ids (only db_subnet_group_name) —
    // RDS therefore attaches at the VPC.
    ...input.rds.map((r) => ({ r, kind: 'rds' as MapKind, subnets: [] as string[], vpc: str(r.data.vpc_id) })),
  ].sort(byKey((c) => `${c.vpc || subnetVpc.get(scopeKey(c.r, c.subnets[0] ?? '')) || ''}|${c.subnets[0] ?? ''}|${c.kind}|${label(c.r)}`));
  for (const c of compute) {
    const id = invNodeId(c.kind, c.r);
    const d = c.r.data;
    const node: MapNode = { id, kind: c.kind, column: 3, label: label(c.r), status: 'neutral', meta: d };
    if (c.kind === 'ec2') {
      node.sub = str(d.instance_type);
      node.badge = str(d.private_ip_address);
      node.status = EC2_STATUS[str(d.instance_state)] ?? 'neutral';
    } else if (c.kind === 'alb' || c.kind === 'nlb') {
      node.sub = `${c.kind.toUpperCase()} · ${str(d.scheme)}`;
      node.status = str(d.state_code) === 'active' ? 'ok' : 'warn';
    } else {
      node.sub = `${str(d.engine)} · ${str(d.class)}`;
      node.status = str(d.status) === 'available' ? 'ok' : 'warn';
    }
    nodes.push(node);
    let linked = false;
    for (const s of c.subnets) {
      const sn = subnetNode.get(scopeKey(c.r, s));
      if (sn) { edges.push({ source: sn, target: id }); linked = true; }
    }
    if (!linked) {
      const v = vpcNode.get(scopeKey(c.r, c.vpc));
      if (v) edges.push({ source: v, target: id });
    }
  }

  // ── column 4: NAT (sorted by vpc, subnet) ──────────────────────────────
  const natSort = (r: InvRow) => `${str(r.data.vpc_id)}|${str(r.data.subnet_id)}|${r.resource_id}`;
  for (const r of [...input.nat].sort(byKey(natSort))) {
    const id = invNodeId('nat', r);
    nodes.push({
      id, kind: 'nat', column: 4, label: label(r), sub: r.resource_id,
      status: str(r.data.state) === 'available' ? 'ok' : 'warn', meta: r.data,
    });
    const sn = subnetNode.get(scopeKey(r, str(r.data.subnet_id)));
    if (sn) edges.push({ source: sn, target: id });
    else {
      const v = vpcNode.get(scopeKey(r, str(r.data.vpc_id)));
      if (v) edges.push({ source: v, target: id });
    }
  }

  return { nodes, edges };
}

/** Selected node + transitive ancestors + transitive descendants (siblings stay out). */
export function highlightClosure(graph: MapGraph, selectedId: string): Set<string> {
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!down.has(e.source)) down.set(e.source, []);
    down.get(e.source)!.push(e.target);
    if (!up.has(e.target)) up.set(e.target, []);
    up.get(e.target)!.push(e.source);
  }
  const out = new Set<string>([selectedId]);
  const walk = (start: string, dir: Map<string, string[]>) => {
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      for (const m of dir.get(n) ?? []) if (!out.has(m)) { out.add(m); stack.push(m); }
    }
  };
  walk(selectedId, up);
  walk(selectedId, down);
  return out;
}

/** Case-insensitive substring match over id/label/sub/badge + all meta leaf values. */
export function searchMatches(graph: MapGraph, query: string): Set<string> {
  const needle = query.trim().toLowerCase();
  if (!needle) return new Set();
  const hit = (v: unknown): boolean =>
    typeof v === 'string' ? v.toLowerCase().includes(needle)
    : typeof v === 'number' ? String(v).includes(needle)
    : Array.isArray(v) ? v.some(hit)
    : v !== null && typeof v === 'object' ? Object.values(v).some(hit)
    : false;
  return new Set(
    graph.nodes
      .filter((n) =>
        n.id.toLowerCase().includes(needle) ||
        n.label.toLowerCase().includes(needle) ||
        (n.sub ?? '').toLowerCase().includes(needle) ||
        (n.badge ?? '').toLowerCase().includes(needle) ||
        hit(n.meta))
      .map((n) => n.id),
  );
}
