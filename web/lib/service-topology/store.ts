import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { servicePublicationTransaction } from '../graph-transaction';
import { SERVICE_SCOPE, type ServiceSnapshot } from './snapshot';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function currentHead(client: PoolClient): Promise<string | null> {
  const r = await client.query('SELECT snapshot_id FROM public.service_topology_heads WHERE scope_key=$1', [
    SERVICE_SCOPE,
  ]);
  return r.rows[0]?.snapshot_id ?? null;
}

// The caller verifies source versions in this transaction before the head moves.
export async function publishServiceTopology(
  pool: Pool,
  snapshot: ServiceSnapshot,
  expectedHead: string | null,
  verify: (client: PoolClient) => Promise<boolean>,
) {
  if (
    snapshot.entities.length > 20000 ||
    snapshot.relations.length > 32000 ||
    Buffer.byteLength(JSON.stringify(snapshot)) > 8 * 1024 * 1024
  )
    throw new Error('service_projection_limit');
  const body = digest([snapshot.entities, snapshot.relations]);
  return servicePublicationTransaction(pool, async (client) => {
    const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [0x73766331]);
    if (!lock.rows[0]?.acquired || (await currentHead(client)) !== expectedHead || !(await verify(client)))
      throw new Error('service_input_changed');
    if (
      snapshot.entities.length === 0 &&
      !(
        snapshot.sources.length &&
        snapshot.sources.every((s) => s.status === 'empty' && !!s.generation && !s.retained && !s.stale && !s.capped)
      )
    )
      throw new Error('unconfirmed_empty_projection');
    const batches: string[] = [];
    for (const m of snapshot.sources) {
      const id = digest([SERVICE_SCOPE, m]);
      batches.push(id);
      await client.query(
        `INSERT INTO public.topology_source_batches
        (batch_id,scope_key,source_id,generation_key,status,captured_at,attempted_at,window_start,window_end,stale,retained,capped,reasons)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(batch_id) DO NOTHING`,
        [
          id,
          SERVICE_SCOPE,
          m.sourceId ?? m.source,
          m.generation,
          m.status,
          m.capturedAt,
          m.attemptedAt,
          m.window ? new Date(m.window.start) : null,
          m.window ? new Date(m.window.end) : null,
          m.stale,
          m.retained,
          m.capped,
          m.reasons ?? [],
        ],
      );
    }
    const last = expectedHead
      ? (await client.query('SELECT * FROM public.service_topology_snapshots WHERE snapshot_id=$1', [expectedHead]))
          .rows[0]
      : null;
    const same = last?.content_digest === body;
    if (
      same &&
      JSON.stringify(last.batch_ids) === JSON.stringify(batches) &&
      JSON.stringify(last.gaps) === JSON.stringify(snapshot.gaps)
    )
      return { snapshotId: expectedHead!, outcome: 'unchanged' };
    const id = randomUUID(),
      now = new Date();
    await client.query(
      `INSERT INTO public.service_topology_snapshots
      (snapshot_id,scope_key,version,built_at,batch_ids,gaps,content_digest,body_snapshot_id)
      VALUES($1,$2,1,$3,$4,$5,$6,$7)`,
      [id, SERVICE_SCOPE, now, batches, snapshot.gaps, body, same ? (last.body_snapshot_id ?? expectedHead) : null],
    );
    if (!same) {
      await client.query(
        `INSERT INTO public.service_topology_entities
        SELECT $1,e.id,e.kind,e.label,e.layers,e.claim,e.region,e."sourceId",e."spanCount",e."knownStatus",e.errors,e."durationSumMs",e."evidenceRefs",e.cluster,e.namespace,e.vpc,e."ownerReason"
        FROM jsonb_to_recordset($2::jsonb) AS e(id text,kind text,label text,layers text[],claim boolean,region text,
        "sourceId" text,"spanCount" bigint,"knownStatus" bigint,errors bigint,"durationSumMs" double precision,"evidenceRefs" text[],cluster text,namespace text,vpc text,"ownerReason" text)`,
        [id, JSON.stringify(snapshot.entities)],
      );
      await client.query(
        `INSERT INTO public.service_topology_relations
        SELECT $1,e.id,e.source,e.target,e.kind,e.layer,e.confidence,e."spanCount",e."metricCount",e."evidenceRefs"
        FROM jsonb_to_recordset($2::jsonb) AS e(id text,source text,target text,kind text,layer text,confidence text,
        "spanCount" bigint,"metricCount" double precision,"evidenceRefs" text[])`,
        [id, JSON.stringify(snapshot.relations)],
      );
    }
    await client.query(
      `INSERT INTO public.service_topology_heads VALUES($1,$2,$3) ON CONFLICT(scope_key)
      DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,published_at=EXCLUDED.published_at`,
      [SERVICE_SCOPE, id, now],
    );
    return { snapshotId: id, outcome: 'published' };
  });
}
