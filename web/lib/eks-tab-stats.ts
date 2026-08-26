// Pure aggregation helpers for the EKS tab/fleet visualizations.
// CRITICAL: client-safe — no server-only imports (mirrors eks-resources.ts).

export function podStatusCounts(rows: { status?: unknown }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) { const s = String(r.status ?? '') || 'Unknown'; out[s] = (out[s] ?? 0) + 1; }
  return out;
}

export function podsByNamespace(rows: { namespace?: unknown }[]): { namespace: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) { const ns = String(r.namespace ?? '') || '—'; m.set(ns, (m.get(ns) ?? 0) + 1); }
  return [...m.entries()].map(([namespace, count]) => ({ namespace, count }))
    .sort((a, b) => b.count - a.count || a.namespace.localeCompare(b.namespace));
}

export interface DeploymentHealth { name: string; namespace: string; desired: number; available: number; pct: number }
// pct = available/desired (spec §3.3 "available / desired" — availableReplicas, not
// readyReplicas; the two can diverge mid-rollout, which is the intended signal).
export function deploymentHealth(rows: { name?: unknown; namespace?: unknown; ready?: unknown; available?: unknown }[]): DeploymentHealth[] {
  return rows.map((r) => {
    const parts = String(r.ready ?? '').split('/');
    const desired = parseInt(parts[1] ?? '0', 10) || 0;
    // fall back to the ready numerator when available is absent
    const available = r.available != null ? Number(r.available) || 0 : parseInt(parts[0] ?? '0', 10) || 0;
    const pct = desired > 0 ? Math.max(0, Math.min(100, Math.round((available / desired) * 100))) : 100;
    return { name: String(r.name ?? ''), namespace: String(r.namespace ?? ''), desired, available, pct };
  }).sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name));
}

export function serviceTypeCounts(rows: { type?: unknown }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) { const t = String(r.type ?? '') || 'Unknown'; out[t] = (out[t] ?? 0) + 1; }
  return out;
}
