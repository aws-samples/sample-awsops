import type { Pool, PoolClient } from 'pg';
import { inventoryOwners } from './adapters';
import type { EniOwnerInput } from '../eni-owner';
import { currentAccountId } from '../account';
import { graphTransaction } from '../graph-transaction';
import {
  inventoryAttempt,
  inventoryCountsFromClient,
  inventorySnapshotFromClient,
  INFRA_TYPES,
} from '../graph-inventory-read';
import { inventorySourcesStale, readGraphState } from '../graph-state';
import { FLOW_ENRICHMENT, FLOW_INPUT_KEY } from '../flow-inventory-types';
import { currentHead, digest, publishServiceTopology } from './store';
import { boundPublication } from './publication-limit';
import { projectPublished, type GraphRow, type GraphLink } from './published';
import type { Manifest } from './snapshot';

const types = [...new Set([...Object.keys(FLOW_INPUT_KEY), ...INFRA_TYPES, 'ecs_service'])].sort();
const classes = ['flow', 'infra', 'trace'] as const;
const iso = (v: unknown): string | null => {
  const value = v instanceof Date ? v.valueOf() : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
};

// The inventory writer advances the type ledger before changing rows and on completion.
// Row versions are ephemeral change detectors only, never durable evidence IDs.
async function versionToken(c: PoolClient) {
  const { rows } = await c.query(
    `SELECT 'graph' AS domain,class AS key,xmin::text AS ver
    FROM topology_graph_state WHERE account_id='self' AND class=ANY($1)
    UNION ALL SELECT 'inventory',resource_type,xmin::text FROM inventory_sync_runs
    WHERE account_id='self' AND resource_type=ANY($2) ORDER BY domain,key`,
    [classes, types],
  );
  return digest(rows);
}

export async function rebuildServiceTopology(pool: Pool) {
  const { expected, token } = await graphTransaction(pool, true, async (c) => ({
    expected: await currentHead(c),
    token: await versionToken(c),
  }));
  const readPinned = <T>(read: (c: PoolClient) => Promise<T>) =>
    graphTransaction(pool, true, async (c) => {
      if ((await versionToken(c)) !== token) throw new Error('service_input_changed');
      return read(c);
    });
  const rows: GraphRow[] = [],
    edges: GraphLink[] = [],
    sources: Manifest[] = [];
  for (const layer of classes) {
    await readPinned(async (c) => {
      const state = await readGraphState(c, 'self', layer);
      const nodes = await c.query(
        `SELECT id,kind,left(label,512) AS label,run_id,
        left(coalesce(meta->>'region',meta#>>'{row,region}'),64) AS region,
        left(coalesce(meta->>'resourceId',meta#>>'{row,resource_id}'),4097) AS "nativeId",left(meta->>'invType',64) AS "nativeKind",
        ARRAY(SELECT left(h,253) FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(meta->'hosts')='array' THEN meta->'hosts' ELSE '[]'::jsonb END) h
          WHERE length(h)<=253 LIMIT 64) || array_remove(ARRAY[CASE WHEN length(meta->>'host')<=253 THEN meta->>'host' END],NULL) AS hosts,
        left(meta->>'cluster',240) AS cluster,left(meta->>'namespace',240) AS namespace,
        left(coalesce(meta->>'vpcId',meta->>'vpc',meta#>>'{row,vpc_id}'),240) AS vpc,
        left(meta->>'sourceId',240) AS "sourceId", jsonb_build_object(
          'spanCount',meta->'spanCount','errorSpanCount',meta->'errorSpanCount','unknownStatusSpanCount',meta->'unknownStatusSpanCount',
          'sampledDurationMs',meta->'sampledDurationMs') AS meta
        FROM topology_nodes WHERE account_id='self' AND class=$1 ORDER BY id LIMIT 4001`,
        [layer],
      );
      const links = await c.query(
        `SELECT source,target,rel,confidence,run_id,jsonb_build_object(
        'spanCount',meta->'spanCount','metricCount',meta->'metricCount') AS meta FROM topology_edges
        WHERE account_id='self' AND class=$1 ORDER BY source,target,rel LIMIT 8001`,
        [layer],
      );
      const generations = new Set([...nodes.rows, ...links.rows].map((r) => r.run_id));
      const capturedAt = iso(state.captured_at),
        capped = nodes.rows.length > 4000 || links.rows.length > 8000;
      const generation =
        generations.size === 1
          ? [...generations][0]
          : generations.size === 0 && capturedAt && state.status === 'empty'
            ? 'empty-' + capturedAt
            : null;
      const retained = state.retainedPrevious === true;
      const start = state.windowStartMs,
        end = state.windowEndMs;
      const reports = state.publishedSources ?? state.sources;
      const reasons = new Set((reports ?? []).flatMap((r) => r.reasons ?? []));
      const complete =
        generation &&
        capturedAt &&
        !retained &&
        !state.metadataTruncated &&
        Array.isArray(reports) &&
        reports.length > 0 &&
        reports.every((r) => ['ok', 'empty'].includes(r.status) && Array.isArray(r.reasons) && !r.reasons.length) &&
        (layer !== 'trace' ||
          ([state.nodeDrops, state.edgeDrops, state.orphanSpans, state.invalidSpans, state.unresolvedMessaging].every(
            (n) => n === 0,
          ) &&
            !state.infraUnavailable &&
            reports.every(
              (r) => r.windowStartMs != null && r.windowEndMs != null && r.windowEndMs >= r.windowStartMs,
            )));
      if (!complete) reasons.add('unverified_publication');
      sources.push({
        source: layer,
        generation,
        reasons: [...reasons].sort(),
        status: ['ok', 'empty'].includes(state.status) && !complete ? 'partial' : state.status,
        capturedAt,
        attemptedAt: iso(state.attempted_at),
        retained,
        stale: state.stale,
        capped:
          capped || state.inputTruncated === true || state.graphTruncated === true || state.metadataTruncated === true,
        window:
          !retained && typeof start === 'number' && typeof end === 'number' && start <= end ? { start, end } : null,
      });
      for (const n of nodes.rows.slice(0, 4000)) rows.push({ ...n, layer });
      const stored: GraphLink[] = links.rows.slice(0, 8000).map((e) => ({ ...e, layer }));
      if (layer === 'trace') {
        const pairs =
          await c.query(`SELECT e.source,e.target,p.value->>'account' AS account,p.value->>'region' AS region,
          p.value->>'instance_ref' AS instance_ref,p.value->>'database_ref' AS database_ref,
          p.value->>'instance_id' AS instance_id,p.value->>'db_host' AS db_host,p.value->>'provenance' AS provenance,
          p.value->'observed_at_ms' AS observed_at_ms FROM topology_edges e
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.meta->'instance_observations')='array'
            THEN e.meta->'instance_observations' ELSE '[]'::jsonb END) WITH ORDINALITY AS p(value,ord)
          WHERE e.account_id='self' AND e.class='trace' AND e.rel='queries' AND octet_length(p.value::text)<=8192
          ORDER BY e.source,e.target,p.ord LIMIT 1001`);
        const byPair = new Map(
          stored.filter((e) => e.rel === 'queries').map((e) => [JSON.stringify([e.source, e.target]), e]),
        );
        for (const p of pairs.rows.slice(0, 1000)) {
          const edge = byPair.get(JSON.stringify([p.source, p.target]));
          if (edge) (edge.pairs ??= []).push(p as NonNullable<GraphLink['pairs']>[number]);
        }
        if (pairs.rows.length > 1000) sources[sources.length - 1].capped = true;
      }
      edges.push(...stored);
    });
  }
  const counts = await readPinned((c) => inventoryCountsFromClient(c, types));
  const inv = await readPinned((c) =>
    inventorySnapshotFromClient(c, 'flow', 'self', types, counts, [...FLOW_ENRICHMENT]),
  );
  const attempt = inventoryAttempt(inv, types, 'flow', 'self', new Date().toISOString(), FLOW_ENRICHMENT);
  const withheld = new Set(attempt.withheldTypes);
  const records = inv.rows
    .slice(0, 8192)
    .filter((r) => !r.oversized && r.resource_id && r.region && !withheld.has(r.resource_type));
  for (const source of [...attempt.details.sources, ...(attempt.details.enrichmentSources ?? [])]) {
    const type = source.sourceId.slice('inventory:'.length);
    const items = records.filter((r) => r.resource_type === type);
    const stamp = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    sources.push({
      source: 'inventory',
      sourceId: source.sourceId,
      generation: digest([source, items.map((r) => [r.region, r.resource_id, iso(r.captured_at)])]),
      status: source.status,
      capturedAt: stamp(source.capturedAtMs ?? source.lastSuccessAtMs),
      attemptedAt: stamp(source.attemptedAtMs),
      stale: inventorySourcesStale([source]),
      reasons: source.reasons,
      retained: false,
      capped: inv.truncatedTypes.includes(type),
      window: null,
    });
  }
  for (const r of records) {
    const data = r.data as Record<string, unknown> | null;
    const vpc = data?.vpc_id;
    rows.push({
      layer: 'inventory',
      id: JSON.stringify([r.resource_type, r.region, r.resource_id]),
      kind: r.resource_type,
      label: r.resource_type === 'ecs_service' ? String(r.resource_id).split('/').at(-1)! : String(r.resource_id),
      region: String(r.region),
      nativeId: String(r.resource_id),
      nativeKind: r.resource_type,
      vpc: typeof vpc === 'string' ? vpc : undefined,
      cluster: typeof data?.cluster_arn === 'string' ? data.cluster_arn : undefined,
    });
  }
  const trustedAccount = currentAccountId();
  const currentTypes = new Set(
    sources
      .filter((s) => s.source === 'inventory' && !s.stale && !s.capped && s.status === 'ok')
      .map((s) => s.sourceId),
  );
  if (currentTypes.has('inventory:ecs_service') && currentTypes.has('inventory:ecs_task')) {
    const services = new Set(
      records.filter((r) => r.resource_type === 'ecs_service').map((r) => JSON.stringify([r.region, r.resource_id])),
    );
    for (const task of records.filter((r) => r.resource_type === 'ecs_task')) {
      const data = task.data as Record<string, unknown>;
      const arn =
        typeof data.cluster_arn === 'string'
          ? /^arn:aws(?:-[a-z0-9-]+)?:ecs:([a-z0-9-]+):(\d{12}):cluster\/([\w-]+)$/.exec(data.cluster_arn)
          : null;
      const group = typeof data.task_group === 'string' ? /^service:([\w-]+)$/.exec(data.task_group) : null;
      if (!arn || arn[1] !== task.region || arn[2] !== trustedAccount || !group || data.last_status !== 'RUNNING')
        continue;
      const serviceKey = data.cluster_arn + '/' + group[1];
      if (services.has(JSON.stringify([task.region, serviceKey])))
        edges.push({
          layer: 'inventory',
          source: JSON.stringify(['ecs_task', task.region, task.resource_id]),
          target: JSON.stringify(['ecs_service', task.region, serviceKey]),
          rel: 'member-of',
          confidence: 'configuration',
        });
    }
  }
  // Preserve ENI associations independently of LB targets. Each relation describes
  // the recorded interface configuration, including the producer's confidence.
  const ownerTypes = new Set([
    'eni',
    'ec2',
    'alb',
    'nlb',
    'lambda',
    'rds',
    'rds_cluster',
    'rds_proxy',
    'vpc_endpoint',
    'nat_gateway',
  ]);
  const incomplete = new Set(
    sources
      .filter(
        (m) => m.source === 'inventory' && (m.stale || m.capped || m.retained || !['ok', 'empty'].includes(m.status)),
      )
      .map((m) => m.sourceId!.slice('inventory:'.length)),
  );
  const owners: EniOwnerInput = {};
  for (const r of records)
    if (ownerTypes.has(r.resource_type)) {
      const k = r.resource_type as keyof EniOwnerInput;
      (owners[k] ??= []).push({
        ...(r.data as object),
        resource_id: r.resource_id,
        region: r.region,
        account_id: r.account_id,
      });
    }
  const eniRecords = new Map(rows.filter((r) => r.layer === 'inventory' && r.kind === 'eni').map((r) => [r.id, r]));
  const byRegion = new Map<string, ReturnType<typeof inventoryOwners>>();
  for (const eni of owners.eni ?? []) {
    const region = String(eni.region),
      ip = eni.private_ip_address,
      vpc = eni.vpc_id;
    if (typeof ip !== 'string' || typeof vpc !== 'string') continue;
    let resolve = byRegion.get(region);
    if (!resolve) {
      resolve = inventoryOwners({ account: 'self', region, vpc: null }, owners, incomplete);
      byRegion.set(region, resolve);
    }
    const result = resolve(ip, vpc);
    const owner = 'owner' in result ? result.owner : undefined;
    const row = eniRecords.get(JSON.stringify(['eni', region, eni.resource_id]));
    if (row) row.ownerReason = owner && incomplete.has(owner.kind) ? 'owner_inventory_incomplete' : result.reason;
    if (!owner || incomplete.has(owner.kind)) continue;
    edges.push({
      layer: 'inventory',
      source: JSON.stringify(['eni', region, eni.resource_id]),
      target: JSON.stringify([owner.kind, region, owner.resourceId]),
      rel: 'eni-owner-record',
      confidence: owner.confidence,
    });
  }
  const snap = boundPublication(projectPublished(rows, edges, sources, currentAccountId()));
  const result = await publishServiceTopology(pool, snap, expected, async (c) => (await versionToken(c)) === token);
  return {
    ...result,
    entities: snap.entities.length,
    relations: snap.relations.length,
    gaps: snap.gaps,
    partialInputs:
      snap.gaps.some((g) => g.startsWith('projection_limit:')) ||
      snap.sources.some(
        (s) => s.stale || s.retained || s.capped || !s.generation || !['ok', 'empty'].includes(s.status),
      ),
  };
}
