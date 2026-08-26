// web/lib/integrations.ts
// ADR-039 P2 — Aurora-backed Integrations catalog (egress connectors + ingress webhook sources).
// Mirrors the catalog.ts pattern: ON CONFLICT(name) DO UPDATE WHERE tier='custom' (never clobber a
// built-in), disabled-by-default, audited. NOTE: the integrations table has NO `version` column
// (unlike skills/agents) — do not reference it. getEnabledIntegrations is per-account-space scoped.
import { getPool } from '@/lib/db';
import { type Tier } from '@/lib/catalog';

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
  privateConnectionRef: string | null; capability: Capability; exposedTools: string[];
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
    exposedTools: (r.exposed_tools as string[]) ?? [],
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
  const { rows } = await getPool().query(
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
     JSON.stringify(i.exposedTools ?? []), JSON.stringify(i.providedContext ?? {}),
     JSON.stringify(i.writeActionRefs ?? []), i.authMode ?? null, i.receivePath ?? null,
     i.inboundAuthRef ?? null, JSON.stringify(i.sourceAllowlist ?? []), i.triggerTarget ?? null,
     i.tier ?? 'custom', i.createdBy ?? null],
  );
  // WHERE tier='custom' ⇒ a name collision with a built-in integration updates nothing / returns no row.
  if (rows.length === 0) throw new Error('name conflicts with a built-in integration');
  return rows[0].id;
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
  await getPool().query(
    `UPDATE integrations SET enabled = $1, updated_at = NOW() WHERE id = $2 AND tier = 'custom'`,
    [enabled, id],
  );
}

/**
 * Enabled integrations for an account, PER-ACCOUNT-SPACE scoped (mirrors getEnabledCustomAgents):
 * globally `enabled=true` AND (no agent_spaces row ⇒ Phase-1 global = all enabled; else only those in
 * that account's `enabled_integration_ids`). Returns BOTH directions — the caller (chat route) filters
 * to egress+read. Degrade-safe: [] when Aurora is off or on any error.
 */
/**
 * ADR-040/041 — the egress-WRITE destination allowlist for a connector kind (e.g. 'slack' → allowed
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

export async function getEnabledIntegrations(accountId = 'self'): Promise<IntegrationRow[]> {
  if (!process.env.AURORA_ENDPOINT) return [];
  try {
    const { rows } = await getPool().query(
      `SELECT i.id, i.name, i.kind, i.direction, i.description, i.endpoint, i.transport, i.credentials_ref,
              i.private_connection_ref, i.capability, i.exposed_tools, i.provided_context, i.write_action_refs,
              i.auth_mode, i.receive_path, i.inbound_auth_ref, i.source_allowlist, i.trigger_target, i.tier, i.enabled
       FROM integrations i
       WHERE i.enabled = true
         AND (
           NOT EXISTS (SELECT 1 FROM agent_spaces s WHERE s.account_id = $1)
           OR i.id IN (
             SELECT (e)::bigint FROM agent_spaces s, jsonb_array_elements_text(s.enabled_integration_ids) AS e
             WHERE s.account_id = $1
           )
         )
       ORDER BY i.name`,
      [accountId],
    );
    return rows.map(mapRow);
  } catch {
    return [];
  }
}
