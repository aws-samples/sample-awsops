// web/lib/catalog-source.ts
// ADR-031 Phase 1+2 — single catalog reader for the chat hot path. Aurora + 30s cache.
// Phase 2: account-aware. NO agent_spaces row ⇒ Phase-1 global behavior (all
// globally-enabled customs). A row scopes the set to its enabled_agent_ids.
//
// Skill scoping boundary (shipped): agent-level scoping (enabledAgentIds) is the
// load-bearing filter on the hot path. SkillRef carries no id, so enabled_skill_ids
// is NOT applied here; it gates the per-account composition UI (which skills an admin
// may attach in the space) rather than the runtime skill set. This keeps the change
// confined to catalog-source.ts (catalog.ts SkillRef shape is unchanged) and matches
// the plan's "minimal Phase 2" boundary. The account tool_allowlist cap is enforced
// downstream in the resolver (intersectToolAllowlist), where it can only REMOVE tools.
import { listAgentsWithSkills, type AgentWithSkills } from '@/lib/catalog';
import { getAgentSpace } from '@/lib/agent-space';

const TTL_MS = 30_000; // acceptable-staleness window for non-security enable changes (Addendum #2)
const cache = new Map<string, { at: number; ver: number; data: AgentWithSkills[] }>();

export function _clearCacheForTests() { cache.clear(); }

export async function getEnabledCustomAgents(accountId?: string): Promise<AgentWithSkills[]> {
  if (!process.env.AURORA_ENDPOINT) return [];
  const acct = accountId ?? 'self';
  try {
    const space = await getAgentSpace(acct);       // null ⇒ Phase-1 global behavior
    const ver = space?.version ?? 0;               // 0 = "no space"; busts cache on version bump
    const now = Date.now();
    const hit = cache.get(acct);
    if (hit && hit.ver === ver && now - hit.at < TTL_MS) return hit.data;

    const all = await listAgentsWithSkills({ enabledOnly: true });
    let data = all.filter((a) => a.tier === 'custom');   // Phase-1 set

    if (space) {
      const agentSet = new Set(space.enabledAgentIds);
      data = data.filter((a) => agentSet.has(a.id));     // account-scoped subset
    }
    cache.set(acct, { at: now, ver, data });
    return data;
  } catch {
    return []; // resolver falls back to built-in; assistant never breaks
  }
}
