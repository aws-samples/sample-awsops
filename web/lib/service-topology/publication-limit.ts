import type { ServiceSnapshot } from './snapshot';

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const defaults = { nodes: 20000, edges: 32000, bytes: 8 * 1024 * 1024 };

export function boundPublication(s: ServiceSnapshot, limit = defaults): ServiceSnapshot {
  if (s.entities.length <= limit.nodes && s.relations.length <= limit.edges && bytes(s) <= limit.bytes) return s;
  const out: ServiceSnapshot = { sources: s.sources, gaps: [...s.gaps], entities: [], relations: [] };
  // Reserve room for omission counters. Payload sizes include a conservative comma per row.
  let remaining = limit.bytes - bytes(out) - 160;
  if (remaining < 0) throw new Error('service_manifest_limit');
  const nodeBudget = Math.floor(remaining * (s.relations.length ? 0.65 : 1));
  let used = 0;
  const priority = (kind: string) => (['service', 'ecs_service', 'lambda'].includes(kind) ? 0 : 1);
  const nodes = [...s.entities].sort((a, b) => priority(a.kind) - priority(b.kind) || a.id.localeCompare(b.id));
  for (const e of nodes) {
    if (out.entities.length === limit.nodes) break;
    const size = bytes(e) + 1;
    if (used + size <= nodeBudget) {
      out.entities.push(e);
      used += size;
    }
  }
  remaining -= used;
  const ids = new Set(out.entities.map((e) => e.id));
  for (const r of s.relations) {
    if (out.relations.length === limit.edges) break;
    if (!ids.has(r.source) || !ids.has(r.target)) continue;
    const size = bytes(r) + 1;
    if (size <= remaining) {
      out.relations.push(r);
      remaining -= size;
    }
  }
  out.gaps.push(
    'projection_limit:entities_omitted=' + String(s.entities.length - out.entities.length),
    'projection_limit:relations_omitted=' + String(s.relations.length - out.relations.length),
  );
  return out;
}
