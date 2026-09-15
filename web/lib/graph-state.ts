import type { Pool, PoolClient } from 'pg';
import type { GraphCollection } from '@/components/topology/GraphCollectionStatus';

export interface GraphReadState extends Omit<GraphCollection, 'attempted_at' | 'captured_at'> {
  attempted_at: string | Date | null;
  captured_at: string | Date | null;
}

export type GraphStatus = 'ok' | 'empty' | 'partial' | 'unavailable' | 'error';
export type GraphClass = 'flow' | 'infra' | 'trace';
export interface GraphAttempt {
  status: GraphStatus;
  attemptedAt: string;
  publish: boolean;
  details: Record<string, unknown>;
}

/** Caller stages and SQLSTATE only; never serialize provider/DB messages or arbitrary codes. */
export function graphDiagnostic(stage: string, error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return JSON.stringify({
    stage: ['flow', 'infra', 'trace_sources', 'trace', 'graph_state', 'graph_read'].includes(stage) ? stage : 'unknown',
    code: typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown',
  });
}

/** Caller holds the class advisory lock and publishes rows in this same transaction.
 * captured_at is the successful publication; source clocks belong to publishedSources.
 * Failed attempts preserve both. Equal timestamps are serialized retries, accepted as
 * in the original trace contract; only strictly older attempts are superseded.
 * The publish flag still gates replacement. Trace keeps its window-end timestamp default. */
export async function writeGraphState(client: PoolClient, account: string, attempt: GraphAttempt, cls: GraphClass) {
  const result = await client.query(
    `INSERT INTO topology_graph_state (account_id, class, status, attempted_at, captured_at, details)
     VALUES ($1, $6, $2, $3::timestamptz,
             CASE WHEN $4 THEN CASE WHEN $6 = 'trace' THEN $3::timestamptz ELSE clock_timestamp() END ELSE NULL END,
             $5::jsonb || CASE WHEN $6 <> 'trace' THEN
               jsonb_build_object('publishedSources', CASE WHEN $4 THEN coalesce($5::jsonb->'sources','[]'::jsonb) ELSE '[]'::jsonb END)
               ELSE '{}'::jsonb END)
     ON CONFLICT (account_id, class) DO UPDATE
       SET status = EXCLUDED.status, attempted_at = EXCLUDED.attempted_at,
           captured_at = CASE WHEN $4 THEN EXCLUDED.captured_at ELSE topology_graph_state.captured_at END,
           details = EXCLUDED.details || CASE WHEN NOT $4 AND $6 <> 'trace' THEN
             jsonb_build_object('publishedSources', coalesce(topology_graph_state.details->'publishedSources', '[]'::jsonb))
             ELSE '{}'::jsonb END
     WHERE topology_graph_state.attempted_at <= EXCLUDED.attempted_at`,
    [account, attempt.status, attempt.attemptedAt, attempt.publish, JSON.stringify(attempt.details), cls],
  );
  return result.rowCount !== 0;
}

/** HTTP counterpart of the collection view allow-list; never spread raw stored metadata. */
export function projectGraphDetails(value: unknown): Record<string, any> {
  const object = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const raw = object(value), result: Record<string, any> = {};
  const statuses = ['ok', 'empty', 'partial', 'error', 'unavailable', 'unknown'];
  const reasons = new Set(['missing_configuration','configuration_failed','query_failed','malformed_payload',
    'malformed_rows','payload_truncated','trace_fetch_failed','cap_reached','invalid_request','source_failed',
    'registry_read_failed','missing_ledger','incomplete_collection','unknown_attributes','unknown_capture',
    'unknown_account_coverage','empty_not_confirmed','count_not_confirmed']);
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8640000000000000;
  for (const key of ['windowStartMs','windowEndMs','nodeDrops','edgeDrops','orphanSpans','invalidSpans','unresolvedMessaging']) {
    if (number(raw[key])) result[key] = raw[key];
  }
  for (const key of ['retainedPrevious','infraUnavailable','inputTruncated','graphTruncated','sourceAttempted','metadataTruncated']) {
    if (typeof raw[key] === 'boolean') result[key] = raw[key];
  }
  if (['publication_failed','source_read_failed','not_attempted'].includes(raw.failureReason)) result.failureReason = raw.failureReason;
  let limited = raw.metadataTruncated === true;
  // Recognized fields with invalid types/ranges or unknown vocabulary cannot silently
  // disappear into a complete-looking envelope. Unrelated private fields remain omitted.
  const omitted = (source: Record<string, any>, projected: Record<string, any>, keys: string[]) =>
    keys.some(key => Object.prototype.hasOwnProperty.call(source, key) && !Object.prototype.hasOwnProperty.call(projected, key));
  limited ||= omitted(raw, result, ['windowStartMs','windowEndMs','nodeDrops','edgeDrops',
    'orphanSpans','invalidSpans','unresolvedMessaging','retainedPrevious','infraUnavailable',
    'inputTruncated','graphTruncated','sourceAttempted','metadataTruncated','failureReason']);
  for (const key of ['sources','publishedSources']) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && !Array.isArray(raw[key])) limited = true;
    if (key === 'publishedSources' && !Array.isArray(raw[key])) continue;
    const sources = Array.isArray(raw[key]) ? raw[key] : [];
    if (sources.length > 128) limited = true;
    result[key] = sources.slice(0, 128).flatMap((value: unknown) => {
      const source = object(value);
      if (typeof source.sourceId !== 'string' || !/^[A-Za-z0-9:_./-]{1,128}$/.test(source.sourceId)) {
        limited = true; return [];
      }
      const projected: Record<string, any> = { sourceId: source.sourceId };
      if (statuses.includes(source.status)) projected.status = source.status;
      if (['succeeded','failed','partial','running','unknown'].includes(source.producerStatus)) projected.producerStatus = source.producerStatus;
      if (['aggregate','account'].includes(source.scope)) projected.scope = source.scope;
      for (const clock of ['itemCount','windowStartMs','windowEndMs','capturedAtMs','lastSuccessAtMs','attemptedAtMs','finishedAtMs']) {
        if (number(source[clock]) || source[clock] === null) projected[clock] = source[clock];
      }
      limited ||= omitted(source, projected, ['status','producerStatus','scope','itemCount',
        'windowStartMs','windowEndMs','capturedAtMs','lastSuccessAtMs','attemptedAtMs','finishedAtMs']);
      const unique = Array.isArray(source.reasons) ? [...new Set(source.reasons)] : [];
      const allowed = unique.filter((v): v is string => typeof v === 'string' && reasons.has(v)).sort();
      if (allowed.length > 16 || allowed.length < unique.length
        || (Object.prototype.hasOwnProperty.call(source, 'reasons') && !Array.isArray(source.reasons))) limited = true;
      projected.reasons = allowed.slice(0, 16);
      return [projected];
    });
  }
  if (limited) result.metadataTruncated = true;
  return result;
}

export async function readGraphState(pool: Pick<Pool, 'query'>, account: string, cls: GraphClass = 'trace'): Promise<GraphReadState> {
  const unknown = { status: 'unknown', stale: true, attempted_at: null, captured_at: null, sources: [],
    ...(cls !== 'trace' ? { evidenceKind: 'inventory' as const } : {}) };
  // A host state is not evidence for an account union. No unbounded per-account payload.
  if (account === '__all__' && cls !== 'trace') return { ...unknown, coverage: 'unknown' };
  const storageAccount = cls === 'trace' && account === '__all__' ? 'self' : account;
  let row;
  try {
    const result = await pool.query(
      `SELECT status, attempted_at, captured_at, details
         FROM topology_graph_state
        WHERE class = $2 AND account_id = $1`,
      [storageAccount, cls],
    );
    row = result.rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return unknown;
    throw error;
  }
  if (!row) return unknown;
  const details = projectGraphDetails(row.details);
  const captured = row.captured_at ? new Date(row.captured_at).getTime() : NaN;
  const configured = Number(process.env.GRAPH_REBUILD_INTERVAL_MINS ?? 0);
  const maxAgeMins = Number.isFinite(configured) ? Math.max(15, configured * 2) : 15;
  const stale = !Number.isFinite(captured) || captured > Date.now() || Date.now() - captured > maxAgeMins * 60_000
    || row.status === 'error' || row.status === 'unavailable'
    || details.retainedPrevious === true || details.metadataTruncated === true
    || (cls !== 'trace' && inventorySourcesStale(details.publishedSources));
  return { ...details, ...(cls !== 'trace' ? { evidenceKind: 'inventory' } : {}), status: row.status, stale,
    attempted_at: row.attempted_at, captured_at: row.captured_at };
}

/** Same default as inventory_read_mcp._inventory_stale_after_minutes. */
export function inventorySourcesStale(value: unknown): boolean {
  if (!Array.isArray(value) || !value.length) return true;
  const configured = Number(process.env.INVENTORY_STALE_AFTER_MINUTES ?? 30);
  const minutes = Number.isInteger(configured) && configured > 0 && configured <= 1440 ? configured : 30;
  return value.some(source => {
    if (!source || typeof source !== 'object') return true;
    if (!Number.isSafeInteger(source.itemCount) || source.itemCount < 0) return true;
    const clocks = [source.lastSuccessAtMs,
      ...(source.itemCount > 0 || source.capturedAtMs != null ? [source.capturedAtMs] : [])];
    return (source.status === 'empty' && source.itemCount !== 0)
      || (source.status === 'ok' && source.itemCount === 0)
      || (Object.prototype.hasOwnProperty.call(source, 'reasons') && (!Array.isArray(source.reasons) || source.reasons.length > 0))
      || source.producerStatus !== 'succeeded' || !['ok', 'empty'].includes(source.status) || clocks.some(clock =>
      typeof clock !== 'number' || !Number.isFinite(clock) || clock <= 0
      || clock > Date.now() || Date.now() - clock > minutes * 60_000);
  });
}
