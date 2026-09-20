// web/lib/catalog-source.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listMock = vi.fn();
vi.mock('@/lib/catalog', () => ({ listAgentsWithSkills: (...a: unknown[]) => listMock(...a) }));

const spaceMock = vi.fn();
vi.mock('@/lib/agent-space', () => ({ getAgentSpace: (...a: unknown[]) => spaceMock(...a) }));

import { getEnabledCustomAgents, getCustomAgentContext } from './catalog-source';

beforeEach(() => {
  listMock.mockReset();
  spaceMock.mockReset();
  spaceMock.mockResolvedValue(null); // default: no space row ⇒ Phase-1 behavior
  delete process.env.AURORA_ENDPOINT;
});

describe('catalog-source', () => {
  it.each(['space', 'agents'])('denies custom candidates consistently on a failed %s read', async (failure) => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockResolvedValue([{ id: 1, name: 'audit', enabled: true, tier: 'custom', skills: [] }]);
    if (failure === 'space') spaceMock.mockRejectedValue(new Error('down'));
    else listMock.mockRejectedValue(new Error('down'));
    expect(await getCustomAgentContext('self')).toEqual({ status: 'unavailable', agents: [], space: null });
    expect(spaceMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledTimes(failure === 'space' ? 0 : 1);
  });
  it('propagates policy read errors instead of degrading to an unscoped catalog', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    spaceMock.mockRejectedValue(new Error('Agent Space policy unavailable'));
    await expect(getEnabledCustomAgents()).rejects.toThrow('Custom-agent catalog unavailable');
    expect(listMock).not.toHaveBeenCalled();
  });
  it('excludes historical command-name collisions from discovery and runtime candidates', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockResolvedValue(['observability', 'auto', 'code', 'safe-agent'].map((name, id) => ({
      id, name, enabled: true, tier: 'custom', skills: [], routingKeywords: [],
    })));
    expect((await getEnabledCustomAgents()).map((agent) => agent.name)).toEqual(['safe-agent']);
  });
  it('does not reuse a disabled skill from an earlier turn', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    const agent = { id: 1, name: 'compliance', enabled: true, tier: 'custom', routingKeywords: [] };
    listMock.mockResolvedValue([{ ...agent, skills: [{ name: 'revoked', instructions: 'Old instructions' }] }]);
    expect((await getEnabledCustomAgents())[0].skills).toHaveLength(1);
    listMock.mockResolvedValue([{ ...agent, skills: [] }]); // authoritative enabled-skill join after disable
    expect((await getEnabledCustomAgents())[0].skills).toEqual([]);
  });
  it('denies stale content when the authoritative read fails after a successful turn', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockResolvedValue([{ id: 1, name: 'compliance', enabled: true, tier: 'custom', skills: [], routingKeywords: [] }]);
    expect(await getEnabledCustomAgents()).toHaveLength(1);
    listMock.mockRejectedValue(new Error('unavailable'));
    expect(await getCustomAgentContext()).toEqual({ status: 'unavailable', agents: [], space: null });
  });
  it('returns an available empty context when Aurora is unconfigured', async () => {
    expect(await getCustomAgentContext()).toEqual({ status: 'available', agents: [], space: null });
    expect(listMock).not.toHaveBeenCalled();
  });

  it('reads enabled custom agents authoritatively on every turn', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockResolvedValue([
      { name: 'compliance', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
      { name: 'network', enabled: true, tier: 'builtin', skills: [], routingKeywords: [] },
    ]);
    const a = await getEnabledCustomAgents();
    expect(a.map((x) => x.name)).toEqual(['compliance']); // builtin filtered out
    expect(listMock).toHaveBeenCalledWith({ enabledOnly: true });
    await getEnabledCustomAgents();
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('returns an unavailable context on catalog DB error', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockRejectedValue(new Error('down'));
    expect(await getCustomAgentContext()).toEqual({ status: 'unavailable', agents: [], space: null });
  });

  // --- Phase 2: account-aware, degrade-safe ---

  it('no space row ⇒ identical Phase-1 set (all globally-enabled customs) for default and "self"', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    spaceMock.mockResolvedValue(null);
    listMock.mockResolvedValue([
      { id: 1, name: 'compliance', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
      { id: 2, name: 'finops', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
      { id: 3, name: 'network', enabled: true, tier: 'builtin', skills: [], routingKeywords: [] },
    ]);
    const noArg = await getEnabledCustomAgents();
    expect(noArg.map((x) => x.name)).toEqual(['compliance', 'finops']); // builtin filtered; all customs survive
    const selfArg = await getEnabledCustomAgents('self');
    expect(selfArg.map((x) => x.name)).toEqual(['compliance', 'finops']); // identical
  });

  it('with a space scopes to enabledAgentIds (only id 1 survives)', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    spaceMock.mockResolvedValue({
      accountId: 'self', enabledAgentIds: [1], enabledSkillIds: [], toolAllowlist: [], version: 1,
    });
    listMock.mockResolvedValue([
      { id: 1, name: 'compliance', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
      { id: 2, name: 'finops', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
      { id: 3, name: 'network', enabled: true, tier: 'builtin', skills: [], routingKeywords: [] },
    ]);
    const context = await getCustomAgentContext('self');
    expect(context.status).toBe('available');
    expect(context.space?.version).toBe(1);
    expect(spaceMock).toHaveBeenCalledOnce();
    expect(context.agents.map((x) => x.id)).toEqual([1]); // agent-level scoping
  });

  it('reads fresh content even when the Agent Space version is unchanged', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockResolvedValue([
      { id: 1, name: 'compliance', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
    ]);
    spaceMock.mockResolvedValue({
      accountId: 'self', enabledAgentIds: [1], enabledSkillIds: [], toolAllowlist: [], version: 1,
    });
    await getEnabledCustomAgents('self');
    await getEnabledCustomAgents('self');
    expect(listMock).toHaveBeenCalledTimes(2);
    spaceMock.mockResolvedValue({
      accountId: 'self', enabledAgentIds: [1], enabledSkillIds: [], toolAllowlist: [], version: 2,
    });
    await getEnabledCustomAgents('self');
    expect(listMock).toHaveBeenCalledTimes(3);
  });

  it('reads separate accounts independently', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockResolvedValue([
      { id: 1, name: 'compliance', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
    ]);
    spaceMock.mockResolvedValue(null);
    await getEnabledCustomAgents('111111111111');
    await getEnabledCustomAgents('222222222222');
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable after catalog failure with a space lookup in play', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    spaceMock.mockResolvedValue(null);
    listMock.mockRejectedValue(new Error('down'));
    expect(await getCustomAgentContext('self')).toEqual({ status: 'unavailable', agents: [], space: null });
  });
});
