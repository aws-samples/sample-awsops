// Client-safe K8s resource types + pure parsing/aggregation.
// CRITICAL: this module must have NO server-only imports (no node:https, no @aws-sdk).
// eks-incluster.ts (server) imports from here; 'use client' pages import from here too,
// so the browser bundle never pulls in the server STS/HTTPS code.

export interface NodeCondition {
  type: string;
  status: string;
  reason: string;
  message: string;
}

export interface NodeTaint {
  key: string;
  value: string;
  effect: string;
}

export interface NodeRow {
  name: string; status: string; roles: string; version: string; instanceType: string; zone: string; age: string;
  // capacity/allocatable: cpu in cores, memory in MiB (0 when the API didn't report it).
  cpuCapacity: number; cpuAllocatable: number; memCapacity: number; memAllocatable: number;
  // ephemeral-storage capacity/allocatable in MiB (0 when the API didn't report it).
  diskCapacity: number; diskAllocatable: number;
  // Detail-only metadata for node drilldowns. Secrets are never included here.
  labels?: Record<string, string>;
  taints?: NodeTaint[];
  conditions?: NodeCondition[];
  /** v1 parity (node capacity card): the node's pod CIDR + creation timestamp. */
  podCIDR?: string;
  createdAt?: string;
}
export interface PodRow {
  name: string; namespace: string; status: string; node: string; restarts: number; age: string;
  // summed container requests: cpu in cores, memory in MiB, ephemeral-storage in MiB.
  cpuRequest: number; memRequest: number; diskRequest: number;
  // for topology: pod IP (matches an ALB/NLB target IP) + owning workload (Deployment/etc.).
  podIP?: string; workload?: string;
}

/** Parse a K8s CPU quantity to cores: "8"→8, "7910m"→7.91, ""/null→0. */
export function parseCpuCores(cpu: unknown): number {
  if (cpu == null || cpu === '') return 0;
  const s = String(cpu).trim();
  if (s.endsWith('m')) return (parseFloat(s) || 0) / 1000;
  return parseFloat(s) || 0;
}

/**
 * Parse a K8s memory quantity to MiB: "32986188Ki"→32213, "512Mi"→512, "2Gi"→2048.
 * K8s quantity semantics (P4 gate: codex): binary suffixes (Ki/Mi/Gi/Ti) are
 * 1024-based, decimal suffixes (k/K/M/G/T) are 1000-based BYTES, and a bare
 * number is plain BYTES — not MiB. ""/null/unparseable → 0.
 */
export function parseMem(mem: unknown): number {
  if (mem == null || mem === '') return 0;
  const s = String(mem).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|k|K|M|G|T)?$/);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const MI = 1024 * 1024;
  switch (m[2] ?? '') {
    case 'Ki': return Math.round(v / 1024);
    case 'Mi': return Math.round(v);
    case 'Gi': return Math.round(v * 1024);
    case 'Ti': return Math.round(v * 1024 * 1024);
    case 'k': case 'K': return Math.round((v * 1e3) / MI);
    case 'M': return Math.round((v * 1e6) / MI);
    case 'G': return Math.round((v * 1e9) / MI);
    case 'T': return Math.round((v * 1e12) / MI);
    default: return Math.round(v / MI); // bare quantity = bytes
  }
}

export interface NodeResourceAgg {
  name: string;
  instanceType: string;
  cpuAllocatable: number; cpuRequest: number; cpuPct: number;
  memAllocatable: number; memRequest: number; memPct: number;
  diskAllocatable: number; diskRequest: number; diskPct: number;
  podCount: number;
}

/**
 * Aggregate pod requests per node against node allocatable.
 * Pods are matched to a node by PodRow.node === NodeRow.name. reqPct is clamped 0..100
 * (0 when allocatable is 0/unknown). Nodes with no scheduled pods report zeros.
 */
export function aggregateNodeResources(nodes: NodeRow[], pods: PodRow[]): NodeResourceAgg[] {
  const byNode = new Map<string, { cpu: number; mem: number; disk: number; count: number }>();
  for (const p of pods) {
    if (!p.node) continue;
    const e = byNode.get(p.node) ?? { cpu: 0, mem: 0, disk: 0, count: 0 };
    e.cpu += p.cpuRequest || 0;
    e.mem += p.memRequest || 0;
    e.disk += p.diskRequest || 0;
    e.count += 1;
    byNode.set(p.node, e);
  }
  const pct = (req: number, alloc: number) => (alloc > 0 ? Math.min(100, Math.round((req / alloc) * 100)) : 0);
  return nodes.map((n) => {
    const e = byNode.get(n.name) ?? { cpu: 0, mem: 0, disk: 0, count: 0 };
    return {
      name: n.name,
      instanceType: n.instanceType,
      cpuAllocatable: n.cpuAllocatable, cpuRequest: e.cpu, cpuPct: pct(e.cpu, n.cpuAllocatable),
      memAllocatable: n.memAllocatable, memRequest: e.mem, memPct: pct(e.mem, n.memAllocatable),
      diskAllocatable: n.diskAllocatable, diskRequest: e.disk, diskPct: pct(e.disk, n.diskAllocatable),
      podCount: e.count,
    };
  });
}

/**
 * Count nodes per instanceType, blank → 'unknown', sorted by count desc
 * (ties broken by type name for stable output).
 */
export function instanceTypeDistribution(nodes: NodeRow[]): { type: string; count: number }[] {
  const m = new Map<string, number>();
  for (const n of nodes) {
    const type = n.instanceType || 'unknown';
    m.set(type, (m.get(type) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
