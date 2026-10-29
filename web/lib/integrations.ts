// web/lib/integrations.ts
// ADR-007[legacy 039] P2 — Aurora-backed Integrations catalog (egress connectors + ingress webhook sources).
// Mirrors the catalog.ts pattern: ON CONFLICT(name) DO UPDATE WHERE tier='custom' (never clobber a
// built-in), disabled-by-default, audited. NOTE: the integrations table has NO `version` column
// (unlike skills/agents) — do not reference it. getEnabledIntegrations is per-account-space scoped.
import { getPool } from '@/lib/db';
import { type Tier } from '@/lib/catalog';
import { CUSTOM_MCP_ATTESTATION, assertMcpReady, customMcpEnabled, customMcpSecretName, isMcpRegistration,
  mcpRegistrationErrors, validMcpAttestation } from './custom-mcp-policy';
import { currentCustomMcpSecretVersion } from './custom-mcp-secret';
import { DATASOURCE_KINDS } from './integrations-category';

export type Direction = 'egress' | 'ingress';
export type Capability = 'read' | 'read_write';

export interface IntegrationInput {
  name: string;
  kind: string;
  direction: Direction;
  description?: string;
  endpoint?: string;
  transport?: string;
  credentialsRef?: string;
  privateConnectionRef?: string;
  capability?: Capability;
  exposedTools?: string[];
  providedContext?: Record<string, unknown>;
  writeActionRefs?: string[];
  authMode?: string;
  receivePath?: string;
  inboundAuthRef?: string;
  sourceAllowlist?: string[];
  triggerTarget?: string;
  tier?: Tier;
  createdBy?: string;
}

export interface IntegrationRow {
  id: number; name: string; kind: string; direction: Direction; description: string;
  endpoint: string | null; transport: string | null; credentialsRef: string | null;
  privateConnectionRef: string | null; capability: Capability; exposedTools: string[]; invalidToolShape?: boolean;
  providedContext: Record<string, unknown>; writeActionRefs: string[];
  authMode: string | null; receivePath: string | null; inboundAuthRef: string | null;
  sourceAllowlist: string[]; triggerTarget: string | null; tier: Tier; enabled: boolean;
}

function mapRow(r: Record<string, unknown>): IntegrationRow {
  return {
    id: r.id as number, name: r.name as string, kind: r.kind as string,
    direction: r.direction as Direction, description: (r.description as string) ?? '',
    endpoint: (r.endpoint as string) ?? null, transport: (r.transport as string) ?? null,
    credentialsRef: (r.credentials_ref as string) ?? null,
    privateConnectionRef: (r.private_connection_ref as string) ?? null,
    capability: (r.capability as Capability) ?? 'read',
    exposedTools: Array.isArray(r.exposed_tools) ? r.exposed_tools : [],
    ...(!Array.isArray(r.exposed_tools) && r.exposed_tools !== undefined ? { invalidToolShape: true } : {}),
    providedContext: (r.provided_context as Record<string, unknown>) ?? {},
    writeActionRefs: (r.write_action_refs as string[]) ?? [],
    authMode: (r.auth_mode as string) ?? null, receivePath: (r.receive_path as string) ?? null,
    inboundAuthRef: (r.inbound_auth_ref as string) ?? null,
    sourceAllowlist: (r.source_allowlist as string[]) ?? [],
    triggerTarget: (r.trigger_target as string) ?? null,
    tier: r.tier as Tier, enabled: r.enabled as boolean,
  };
}

/** Upsert a custom integration. ON CONFLICT(name) updates ONLY a tier='custom' row (never clobbers a
 *  built-in — returns no row → throws). No `version` column. Disabled-by-default on insert. */
export async function upsertIntegration(i: IntegrationInput): Promise<number> {
  const governed = isMcpRegistration(i);
  if (governed) {
    const errors = mcpRegistrationErrors({ ...i, exposedTools: i.exposedTools ?? [] });
    if (i.credentialsRef !== undefined) errors.push('custom MCP credential reference is assigned by the server');
    if (errors.length) throw new Error(errors.join('; '));
  }
  // User-provided context can never mint an attestation. Every edit disables the row.
  const context = { ...i.providedContext };
  delete context[CUSTOM_MCP_ATTESTATION];
  const connection = governed ? await getPool().connect() : undefined;
  const q = connection ?? getPool();
  try {
    if (connection) await connection.query('BEGIN');
    const { rows } = await q.query(
    `INSERT INTO integrations
       (name, kind, direction, description, endpoint, transport, credentials_ref, private_connection_ref,
        capability, exposed_tools, provided_context, write_action_refs, auth_mode, receive_path,
        inbound_auth_ref, source_allowlist, trigger_target, tier, created_by, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16::jsonb,$17,$18,$19, false)
     ON CONFLICT (name) DO UPDATE
       SET kind=EXCLUDED.kind, direction=EXCLUDED.direction, description=EXCLUDED.description,
           endpoint=EXCLUDED.endpoint, transport=EXCLUDED.transport, credentials_ref=EXCLUDED.credentials_ref,
           private_connection_ref=EXCLUDED.private_connection_ref, capability=EXCLUDED.capability,
           exposed_tools=EXCLUDED.exposed_tools, provided_context=EXCLUDED.provided_context,
           write_action_refs=EXCLUDED.write_action_refs, auth_mode=EXCLUDED.auth_mode,
           receive_path=EXCLUDED.receive_path, inbound_auth_ref=EXCLUDED.inbound_auth_ref,
           source_allowlist=EXCLUDED.source_allowlist, trigger_target=EXCLUDED.trigger_target,
           enabled=false, updated_at=NOW()
       WHERE integrations.tier = 'custom'
     RETURNING id`,
    [i.name, i.kind, i.direction, i.description ?? '', i.endpoint ?? null, i.transport ?? null,
     i.credentialsRef ?? null, i.privateConnectionRef ?? null, i.capability ?? 'read',
     JSON.stringify(i.exposedTools ?? []), JSON.stringify(context),
     JSON.stringify(i.writeActionRefs ?? []), i.authMode ?? null, i.receivePath ?? null,
     i.inboundAuthRef ?? null, JSON.stringify(i.sourceAllowlist ?? []), i.triggerTarget ?? null,
     i.tier ?? 'custom', i.createdBy ?? null],
  );
  // WHERE tier='custom' ⇒ a name collision with a built-in integration updates nothing / returns no row.
    if (rows.length === 0) throw new Error('name conflicts with a built-in integration');
    const id = Number(rows[0].id);
    if (connection) {
      await connection.query('UPDATE integrations SET credentials_ref=$1 WHERE id=$2',
        [customMcpSecretName(id), id]);
      await connection.query('COMMIT');
    }
    return id;
  } catch (e) {
    if (connection) await connection.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { connection?.release(); }
}

export async function listIntegrations(): Promise<IntegrationRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, name, kind, direction, description, endpoint, transport, credentials_ref,
            private_connection_ref, capability, exposed_tools, provided_context, write_action_refs,
            auth_mode, receive_path, inbound_auth_ref, source_allowlist, trigger_target, tier, enabled
     FROM integrations ORDER BY name`,
  );
  return rows.map(mapRow);
}

export async function setIntegrationEnabled(id: number, enabled: boolean): Promise<void> {
  // builtin rows are never togglable from the API (custom-only at the SQL level)
  const result = await getPool().query(
    `UPDATE integrations SET enabled = $1, updated_at = NOW() WHERE id = $2 AND tier = 'custom'
       AND (NOT $1 OR NOT (${governedMcpSql()}))`,
    [enabled, id],
  );
  if (result.rowCount === 0) throw new Error('integration cannot be toggled through the generic helper');
}

/** Server-owned column aliases only. CASE prevents legacy non-array JSON from raising
 *  jsonb_array_length errors, and such malformed egress rows remain governed/fail-closed.
 *  Keep the native datasource exception aligned with isMcpRegistration. */
function governedMcpSql(alias = ''): string {
  const c = (name: string) => `${alias}${name}`;
  const tools = `CASE WHEN jsonb_typeof(${c('exposed_tools')})='array'
    THEN jsonb_array_length(${c('exposed_tools')}) ELSE 1 END`;
  const native = `(${c('kind')} IN (${DATASOURCE_KINDS.map(k => `'${k}'`).join(',')})
    AND ${c('direction')}='egress' AND ${c('capability')}='read'
    AND COALESCE(${c('transport')},'')='' AND COALESCE(${c('credentials_ref')},'')=''
    AND (${tools})=0)`;
  return `(${c('kind')}='custom_mcp' OR (${c('direction')}='egress' AND NOT ${native}
    AND ((COALESCE(${c('endpoint')},'')<>'' AND ${c('capability')}='read') OR (${tools})>0)))`;
}

export async function getIntegrationById(id: number): Promise<IntegrationRow | null> {
  const { rows } = await getPool().query('SELECT * FROM integrations WHERE id=$1', [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

/** Re-read and lock the registration before creating an attestation; edits cannot race enablement. */
export async function attestAndEnableMcp(id: number, actorSub: string, confirmed: boolean, snapshot: unknown): Promise<void> {
  if (!customMcpEnabled()) throw new Error('custom MCP policy activation is pending');
  if (confirmed !== true || !actorSub.trim()) throw new Error('administrator read-only attestation required');
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT * FROM integrations WHERE id=$1 FOR UPDATE', [id]);
    if (!rows.length) throw new Error('integration not found');
    const i = mapRow(rows[0]);
    i.id = Number(i.id);
    if (i.tier !== 'custom' || !isMcpRegistration(i)) throw new Error('not an administrator MCP registration');
    assertMcpReady(i);
    const shown = snapshot as Partial<IntegrationRow> | null;
    if (!shown || shown.endpoint !== i.endpoint || shown.transport !== i.transport ||
        shown.credentialsRef !== i.credentialsRef ||
        JSON.stringify(shown.exposedTools) !== JSON.stringify(i.exposedTools)) {
      throw new Error('registration changed; review it again before attesting');
    }
    const credentialVersionId = await currentCustomMcpSecretVersion(i.id);
    const attestation = {
      actorSub, attestedAt: new Date().toISOString(), tools: i.exposedTools,
      endpoint: i.endpoint, transport: i.transport, credentialsRef: i.credentialsRef, credentialVersionId,
    };
    const context = { ...i.providedContext, [CUSTOM_MCP_ATTESTATION]: attestation };
    // Audit failure rolls back enablement; later edits do not erase this durable snapshot.
    await c.query(
      `INSERT INTO customization_audit (actor,action,object_type,object_id,details)
       VALUES ($1,'attest_enable','integration',$2,$3::jsonb)`,
      [actorSub, String(id), JSON.stringify(attestation)],
    );
    await c.query('UPDATE integrations SET enabled=true, provided_context=$1::jsonb, updated_at=NOW() WHERE id=$2',
      [JSON.stringify(context), id]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

/**
 * ADR-007 — the egress-WRITE destination allowlist for a connector kind (e.g. 'slack' → allowed
 * Slack channels). Reuses the enabled READ_WRITE egress integration's `source_allowlist` as the
 * destination allowlist (documented egress-write reuse). [] when Aurora off / none / error → the caller's
 * assertChannelAllowed treats [] as deny-all (fail-closed).
 */
export async function getEgressWriteAllowlist(kind: string): Promise<string[]> {
  if (!process.env.AURORA_ENDPOINT) return [];
  try {
    const { rows } = await getPool().query(
      `SELECT source_allowlist FROM integrations
       WHERE kind = $1 AND direction = 'egress' AND capability = 'read_write' AND enabled = true
       ORDER BY id LIMIT 1`,
      [kind],
    );
    return rows.length ? ((rows[0].source_allowlist as string[]) ?? []) : [];
  } catch {
    return [];
  }
}

export interface EnabledIntegrationSelection {
  integrations: IntegrationRow[];
  mcpSelectionSuppressed: boolean;
  mcpSuppressionReasons?: Array<'denied' | 'disabled-selected' | 'lookup-failed'>;
}

/**
 * Account-scoped selection. Without a Space, enabled genuine MCP declarations
 * remain denied without membership; an explicit Space (even empty) selects only
 * its listed rows. Malformed vendor rows and ingress/write rows are quarantined
 * per row, not declarations that revoke unrelated gateway reads.
 * Lookup failures retain a fail-closed ceiling and a non-secret diagnostic reason.
 */
export async function getEnabledIntegrationSelection(accountId = 'self'): Promise<EnabledIntegrationSelection> {
  if (!process.env.AURORA_ENDPOINT) return { integrations: [], mcpSelectionSuppressed: false };
  try {
    const { rows } = await getPool().query(
      `SELECT i.id, i.name, i.kind, i.direction, i.description, i.endpoint, i.transport, i.credentials_ref,
              i.private_connection_ref, i.capability, i.exposed_tools, i.provided_context, i.write_action_refs,
              i.auth_mode, i.receive_path, i.inbound_auth_ref, i.source_allowlist, i.trigger_target, i.tier, i.enabled,
              i.id IN (
                SELECT (e)::bigint FROM agent_spaces s, jsonb_array_elements_text(s.enabled_integration_ids) AS e
                WHERE s.account_id = $1
              ) AS account_selected
       FROM integrations i
       WHERE (i.enabled = true AND NOT EXISTS (SELECT 1 FROM agent_spaces s WHERE s.account_id = $1))
          OR i.id IN (
            SELECT (e)::bigint FROM agent_spaces s, jsonb_array_elements_text(s.enabled_integration_ids) AS e
            WHERE s.account_id = $1
          )
       ORDER BY i.name`,
      [accountId],
    );
    const integrations: IntegrationRow[] = [];
    const reasons = new Set<'denied' | 'disabled-selected'>();
    for (const raw of rows) {
      const i = mapRow(raw);
      const declaration = i.kind === 'custom_mcp' ||
        (i.direction === 'egress' && i.capability === 'read' &&
          !i.invalidToolShape && Array.isArray(i.exposedTools) && isMcpRegistration(i));
      if (i.enabled !== true) {
        // Explicit selection survives disablement/edit invalidation as a denial, never a connection.
        if (declaration) reasons.add('disabled-selected');
        continue;
      }
      if (!isMcpRegistration(i) ||
          (raw.account_selected === true && customMcpEnabled() && validMcpAttestation({ ...i, id: Number(i.id) }))) {
        integrations.push(i);
      } else {
        // Includes legacy globally enabled rows when the account has no space. They remain
        // unusable without explicit membership, but removing them must never grant gateway reads.
        if (declaration) reasons.add('denied');
      }
    }
    return { integrations, mcpSelectionSuppressed: reasons.size > 0,
      ...(reasons.size ? { mcpSuppressionReasons: [...reasons] } : {}) };
  } catch {
    // Policy lookup failure cannot establish the unrestricted legacy case for a custom agent.
    return { integrations: [], mcpSelectionSuppressed: true,
      mcpSuppressionReasons: ['lookup-failed'] };
  }
}

/** Compatibility/test projection; live chat must preserve selection diagnostics. */
export async function getEnabledIntegrations(accountId = 'self'): Promise<IntegrationRow[]> {
  return (await getEnabledIntegrationSelection(accountId)).integrations;
}
