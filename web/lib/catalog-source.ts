// web/lib/catalog-source.ts
// Authoritative per-turn catalog read: cached skill instructions cannot survive revocation.
// Phase 2: account-aware. NO agent_spaces row ⇒ Phase-1 global behavior (all
// globally-enabled customs). A row scopes the set to its enabled_agent_ids.
//
// Agent Space agent membership and the resolver's tool cap govern runtime scope.
// enabled_skill_ids is persisted metadata; neither the attachment UI/API nor this
// reader enforces it. Only globally enabled attached skills enter the composition.
import { listAgentsWithSkills, type AgentWithSkills } from '@/lib/catalog';
import { getAgentSpace, type AgentSpace } from '@/lib/agent-space';
import { isReservedAgentName } from '@/lib/skill-validation';

export type CustomAgentContext =
  | { status: 'available'; agents: AgentWithSkills[]; space: AgentSpace | null }
  | { status: 'unavailable'; agents: []; space: null };

/** Read one policy/catalog context per turn. An unavailable context authorizes no custom agent. */
export async function getCustomAgentContext(accountId?: string): Promise<CustomAgentContext> {
  if (!process.env.AURORA_ENDPOINT) return { status: 'available', agents: [], space: null };
  const acct = accountId ?? 'self';
  try {
    const space = await getAgentSpace(acct); // null only after a confirmed no-row read
    const all = await listAgentsWithSkills({ enabledOnly: true });
    // Preserve historical rows, but never expose/run command-name collisions as custom agents.
    let data = all.filter((a) => a.tier === 'custom' && !isReservedAgentName(a.name));

    if (space) {
      const agentSet = new Set(space.enabledAgentIds);
      data = data.filter((a) => agentSet.has(a.id));     // account-scoped subset
    }
    return { status: 'available', agents: data, space };
  } catch {
    return { status: 'unavailable', agents: [], space: null };
  }
}

/** Compatibility for list-only callers; dispatch uses the explicit context above. */
export async function getEnabledCustomAgents(accountId?: string): Promise<AgentWithSkills[]> {
  const context = await getCustomAgentContext(accountId);
  if (context.status === 'unavailable') throw new Error('Custom-agent catalog unavailable');
  return context.agents;
}
