// web/lib/catalog-source.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listMock = vi.fn();
vi.mock('@/lib/catalog', () => ({ listAgentsWithSkills: (...a: unknown[]) => listMock(...a) }));

const spaceMock = vi.fn();
vi.mock('@/lib/agent-space', () => ({ getAgentSpace: (...a: unknown[]) => spaceMock(...a) }));

import { getEnabledCustomAgents, _clearCacheForTests } from './catalog-source';

beforeEach(() => {
  listMock.mockReset();
  spaceMock.mockReset();
  spaceMock.mockResolvedValue(null); // default: no space row ⇒ Phase-1 behavior
  _clearCacheForTests();
  delete process.env.AURORA_ENDPOINT;
});

describe('catalog-source', () => {
  it('returns [] when Aurora is unconfigured (no AURORA_ENDPOINT)', async () => {
    expect(await getEnabledCustomAgents()).toEqual([]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns enabled custom agents from the DB and caches them', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockResolvedValue([
      { name: 'compliance', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
      { name: 'network', enabled: true, tier: 'builtin', skills: [], routingKeywords: [] },
    ]);
    const a = await getEnabledCustomAgents();
    expect(a.map((x) => x.name)).toEqual(['compliance']); // builtin filtered out
    expect(listMock).toHaveBeenCalledWith({ enabledOnly: true });
    await getEnabledCustomAgents(); // cached
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('returns [] (never throws) on DB error', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockRejectedValue(new Error('down'));
    expect(await getEnabledCustomAgents()).toEqual([]);
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
    _clearCacheForTests();
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
    const a = await getEnabledCustomAgents('self');
    expect(a.map((x) => x.id)).toEqual([1]); // agent-level scoping
  });

  it('cache is keyed by account + version: bumping version re-queries', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockResolvedValue([
      { id: 1, name: 'compliance', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
    ]);
    spaceMock.mockResolvedValue({
      accountId: 'self', enabledAgentIds: [1], enabledSkillIds: [], toolAllowlist: [], version: 1,
    });
    await getEnabledCustomAgents('self');
    await getEnabledCustomAgents('self'); // cached (same version)
    expect(listMock).toHaveBeenCalledTimes(1);
    spaceMock.mockResolvedValue({
      accountId: 'self', enabledAgentIds: [1], enabledSkillIds: [], toolAllowlist: [], version: 2,
    });
    await getEnabledCustomAgents('self'); // version bumped ⇒ re-query
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('separate accounts cache independently', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    listMock.mockResolvedValue([
      { id: 1, name: 'compliance', enabled: true, tier: 'custom', skills: [], routingKeywords: [] },
    ]);
    spaceMock.mockResolvedValue(null);
    await getEnabledCustomAgents('111111111111');
    await getEnabledCustomAgents('222222222222');
    expect(listMock).toHaveBeenCalledTimes(2); // distinct cache keys
  });

  it('DB error → [] (never throws), even with a space lookup in play', async () => {
    process.env.AURORA_ENDPOINT = 'h';
    spaceMock.mockResolvedValue(null);
    listMock.mockRejectedValue(new Error('down'));
    expect(await getEnabledCustomAgents('self')).toEqual([]);
  });
});
