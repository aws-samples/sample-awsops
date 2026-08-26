// web/lib/agent-space.ts
// ADR-031 Phase 2 — per-account Agent Space CRUD + server-side tool-allowlist intersection.
import { getPool } from '@/lib/db';
import { writeAudit } from '@/lib/catalog';

export interface AgentSpace {
  accountId: string;
  enabledAgentIds: number[];
  enabledSkillIds: number[];
  toolAllowlist: string[];
  version: number;
  // ADR-039 P2 — optional so existing AgentSpace literals/fixtures stay valid; getAgentSpace/
  // upsertAgentSpace always populate them (with defaults).
  enabledIntegrationIds?: number[];     // per-space enabled integrations
  allowPrivateDatasource?: boolean;     // ADR-011 private-egress opt-in (default false)
  nonAdminAuthoring?: boolean;          // §10 non-admin authoring flag (default false)
}

/**
 * Known-tool catalog, keyed by gateway. Pragmatic: the web tier does NOT hold the
 * full per-tool inventory of each gateway (that lives in the AgentCore gateway Lambdas
 * and is discovered live by agent.py). A `null` value = "inventory unknown here" → the
 * resolver does NOT use this dimension to drop tools (degrade-safe). Populate the entries
 * we DO know (mirror the gateway tool sets we can enumerate); leave the rest null.
 * Tightening this over time only ever ADDS restriction; it can never widen the space cap.
 */
export const KNOWN_TOOL_CATALOG: Record<string, string[] | null> = {
  network: null, container: null, iac: null, data: null,
  // SOURCE OF TRUTH: agent/lambda/create_targets.py 'iam-mcp-target' (security-gateway, 14 tools).
  // Keep in sync — adding a tool there without listing it here only OVER-restricts (safe).
  // Full enumeration of the other gateways is deferred (P2); null = degrade-safe "inventory unknown here".
  security: [
    'list_users', 'get_user', 'list_roles', 'get_role_details', 'list_groups', 'get_group',
    'list_policies', 'list_user_policies', 'list_role_policies', 'get_user_policy', 'get_role_policy',
    'list_access_keys', 'simulate_principal_policy', 'get_account_security_summary',
  ],
  monitoring: null, cost: null, ops: null,
};

/**
 * Server-side tool-allowlist enforcement (ADR-031 Addendum #5), computed OUTSIDE the model.
 * A skill cannot grant a tool the Agent Space does not allow.
 *
 * result = skillTools
 *          ∩ (knownToolCatalog[gateway] when that gateway's inventory is known)
 *          ∩ (space.toolAllowlist when a space exists AND its list is non-empty)
 *
 * Degrade-safe: a missing space, or an empty space.toolAllowlist, is "no account cap"
 * (Phase-1 advisory behavior) — we return skillTools ∩ knownCatalog only. An unknown
 * gateway inventory (null) is not used to drop tools.
 */
export function intersectToolAllowlist(
  gateway: string,
  skillTools: string[],
  space?: Pick<AgentSpace, 'toolAllowlist'> | null,
): string[] {
  const uniqSkill = Array.from(new Set(skillTools.filter(Boolean)));
  const known = KNOWN_TOOL_CATALOG[gateway];
  let out = known ? uniqSkill.filter((t) => known.includes(t)) : uniqSkill;
  if (space && Array.isArray(space.toolAllowlist) && space.toolAllowlist.length > 0) {
    const cap = new Set(space.toolAllowlist);
    out = out.filter((t) => cap.has(t)); // the account cap can only REMOVE tools
  }
  return out;
}

export async function getAgentSpace(accountId: string): Promise<AgentSpace | null> {
  if (!process.env.AURORA_ENDPOINT) return null;
  try {
    const { rows } = await getPool().query(
      `SELECT account_id, enabled_agent_ids, enabled_skill_ids, enabled_integration_ids, tool_allowlist,
              allow_private_datasource, non_admin_authoring, version
       FROM agent_spaces WHERE account_id = $1`, [accountId]);
    if (rows.length === 0) return null; // NO ROW ⇒ Phase-1 global behavior
    const r = rows[0] as Record<string, unknown>;
    return {
      accountId: r.account_id as string,
      enabledAgentIds: (r.enabled_agent_ids as number[]) ?? [],
      enabledSkillIds: (r.enabled_skill_ids as number[]) ?? [],
      enabledIntegrationIds: (r.enabled_integration_ids as number[]) ?? [],
      toolAllowlist: (r.tool_allowlist as string[]) ?? [],
      allowPrivateDatasource: r.allow_private_datasource === true,
      nonAdminAuthoring: r.non_admin_authoring === true,
      version: r.version as number,
    };
  } catch {
    return null; // degrade to Phase-1; never break chat
  }
}

export async function upsertAgentSpace(input: {
  accountId: string; enabledAgentIds: number[]; enabledSkillIds: number[]; toolAllowlist: string[];
  enabledIntegrationIds?: number[]; actor: string;
}): Promise<AgentSpace> {
  // enabled_integration_ids is persisted here; allow_private_datasource / non_admin_authoring are NOT
  // in the SET clause → preserved across upsert (default false on first insert), returned for the mapped result.
  const { rows } = await getPool().query(
    `INSERT INTO agent_spaces (account_id, enabled_agent_ids, enabled_skill_ids, enabled_integration_ids, tool_allowlist, version)
     VALUES ($1, $2::jsonb, $3::jsonb, $5::jsonb, $4::jsonb, 1)
     ON CONFLICT (account_id) DO UPDATE
       SET enabled_agent_ids       = EXCLUDED.enabled_agent_ids,
           enabled_skill_ids       = EXCLUDED.enabled_skill_ids,
           enabled_integration_ids = EXCLUDED.enabled_integration_ids,
           tool_allowlist          = EXCLUDED.tool_allowlist,
           version                 = agent_spaces.version + 1,
           updated_at              = NOW()
     RETURNING account_id, enabled_agent_ids, enabled_skill_ids, enabled_integration_ids, tool_allowlist,
               allow_private_datasource, non_admin_authoring, version`,
    [input.accountId, JSON.stringify(input.enabledAgentIds),
     JSON.stringify(input.enabledSkillIds), JSON.stringify(input.toolAllowlist),
     JSON.stringify(input.enabledIntegrationIds ?? [])],
  );
  const r = rows[0] as Record<string, unknown>;
  await writeAudit({
    actor: input.actor, action: 'upsert', objectType: 'space', objectId: input.accountId,
  });
  return {
    accountId: r.account_id as string,
    enabledAgentIds: (r.enabled_agent_ids as number[]) ?? [],
    enabledSkillIds: (r.enabled_skill_ids as number[]) ?? [],
    enabledIntegrationIds: (r.enabled_integration_ids as number[]) ?? [],
    toolAllowlist: (r.tool_allowlist as string[]) ?? [],
    allowPrivateDatasource: r.allow_private_datasource === true,
    nonAdminAuthoring: r.non_admin_authoring === true,
    version: r.version as number,
  };
}
