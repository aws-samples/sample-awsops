// web/lib/datasources.ts
// Multi-instance datasource data layer (ADR-039 hub). A datasource is an `integrations` row with
// category=datasource (direction='egress', capability='read', a query-language kind). This module owns
// the row lifecycle AND the kind-mirror credential coordination (the agent gateway no-inline path):
// create/update/setDefault/delete keep the `kind` mirror equal to the current default instance.
import { getPool } from '@/lib/db';
import { DATASOURCE_KINDS, isDatasourceKind } from '@/lib/integrations-category';
import type { AuthType } from '@/lib/datasource-auth';
import type { ConnConfig } from '@/lib/mcp-lambda-invoke';
import {
  getCredentialById,
  mirrorDefaultCredential,
  deleteCredentialKeys,
} from '@/lib/integration-credentials';

// Gap L203 (v1 parity): per-datasource connection settings persisted on the row.
// - timeoutS: upstream query execution bound in SECONDS (v1 used ms; v2 stores seconds to match
//   the connectors' own clamps — prometheus/mimir forward it as the API `timeout` param under the
//   connector's 12s HTTP timeout, clickhouse as `max_execution_time`).
// - database: ClickHouse default database (identifier-only; other kinds ignore it).
// v1's result-cache TTL is deliberately NOT ported — the v2 thin-BFF query path is uncached by
// design (disclosed deviation in the gap audit).
export interface DsSettings {
  timeoutS?: number;
  database?: string;
}

const DB_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Server-side validation: drop anything out of contract rather than erroring (a stale client
 *  must not brick the form). timeoutS: int 1..60; database: bare identifier. Exported for tests. */
export function sanitizeDsSettings(input: unknown): DsSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const o = input as Record<string, unknown>;
  const out: DsSettings = {};
  // strict type check — no coercion ('30'/true must NOT pass; out-of-contract is dropped)
  if (typeof o.timeoutS === 'number' && Number.isInteger(o.timeoutS) && o.timeoutS >= 1 && o.timeoutS <= 60) out.timeoutS = o.timeoutS;
  // identifier-only, and NEVER the system databases: the connector's read-only guard is
  // lexical over the SQL text — database=system would resolve an unqualified FROM tables to
  // system.tables (create_table_query can carry plaintext engine credentials). Re-checked in
  // the connector too (defense in depth on both sides of the trust boundary).
  if (
    typeof o.database === 'string' && o.database.length <= 128 && DB_IDENTIFIER.test(o.database)
    && !['system', 'information_schema'].includes(o.database.toLowerCase())
  ) out.database = o.database;
  return out;
}

export interface DatasourceRow {
  id: number;
  name: string;
  kind: string;
  endpoint: string | null;
  authType: AuthType | null;
  isDefault: boolean;
  enabled: boolean;
  settings: DsSettings;
}

export interface CreateDatasourceInput {
  name: string;
  kind: string;
  endpoint: string;
  authType: AuthType;
  settings?: DsSettings;
}

const SELECT_COLS =
  'id, name, kind, endpoint, ds_auth_type, is_default, enabled, ds_settings';

function mapRow(r: Record<string, unknown>): DatasourceRow {
  return {
    // node-pg returns BIGINT (BIGSERIAL id) as a STRING — coerce to number so the API contract is
    // numeric and UI/route comparisons (instanceId === id, schema byId.has) don't string/number-mismatch.
    id: Number(r.id),
    name: r.name as string,
    kind: r.kind as string,
    endpoint: (r.endpoint as string) ?? null,
    authType: (r.ds_auth_type as AuthType) ?? null,
    isDefault: Boolean(r.is_default),
    enabled: Boolean(r.enabled),
    // re-sanitized on READ too — a hand-edited DB row can't smuggle an out-of-contract value
    settings: sanitizeDsSettings(r.ds_settings),
  };
}

function assertDatasourceKind(kind: string): void {
  if (!isDatasourceKind(kind)) throw new Error(`not a datasource kind: ${kind}`);
}

/** Create a datasource instance. is_default = true when it is the FIRST instance of its kind. */
export async function createDatasource(i: CreateDatasourceInput): Promise<number> {
  assertDatasourceKind(i.kind);
  try {
    const { rows } = await getPool().query(
      `INSERT INTO integrations
         (name, kind, direction, capability, endpoint, ds_auth_type, enabled, is_default, ds_settings)
       VALUES ($1, $2, 'egress', 'read', $3, $4, true,
               NOT EXISTS (SELECT 1 FROM integrations WHERE kind = $2 AND is_default), $5::jsonb)
       RETURNING id`,
      [i.name, i.kind, i.endpoint, i.authType, JSON.stringify(sanitizeDsSettings(i.settings))],
    );
    // node-pg returns BIGSERIAL as a STRING — coerce so callers get a real number. (The credential
    // write keys on String(id) and assertPositiveId requires an integer; a string id silently threw,
    // leaving the row with NO credential → the connector reported "not connected".)
    return Number(rows[0].id);
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') throw new Error('duplicate datasource name');
    throw e;
  }
}

export async function listDatasources(): Promise<DatasourceRow[]> {
  const { rows } = await getPool().query(
    `SELECT ${SELECT_COLS} FROM integrations
      WHERE direction = 'egress' AND capability = 'read' AND kind = ANY($1)
      ORDER BY kind, name`,
    [DATASOURCE_KINDS as readonly string[]],
  );
  return rows.map(mapRow);
}

/** A pool or a checked-out client — everything the row helpers need. */
export type Queryable = Pick<ReturnType<typeof getPool>, 'query'>;

/** Serialize a datasource's manage-time read→merge→write span (round-10: the PATCH
 *  credential merge reads the blob, merges in route code, then writes — two interleaved
 *  PATCHes could otherwise write a pre-scrub blob back over a host-change scrub, rebinding
 *  stored write-only credentials to a newly pointed endpoint).
 *  Round-11: the span runs ENTIRELY on the lock client (passed to fn) inside a transaction
 *  with pg_advisory_xact_lock — the holder never re-enters the shared `max: 3` pool while
 *  pinning a client, so concurrent PATCHes cannot exhaust the pool against themselves.
 *  Bonus: row writes inside the span are atomic (a later failure rolls back the name
 *  preflight too); Secrets Manager writes stay non-transactional (disclosed residual).
 *  Waiters still pin one client each while blocked server-side — brief pool pressure under
 *  concurrent admin edits, but no deadlock and the protected operation always progresses. */
export async function withDatasourceLock<T>(id: number, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ds-manage:${id}`]);
      const out = await fn(client);
      // COMMIT on an already-aborted transaction (a caught failed statement, e.g. the
      // duplicate-name 409 path) is an implicit rollback — safe either way.
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}

export async function getDatasource(id: number, q: Queryable = getPool()): Promise<DatasourceRow | null> {
  const { rows } = await q.query(`SELECT ${SELECT_COLS} FROM integrations WHERE id = $1`, [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

/** Build the inline connector conn-config for an instance. The integrations ROW is authoritative for
 *  endpoint + authType — so an auth=none instance (or one whose Secrets Manager credential was never
 *  written) still resolves a usable endpoint — overlaid with the SM credential (auth material / org_id).
 *  Without the row fallback, a no-auth datasource has no SM cred → connConfig is empty → the connector
 *  Lambda falls back to the (often empty) kind-mirror and reports "not connected".
 *  Callers: the /api/datasources/query route (run) and the /api/datasources/generate route's
 *  background schema introspect (cache warm). Exported here — see PR #70 review (false-positive). */
export async function resolveConnConfig(ds: DatasourceRow): Promise<ConnConfig> {
  // ID-ONLY credential resolution — deliberately NO kind-mirror fallback. The kind mirror holds the
  // DEFAULT instance's credential; blending it with THIS instance's endpoint (below) would send the
  // default's auth material to a different target (credential leak). A no-auth instance, or one whose
  // id-keyed secret was never written, simply resolves with no auth (the row endpoint still works).
  const cred: Record<string, unknown> = { ...((await getCredentialById(ds.id)) ?? {}) };
  // The ROW is authoritative for the L203 settings too — a stale blob (written before a
  // clear/partial settings update) must never leak an old database/timeoutS through the
  // cred-first spread (round-3 review).
  delete cred.database;
  delete cred.timeoutS;
  // Spread the SM cred FIRST (auth material / org_id), then FORCE the row's endpoint + authType on top
  // so the ROW stays authoritative (a stale/partial secret blob can't redirect the query to a different
  // endpoint). The endpoint is re-checked by the SSRF guard at the call site regardless.
  return {
    ...cred,
    ...(ds.endpoint ? { endpoint: ds.endpoint } : {}),
    ...(ds.authType ? { authType: ds.authType } : {}),
    // gap L203: the ClickHouse settings ride the conn config — database (identifier-validated
    // on write AND read) becomes &database=, and timeoutS becomes the connector's DEFAULT
    // max_execution_time, so the Explore route, the service-graph sources, and the agent
    // path all get the same bound from one mechanism.
    ...(ds.kind === 'clickhouse' && ds.settings?.database ? { database: ds.settings.database } : {}),
    ...(ds.kind === 'clickhouse' && ds.settings?.timeoutS ? { timeoutS: ds.settings.timeoutS } : {}),
  } as ConnConfig;
}

export async function getDefaultDatasource(kind: string): Promise<DatasourceRow | null> {
  const { rows } = await getPool().query(
    `SELECT ${SELECT_COLS} FROM integrations WHERE kind = $1 AND is_default LIMIT 1`,
    [kind],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Update mutable fields. If the updated row is the current default, refresh the kind mirror so the
 *  agent gateway no-inline path doesn't serve stale credentials. */
export async function updateDatasource(
  id: number,
  fields: { name?: string; endpoint?: string; authType?: AuthType; settings?: DsSettings },
  q: Queryable = getPool(),
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;
  if (fields.name !== undefined) { sets.push(`name = $${n++}`); vals.push(fields.name); }
  if (fields.endpoint !== undefined) { sets.push(`endpoint = $${n++}`); vals.push(fields.endpoint); }
  if (fields.authType !== undefined) { sets.push(`ds_auth_type = $${n++}`); vals.push(fields.authType); }
  if (fields.settings !== undefined) { sets.push(`ds_settings = $${n++}::jsonb`); vals.push(JSON.stringify(sanitizeDsSettings(fields.settings))); }
  if (sets.length) {
    vals.push(id);
    try {
      await q.query(`UPDATE integrations SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${n}`, vals);
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') throw new Error('duplicate datasource name');
      throw e;
    }
  }
  const row = await getDatasource(id, q);
  if (row?.isDefault) {
    const cred = await getCredentialById(id, row.kind);
    if (cred) await mirrorDefaultCredential(row.kind, cred, q === getPool() ? undefined : q);
  }
}

/** Make `id` the default for its kind: unset other defaults of the kind then set this one (two
 *  statements in a transaction — avoids a transient two-defaults unique-index violation). After
 *  commit, mirror the default's credential under the plain kind key (agent gateway no-inline path). */
export async function setDefaultDatasource(id: number): Promise<void> {
  const c = await getPool().connect();
  let kind: string;
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT kind FROM integrations WHERE id = $1', [id]);
    if (!rows.length) throw new Error('datasource not found');
    kind = rows[0].kind as string;
    await c.query('UPDATE integrations SET is_default = false WHERE kind = $1 AND is_default', [kind]);
    await c.query('UPDATE integrations SET is_default = true, updated_at = NOW() WHERE id = $1', [id]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  // Secrets Manager write happens on its own connection/lock — after the DB commit.
  const cred = await getCredentialById(id, kind);
  if (cred) await mirrorDefaultCredential(kind, cred);
}

/** Delete a datasource instance. Cascade order: schema-cache rows → credential id key →
 *  integrations row. A Secrets Manager delete failure is logged, not blocking (orphan reaped later).
 *  If the deleted row was the default: re-pick a new default of the kind and re-mirror its credential;
 *  if none remain, clear the kind-mirror key. Idempotent (no-op when the id is gone). */
export async function deleteDatasource(id: number): Promise<void> {
  const row = await getDatasource(id);
  if (!row) return;

  await getPool().query('DELETE FROM datasource_schemas WHERE integration_id = $1', [id]);
  await getPool().query('DELETE FROM datasource_diag_signals WHERE integration_id = $1', [id]); // sweep pre-built signals
  await getPool().query('DELETE FROM datasource_graph_queries WHERE integration_id = $1', [id]); // sweep pre-built graph queries
  await getPool().query('DELETE FROM datasource_dashboard_cards WHERE integration_id = $1', [id]); // sweep pre-built cards
  try {
    await deleteCredentialKeys([String(id)]);
  } catch (e) {
    console.warn('[datasources] credential delete failed (id key); orphan reaped later:', (e as { name?: string })?.name || 'error');
  }
  await getPool().query('DELETE FROM integrations WHERE id = $1', [id]);

  if (row.isDefault) {
    const { rows } = await getPool().query(
      `SELECT id FROM integrations
        WHERE kind = $1 AND direction = 'egress' AND capability = 'read'
        ORDER BY id LIMIT 1`,
      [row.kind],
    );
    if (rows.length) {
      const newId = rows[0].id as number;
      await getPool().query('UPDATE integrations SET is_default = true, updated_at = NOW() WHERE id = $1', [newId]);
      const cred = await getCredentialById(newId, row.kind);
      if (cred) await mirrorDefaultCredential(row.kind, cred);
    } else {
      try {
        await deleteCredentialKeys([row.kind]); // no instances left → clear the managed mirror
      } catch (e) {
        console.warn('[datasources] kind-mirror clear failed:', (e as { name?: string })?.name || 'error');
      }
    }
  }
}
