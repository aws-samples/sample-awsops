// web/lib/agent-space.test.ts
// ADR-031 Phase 2 — pure intersection helper + degrade-safe CRUD.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const query = vi.fn();
const auditCalls: Array<Record<string, unknown>> = [];
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/catalog', () => ({
  writeAudit: (a: Record<string, unknown>) => { auditCalls.push(a); return Promise.resolve(); },
}));

import { intersectToolAllowlist, KNOWN_TOOL_CATALOG, getAgentSpace, upsertAgentSpace } from './agent-space';

beforeEach(() => {
  query.mockReset();
  auditCalls.length = 0;
  delete process.env.AURORA_ENDPOINT;
});

describe('intersectToolAllowlist (pure)', () => {
  it('no space + unknown gateway inventory (null) → skillTools unchanged', () => {
    expect(KNOWN_TOOL_CATALOG.network).toBeNull();
    expect(intersectToolAllowlist('network', ['a', 'b'])).toEqual(['a', 'b']);
    expect(intersectToolAllowlist('network', ['a', 'b'], null)).toEqual(['a', 'b']);
  });

  it('empty space.toolAllowlist → treated as no cap (Phase-1 advisory)', () => {
    expect(intersectToolAllowlist('network', ['a', 'b'], { toolAllowlist: [] })).toEqual(['a', 'b']);
  });

  it('non-empty space.toolAllowlist → result ⊆ cap (account cap REMOVES disallowed tools)', () => {
    const out = intersectToolAllowlist('network', ['a', 'b', 'c'], { toolAllowlist: ['a', 'c'] });
    expect(out).toEqual(['a', 'c']);
    const cap = new Set(['a', 'c']);
    expect(out.every((t) => cap.has(t))).toBe(true);
  });

  it('known catalog (non-null gateway entry) drops tools not in the catalog', () => {
    KNOWN_TOOL_CATALOG.network = ['a', 'b'];
    try {
      expect(intersectToolAllowlist('network', ['a', 'b', 'z'])).toEqual(['a', 'b']);
    } finally {
      KNOWN_TOOL_CATALOG.network = null; // restore
    }
  });

  it('cap can NEVER ADD a tool the skill did not declare', () => {
    // space allows 'a','b','q' but skill only declared 'a','b' → 'q' is not granted
    const out = intersectToolAllowlist('network', ['a', 'b'], { toolAllowlist: ['a', 'b', 'q'] });
    expect(out).toEqual(['a', 'b']);
    expect(out).not.toContain('q');
  });

  it('de-dupes and drops falsy skill tools before intersecting', () => {
    const out = intersectToolAllowlist('network', ['a', 'a', '', 'b'] as string[]);
    expect(out).toEqual(['a', 'b']);
  });

  it('security catalog (iam slice) is populated and narrows declared tools', () => {
    expect(KNOWN_TOOL_CATALOG.security).not.toBeNull();
    expect(KNOWN_TOOL_CATALOG.security).toHaveLength(14);
    expect(KNOWN_TOOL_CATALOG.security).toContain('simulate_principal_policy');
    // a declared tool absent from the security catalog is dropped (over-restriction is safe)
    expect(intersectToolAllowlist('security', ['simulate_principal_policy', 'not_a_real_tool']))
      .toEqual(['simulate_principal_policy']);
  });

  it('non-security gateways remain null (degrade-safe; P2 enumeration)', () => {
    for (const gw of ['network', 'container', 'iac', 'data', 'monitoring', 'cost', 'ops']) {
      expect(KNOWN_TOOL_CATALOG[gw]).toBeNull();
    }
  });
});

describe('getAgentSpace (degrade-safe)', () => {
  it('returns null when AURORA_ENDPOINT is unset (never queries)', async () => {
    expect(await getAgentSpace('self')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('returns null on NO ROW ⇒ Phase-1 global behavior', async () => {
    process.env.AURORA_ENDPOINT = 'aurora.example';
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getAgentSpace('self')).toBeNull();
  });

  it('returns null on DB error (never throws) ⇒ degrade to Phase-1', async () => {
    process.env.AURORA_ENDPOINT = 'aurora.example';
    query.mockRejectedValueOnce(new Error('connection refused'));
    await expect(getAgentSpace('self')).resolves.toBeNull();
  });

  it('maps a present row into AgentSpace, incl. integration + flag columns (nullish-safe)', async () => {
    process.env.AURORA_ENDPOINT = 'aurora.example';
    query.mockResolvedValueOnce({ rows: [{
      account_id: '123456789012', enabled_agent_ids: [1, 2], enabled_skill_ids: null,
      enabled_integration_ids: [7], tool_allowlist: ['a'],
      allow_private_datasource: true, non_admin_authoring: null, version: 3,
    }] });
    const sp = await getAgentSpace('123456789012');
    expect(sp).toEqual({
      accountId: '123456789012', enabledAgentIds: [1, 2], enabledSkillIds: [],
      enabledIntegrationIds: [7], toolAllowlist: ['a'],
      allowPrivateDatasource: true, nonAdminAuthoring: false, version: 3,
    });
    expect(query.mock.calls[0][0]).toMatch(/enabled_integration_ids/i);
    expect(query.mock.calls[0][0]).toMatch(/allow_private_datasource/i);
  });
});

describe('upsertAgentSpace', () => {
  it('inserts with version bump + persists enabled_integration_ids + writes an audit row', async () => {
    query.mockResolvedValueOnce({ rows: [{
      account_id: 'self', enabled_agent_ids: [1], enabled_skill_ids: [2], enabled_integration_ids: [9],
      tool_allowlist: ['a'], allow_private_datasource: false, non_admin_authoring: false, version: 2,
    }] });
    const out = await upsertAgentSpace({
      accountId: 'self', enabledAgentIds: [1], enabledSkillIds: [2], enabledIntegrationIds: [9], toolAllowlist: ['a'], actor: 'admin@x',
    });
    expect(out.version).toBe(2);
    expect(out.enabledIntegrationIds).toEqual([9]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO agent_spaces/i);
    expect(sql).toMatch(/ON CONFLICT \(account_id\) DO UPDATE/i);
    expect(sql).toMatch(/enabled_integration_ids\s*=\s*EXCLUDED\.enabled_integration_ids/i);
    expect(sql).toMatch(/version\s*=\s*agent_spaces\.version \+ 1/i);
    expect(params[0]).toBe('self');
    expect(params).toContain(JSON.stringify([9])); // enabled_integration_ids param
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ actor: 'admin@x', action: 'upsert', objectType: 'space', objectId: 'self' });
  });
});
