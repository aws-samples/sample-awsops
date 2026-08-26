// web/lib/catalog.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));

import { computeSkillHash, upsertSkill, upsertAgent, listSkills, listAgentsWithSkills, writeAudit, isCustomAgentEnabled } from './catalog';

beforeEach(() => query.mockReset());

describe('catalog', () => {
  it('computeSkillHash is stable and order-independent on tool_allowlist', () => {
    const a = computeSkillHash({ name: 's', description: 'd', instructions: 'i', toolAllowlist: ['x', 'y'] });
    const b = computeSkillHash({ name: 's', description: 'd', instructions: 'i', toolAllowlist: ['y', 'x'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('upsertSkill writes content_hash, tier, disabled-by-default', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const id = await upsertSkill({ name: 's', description: 'd', instructions: 'i', toolAllowlist: [], tier: 'custom', createdBy: 'a@x' });
    expect(id).toBe(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO skills/i);
    expect(sql).toMatch(/ON CONFLICT \(name\) DO UPDATE/i);
    expect(sql).toMatch(/enabled = false/i); // never re-enables on update
    expect(params).toContain('custom');
    expect(params.some((p: string) => /^[a-f0-9]{64}$/.test(p))).toBe(true);
  });

  it('listAgentsWithSkills maps snake_case rows + ordered skills', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 1, name: 'compliance', description: 'd', persona: 'P', gateway: 'security', tier: 'custom',
        version: 2, enabled: true, routing_keywords: ['cis'],
        skills: [{ name: 'cis', instructions: 'check', content_hash: 'h1', ord: 0, tool_allowlist: [] }] },
    ]});
    const agents = await listAgentsWithSkills({ enabledOnly: true });
    expect(agents[0].name).toBe('compliance');
    expect(agents[0].routingKeywords).toEqual(['cis']);
    expect(agents[0].skills[0].contentHash).toBe('h1');
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE a\.enabled = true/);
  });

  it('writeAudit inserts a row', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await writeAudit({ actor: 'a@x', action: 'upsert', objectType: 'skill', objectId: '1' });
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO customization_audit/i);
  });

  it('upsertSkill persists agent_types + reference_keys (default agent_types=[generic])', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    await upsertSkill({ name: 's', description: 'd', instructions: 'i', toolAllowlist: [], tier: 'custom' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/agent_types/i);
    expect(sql).toMatch(/reference_keys/i);
    expect(params).toContain(JSON.stringify(['generic'])); // default applied
  });

  it('upsertAgent persists agent_type, gateways (defaults to [gateway]) + response_language', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    await upsertAgent({ name: 'devx', description: 'd', persona: 'p', routingKeywords: ['x'], gateway: 'ops', tier: 'custom' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/agent_type/i);
    expect(sql).toMatch(/gateways/i);
    expect(sql).toMatch(/response_language/i);
    expect(params).toContain('generic');               // agent_type default
    expect(params).toContain(JSON.stringify(['ops']));  // gateways default = [gateway]
  });

  it('upsertAgent honors an explicit multi-gateway scope + agent_type', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 8 }] });
    await upsertAgent({ name: 'devops', description: 'd', persona: 'p', routingKeywords: [], gateway: 'ops',
      tier: 'builtin', agentType: 'triage', gateways: ['ops', 'monitoring'] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE agents\.tier = 'custom'/i); // never clobber a built-in via name collision
    expect(params).toContain('triage');
    expect(params).toContain(JSON.stringify(['ops', 'monitoring']));
  });

  it('upsertAgent throws on a built-in name collision (WHERE tier=custom matched nothing)', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // conflict on a builtin row ⇒ no update ⇒ no row returned
    await expect(upsertAgent({ name: 'devops', description: 'd', persona: 'p', routingKeywords: [], gateway: 'ops', tier: 'custom' }))
      .rejects.toThrow(/built-in agent/);
  });

  it('upsertSkill throws on a built-in name collision', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(upsertSkill({ name: 'builtin-pack', description: 'd', instructions: 'i', toolAllowlist: [], tier: 'custom' }))
      .rejects.toThrow(/built-in skill/);
  });

  it('listSkills returns agentTypes + referenceKeys (defaults when null)', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 1, name: 's1', description: 'd', tier: 'custom', enabled: true, version: 1, content_hash: 'h',
        agent_types: ['triage'], reference_keys: ['s3://k'] },
      { id: 2, name: 's2', description: 'd', tier: 'custom', enabled: false, version: 1, content_hash: 'h2',
        agent_types: null, reference_keys: null },
    ]});
    const skills = await listSkills();
    expect(skills[0].agentTypes).toEqual(['triage']);
    expect(skills[0].referenceKeys).toEqual(['s3://k']);
    expect(skills[1].agentTypes).toEqual(['generic']); // null → default
    expect(skills[1].referenceKeys).toEqual([]);
  });

  it('listAgentsWithSkills returns agentType/gateways/responseLanguage (defaults when absent)', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 1, name: 'devops', description: 'd', persona: 'P', gateway: 'ops', tier: 'builtin', version: 1,
        enabled: true, routing_keywords: [], agent_type: 'generic', gateways: ['ops', 'monitoring'],
        response_language: 'ko', skills: [] },
    ]});
    const agents = await listAgentsWithSkills();
    expect(agents[0].agentType).toBe('generic');
    expect(agents[0].gateways).toEqual(['ops', 'monitoring']);
    expect(agents[0].responseLanguage).toBe('ko');
  });
});

describe('isCustomAgentEnabled (fail-closed revocation)', () => {
  it('true only for an enabled custom row, scoped by name+tier+enabled', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await isCustomAgentEnabled('my-agent')).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/tier = 'custom'/i);
    expect(sql).toMatch(/enabled = true/i);
    expect(params).toEqual(['my-agent']);
  });

  it('false for a disabled/missing/builtin row (no row returned)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await isCustomAgentEnabled('disabled-or-builtin')).toBe(false);
  });

  it('false (fail-closed) on any query error — deny, never grant', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    await expect(isCustomAgentEnabled('x')).resolves.toBe(false);
  });
});
