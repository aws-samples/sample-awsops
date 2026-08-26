// web/lib/catalog.ts
// ADR-031 Phase 1 — Aurora-backed skill/agent catalog (CRUD + queries + SHA-256).
import { createHash } from 'crypto';
import { getPool } from '@/lib/db';

export type Tier = 'builtin' | 'custom';

export interface SkillInput {
  name: string;
  description: string;
  instructions: string;
  toolAllowlist: string[];
  tier: Tier;
  createdBy?: string;
  agentTypes?: string[];      // ADR-039: agent-type targeting (default ['generic'])
  referenceKeys?: string[];   // ADR-039: S3 reference/asset object keys
}
export interface AgentInput {
  name: string;
  description: string;
  persona: string;
  routingKeywords: string[];
  gateway: string;            // legacy primary gateway (kept; = gateways[0])
  model?: string;
  tier: Tier;
  createdBy?: string;
  agentType?: string;         // ADR-039: generic|on_demand|triage|rca|mitigation|evaluation (default 'generic')
  gateways?: string[];        // ADR-039: multi-gateway frontier scope (default [gateway])
  responseLanguage?: string;  // ADR-039: Agent Space response language
}
export interface SkillRef {
  name: string; instructions: string; contentHash: string; ord: number; toolAllowlist: string[];
}
export interface SkillRow {
  id: number; name: string; description: string; tier: Tier; enabled: boolean; version: number;
  contentHash: string; agentTypes: string[]; referenceKeys: string[];
}
export interface AgentWithSkills {
  id: number; name: string; description: string; persona: string; gateway: string;
  tier: Tier; version: number; enabled: boolean; routingKeywords: string[]; skills: SkillRef[];
  // ADR-039 frontier-agent fields — optional so existing call sites/fixtures stay valid;
  // listAgentsWithSkills always populates them (with defaults) from the new columns.
  agentType?: string; gateways?: string[]; responseLanguage?: string | null;
}

/** SHA-256 over canonical JSON of integrity-relevant fields. Order-independent on toolAllowlist. */
export function computeSkillHash(s: { name: string; description: string; instructions: string; toolAllowlist: string[] }): string {
  const canonical = JSON.stringify({
    name: s.name, description: s.description, instructions: s.instructions,
    toolAllowlist: [...s.toolAllowlist].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function upsertSkill(s: SkillInput): Promise<number> {
  const hash = computeSkillHash(s);
  const { rows } = await getPool().query(
    `INSERT INTO skills (name, description, instructions, tool_allowlist, tier, content_hash, created_by, agent_types, reference_keys, enabled)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9::jsonb, false)
     ON CONFLICT (name) DO UPDATE
       SET description = EXCLUDED.description,
           instructions = EXCLUDED.instructions,
           tool_allowlist = EXCLUDED.tool_allowlist,
           content_hash = EXCLUDED.content_hash,
           agent_types = EXCLUDED.agent_types,
           reference_keys = EXCLUDED.reference_keys,
           version = skills.version + 1,
           enabled = false,
           updated_at = NOW()
       WHERE skills.tier = 'custom'
     RETURNING id`,
    [s.name, s.description, s.instructions, JSON.stringify(s.toolAllowlist), s.tier, hash, s.createdBy ?? null,
     JSON.stringify(s.agentTypes ?? ['generic']), JSON.stringify(s.referenceKeys ?? [])],
  );
  // WHERE tier='custom' ⇒ a name collision with a built-in skill updates nothing and returns no row;
  // never let a custom upsert clobber/disable a seeded built-in (e.g. a frontier agent's skill).
  if (rows.length === 0) throw new Error('name conflicts with a built-in skill');
  return rows[0].id;
}

export async function upsertAgent(a: AgentInput): Promise<number> {
  // gateways defaults to [gateway] when the caller doesn't supply a multi-gateway scope.
  const gateways = a.gateways && a.gateways.length ? a.gateways : [a.gateway];
  const { rows } = await getPool().query(
    `INSERT INTO agents (name, description, persona, routing_keywords, gateway, model, tier, created_by, agent_type, gateways, response_language, enabled)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,$11, false)
     ON CONFLICT (name) DO UPDATE
       SET description = EXCLUDED.description, persona = EXCLUDED.persona,
           routing_keywords = EXCLUDED.routing_keywords, gateway = EXCLUDED.gateway,
           model = EXCLUDED.model, agent_type = EXCLUDED.agent_type, gateways = EXCLUDED.gateways,
           response_language = EXCLUDED.response_language,
           version = agents.version + 1, enabled = false, updated_at = NOW()
       WHERE agents.tier = 'custom'
     RETURNING id`,
    [a.name, a.description, a.persona, JSON.stringify(a.routingKeywords), a.gateway, a.model ?? null, a.tier,
     a.createdBy ?? null, a.agentType ?? 'generic', JSON.stringify(gateways), a.responseLanguage ?? null],
  );
  // WHERE tier='custom' ⇒ a name collision with a built-in agent (e.g. a seeded frontier agent
  // 'devops'/'security'/'finops' or a gateway agent) updates nothing and returns no row — never let a
  // custom upsert clobber/disable a built-in.
  if (rows.length === 0) throw new Error('name conflicts with a built-in agent');
  return rows[0].id;
}

export async function attachSkill(agentId: number, skillId: number, ord = 0): Promise<void> {
  await getPool().query(
    `INSERT INTO agent_skills (agent_id, skill_id, ord) VALUES ($1,$2,$3)
     ON CONFLICT (agent_id, skill_id) DO UPDATE SET ord = EXCLUDED.ord`,
    [agentId, skillId, ord],
  );
}

export async function setEnabled(kind: 'skill' | 'agent', id: number, enabled: boolean): Promise<void> {
  const table = kind === 'skill' ? 'skills' : 'agents';
  // builtin rows are never togglable from the API (guarded at the route too)
  await getPool().query(`UPDATE ${table} SET enabled = $1, updated_at = NOW() WHERE id = $2 AND tier = 'custom'`, [enabled, id]);
}

export async function listSkills(): Promise<SkillRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, name, description, tier, enabled, version, content_hash, agent_types, reference_keys FROM skills ORDER BY name`,
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number, name: r.name as string, description: r.description as string,
    tier: r.tier as Tier, enabled: r.enabled as boolean, version: r.version as number, contentHash: r.content_hash as string,
    agentTypes: (r.agent_types as string[]) ?? ['generic'], referenceKeys: (r.reference_keys as string[]) ?? [],
  }));
}

export async function listAgentsWithSkills(opts?: { enabledOnly?: boolean }): Promise<AgentWithSkills[]> {
  const where = opts?.enabledOnly ? 'WHERE a.enabled = true' : '';
  const { rows } = await getPool().query(
    `SELECT a.id, a.name, a.description, a.persona, a.gateway, a.tier, a.version, a.enabled,
            a.routing_keywords, a.agent_type, a.gateways, a.response_language,
            COALESCE(json_agg(json_build_object(
              'name', s.name, 'instructions', s.instructions, 'content_hash', s.content_hash,
              'ord', ags.ord, 'tool_allowlist', s.tool_allowlist
            ) ORDER BY ags.ord) FILTER (WHERE s.id IS NOT NULL), '[]') AS skills
     FROM agents a
     LEFT JOIN agent_skills ags ON ags.agent_id = a.id
     LEFT JOIN skills s ON s.id = ags.skill_id AND s.enabled = true
     ${where}
     GROUP BY a.id
     ORDER BY a.name`,
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number, name: r.name as string, description: r.description as string,
    persona: r.persona as string, gateway: r.gateway as string, tier: r.tier as Tier,
    version: r.version as number, enabled: r.enabled as boolean,
    routingKeywords: (r.routing_keywords as string[]) ?? [],
    agentType: (r.agent_type as string) ?? 'generic',
    gateways: (r.gateways as string[]) ?? [],
    responseLanguage: (r.response_language as string) ?? null,
    skills: ((r.skills as Array<Record<string, unknown>>) ?? []).map((sk) => ({
      name: sk.name as string, instructions: sk.instructions as string,
      contentHash: sk.content_hash as string, ord: sk.ord as number,
      toolAllowlist: (sk.tool_allowlist as string[]) ?? [],
    })),
  }));
}

/**
 * ADR-031/ADR-039 fail-closed revocation. Authoritative (un-cached) check that a custom agent
 * is still enabled, used on the chat hot path BEFORE routing to a keyword-picked custom agent.
 * The catalog-source cache (30s TTL) can let `pickCustomAgent` *propose* a just-disabled agent;
 * this re-check reads Aurora (the single source of truth) on whichever Fargate task serves the
 * request, so a disable is effective immediately on every instance. Returns false (deny, never
 * grant) for missing / disabled / builtin rows and on ANY query error.
 */
export async function isCustomAgentEnabled(name: string): Promise<boolean> {
  try {
    const { rows } = await getPool().query(
      `SELECT 1 FROM agents WHERE name = $1 AND tier = 'custom' AND enabled = true LIMIT 1`,
      [name],
    );
    return rows.length > 0;
  } catch {
    return false; // fail-closed
  }
}

export async function writeAudit(a: { actor: string; action: string; objectType: string; objectId: string; beforeHash?: string; afterHash?: string }): Promise<void> {
  await getPool().query(
    `INSERT INTO customization_audit (actor, action, object_type, object_id, before_hash, after_hash)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [a.actor, a.action, a.objectType, a.objectId, a.beforeHash ?? null, a.afterHash ?? null],
  );
}
