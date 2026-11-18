import { DB_ENDPOINT_KINDS } from '../infra-topology';
import { createHash } from 'node:crypto';
import { spanMeasurements, edgeCounts } from './metrics';
import type { Layer, Manifest, Entity, Relation, ServiceSnapshot } from './snapshot';

export interface GraphRow {
  layer: Layer;
  id: string;
  kind: string;
  label: string;
  region?: string;
  vpc?: string;
  cluster?: string;
  namespace?: string;
  ownerReason?: string;
  hosts?: string[];
  nativeId?: string;
  nativeKind?: string;
  sourceId?: string;
  meta?: Record<string, unknown>;
}
interface StoredPair {
  account: string;
  region: string;
  instance_ref: string;
  database_ref: string;
  instance_id: string;
  db_host: string;
  source_id?: string;
  provenance: string;
  observed_at_ms: number;
}
export interface GraphLink {
  layer: Layer;
  source: string;
  target: string;
  rel: string;
  confidence: string;
  pairs?: StoredPair[];
  meta?: unknown;
}
const hash = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const order = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const nativeKinds = new Set([
  'ec2',
  'ecs_task',
  'ecs_service',
  'lambda',
  'rds',
  'rds_cluster',
  'rds_proxy',
  'elasticache',
  'vpc',
  'subnet',
  'security_group',
  'alb',
  'nlb',
  'target_group',
  's3',
  'nat_gateway',
  'vpc_endpoint',
  'eni',
]);
const safe = (v: unknown, max = 240) => (typeof v === 'string' && v.length <= max ? v : null);

export function projectPublished(
  rows: GraphRow[],
  edges: GraphLink[],
  sources: Manifest[],
  hostAccount?: string,
): ServiceSnapshot {
  const qualified = new Set(
    sources
      .filter((s) => !!s.generation && s.status === 'ok' && !s.stale && !s.capped && !s.retained)
      .map((s) => s.sourceId ?? s.source),
  );
  const gaps = new Set(['nfm:not_collected', 'kubernetes:live_ownership_unavailable']);
  for (const s of sources)
    if ((!qualified.has(s.sourceId ?? s.source) && s.status !== 'empty') || s.stale || s.capped || s.retained)
      gaps.add(
        (s.sourceId ?? s.source) +
          ':' +
          (s.capped ? 'capped' : s.retained ? 'retained' : s.stale ? 'stale_or_unknown' : s.status),
      );
  const entities = new Map<string, Entity>(),
    refs = new Map<string, string>();
  const relations = new Map<string, Relation>();
  for (const r of rows) {
    // Only stored inventory/configuration producers share a native identity namespace.
    // Telemetry claims, display targets and inferred owners keep their source-local ID.
    const native =
      r.layer !== 'trace' &&
      !['target', 'more', 'origin'].includes(r.kind) &&
      (qualified.has(r.layer) || (r.layer === 'inventory' && qualified.has('inventory:' + r.nativeKind))) &&
      !!r.region &&
      !!r.nativeId &&
      r.nativeId.length <= 4096 &&
      nativeKinds.has(r.nativeKind ?? '');
    const id = native
      ? hash(['self', 'resource', r.region!, r.nativeKind!, r.nativeId!])
      : hash(['self', r.layer, r.id]);
    refs.set(JSON.stringify([r.layer, r.id]), id);
    const prior = entities.get(id);
    if (prior) {
      if (!prior.layers.includes(r.layer)) prior.layers.push(r.layer);
      prior.evidenceRefs.push(JSON.stringify([r.layer, r.id]));
      continue;
    }
    const measure = spanMeasurements(r.layer === 'trace' && r.kind === 'service' ? r.meta : {});
    entities.set(id, {
      id,
      kind: native ? r.nativeKind! : r.kind,
      label: safe(r.label, 512) ?? r.kind,
      layers: [r.layer],
      evidenceRefs: [JSON.stringify([r.layer, r.id])],
      region: safe(r.region, 64),
      sourceId: safe(r.sourceId),
      vpc: safe(r.vpc),
      cluster: safe(r.cluster),
      namespace: safe(r.namespace),
      ownerReason: r.layer === 'inventory' && r.kind === 'eni' ? safe(r.ownerReason, 64) : null,
      claim: r.layer === 'trace' && ['model', 'runtime', 'queue'].includes(r.kind),
      spanCount: measure.spanCount,
      errors: measure.errors,
      knownStatus: measure.knownStatus,
      durationSumMs: measure.durationSumMs,
    });
  }
  const nativeRefs = new Map<string, string[]>();
  for (const r of rows)
    if (r.layer === 'infra') {
      const k = JSON.stringify([r.region, r.nativeKind, r.nativeId]);
      const ids = nativeRefs.get(k) ?? [];
      ids.push(r.id);
      nativeRefs.set(k, ids);
    }
  const lookup = new Map(rows.map((r) => [JSON.stringify([r.layer, r.id]), r]));
  const traceWindow = sources.find((s) => s.source === 'trace')?.window;
  for (const e of edges) {
    const source = refs.get(JSON.stringify([e.layer, e.source])),
      target = refs.get(JSON.stringify([e.layer, e.target]));
    if (!source || !target) {
      gaps.add(e.layer + ':missing_endpoint');
      continue;
    }
    const id = hash([e.layer, source, target, e.rel, e.source, e.target]);
    relations.set(id, {
      id,
      source,
      target,
      kind: e.rel,
      layer: e.layer,
      confidence: e.confidence,
      evidenceRefs: [JSON.stringify([e.layer, e.source, e.target, e.rel])],
      ...(e.layer === 'trace' ? edgeCounts(e.meta) : {}),
    });
    if (!e.pairs?.length || e.layer !== 'trace' || e.rel !== 'queries') continue;
    const reported = lookup.get(JSON.stringify(['trace', e.target]));
    for (const pair of e.pairs) {
      const instance = lookup.get(JSON.stringify(['infra', pair.instance_ref]));
      const database = lookup.get(JSON.stringify(['infra', pair.database_ref]));
      const normalizeHost = (h: string) => h.toLowerCase().replace(/\.$/, '');
      const matchesHost = (r: GraphRow | undefined) =>
        r?.hosts?.some((host) => normalizeHost(host) === normalizeHost(pair.db_host));
      if (
        !hostAccount ||
        !/^\d{12}$/.test(hostAccount) ||
        pair.account !== hostAccount ||
        !qualified.has('trace') ||
        !qualified.has('infra') ||
        !traceWindow ||
        !Number.isSafeInteger(pair.observed_at_ms) ||
        pair.observed_at_ms < traceWindow.start ||
        pair.observed_at_ms > traceWindow.end ||
        pair.provenance !== 'trace_span' ||
        instance?.kind !== 'ec2' ||
        instance.nativeId !== pair.instance_id ||
        !database ||
        !DB_ENDPOINT_KINDS.has(database.kind) ||
        nativeRefs.get(JSON.stringify([instance.region, instance.nativeKind, instance.nativeId]))?.length !== 1 ||
        nativeRefs.get(JSON.stringify([database.region, database.nativeKind, database.nativeId]))?.length !== 1 ||
        !pair.region ||
        instance.region !== pair.region ||
        database.region !== pair.region ||
        typeof pair.db_host !== 'string' ||
        !pair.db_host ||
        reported?.kind !== 'db' ||
        !matchesHost(reported) ||
        !matchesHost(database)
      ) {
        gaps.add('trace:unverified_database_pair');
        continue;
      }
      const dbId = refs.get(JSON.stringify(['infra', database.id]))!;
      const instanceId = refs.get(JSON.stringify(['infra', instance.id]))!;
      // Promote only a pair carried by the original query edge. Shared services never imply other pairs.
      for (const [from, kind] of [
        [instanceId, 'instance-database'],
        [target, 'database-record'],
      ] as const) {
        const linkId = hash(['trace', from, dbId, kind]);
        const evidenceRef = JSON.stringify([
          'trace',
          e.source,
          e.target,
          'queries',
          pair.instance_ref,
          pair.database_ref,
        ]);
        const prior = relations.get(linkId);
        if (prior) {
          if (!prior.evidenceRefs.includes(evidenceRef)) prior.evidenceRefs.push(evidenceRef);
        } else
          relations.set(linkId, {
            id: linkId,
            source: from,
            target: dbId,
            kind,
            layer: 'trace',
            confidence: 'observed',
            evidenceRefs: [evidenceRef],
          });
      }
    }
  }
  for (const e of entities.values()) {
    e.layers.sort();
    e.evidenceRefs.sort();
  }
  for (const e of relations.values()) e.evidenceRefs.sort();
  return {
    entities: [...entities.values()].sort(order),
    relations: [...relations.values()].sort(order),
    sources,
    gaps: [...gaps].sort(),
  };
}
