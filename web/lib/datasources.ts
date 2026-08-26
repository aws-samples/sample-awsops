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

export interface DatasourceRow {
  id: number;
  name: string;
  kind: string;
  endpoint: string | null;
  authType: AuthType | null;
  isDefault: boolean;
  enabled: boolean;
}

export interface CreateDatasourceInput {
  name: string;
  kind: string;
  endpoint: string;
  authType: AuthType;
}

const SELECT_COLS =
  'id, name, kind, endpoint, ds_auth_type, is_default, enabled';

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
         (name, kind, direction, capability, endpoint, ds_auth_type, enabled, is_default)
       VALUES ($1, $2, 'egress', 'read', $3, $4, true,
               NOT EXISTS (SELECT 1 FROM integrations WHERE kind = $2 AND is_default))
       RETURNING id`,
      [i.name, i.kind, i.endpoint, i.authType],
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

export async function getDatasource(id: number): Promise<DatasourceRow | null> {
  const { rows } = await getPool().query(`SELECT ${SELECT_COLS} FROM integrations WHERE id = $1`, [id]);
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
  const cred = await getCredentialById(ds.id);
  // Spread the SM cred FIRST (auth material / org_id), then FORCE the row's endpoint + authType on top
  // so the ROW stays authoritative (a stale/partial secret blob can't redirect the query to a different
  // endpoint). The endpoint is re-checked by the SSRF guard at the call site regardless.
  return {
    ...(cred ?? {}),
    ...(ds.endpoint ? { endpoint: ds.endpoint } : {}),
    ...(ds.authType ? { authType: ds.authType } : {}),
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
  fields: { name?: string; endpoint?: string; authType?: AuthType },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;
  if (fields.name !== undefined) { sets.push(`name = $${n++}`); vals.push(fields.name); }
  if (fields.endpoint !== undefined) { sets.push(`endpoint = $${n++}`); vals.push(fields.endpoint); }
  if (fields.authType !== undefined) { sets.push(`ds_auth_type = $${n++}`); vals.push(fields.authType); }
  if (sets.length) {
    vals.push(id);
    try {
      await getPool().query(`UPDATE integrations SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${n}`, vals);
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') throw new Error('duplicate datasource name');
      throw e;
    }
  }
  const row = await getDatasource(id);
  if (row?.isDefault) {
    const cred = await getCredentialById(id, row.kind);
    if (cred) await mirrorDefaultCredential(row.kind, cred);
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
