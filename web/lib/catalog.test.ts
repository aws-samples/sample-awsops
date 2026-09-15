// web/lib/catalog.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));

import { computeSkillHash, upsertSkill, upsertAgent, listSkills, listAgentsWithSkills, writeAudit, isCustomAgentEnabled, attachSkill, setEnabled } from './catalog';

beforeEach(() => { query.mockReset(); });

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

  it('preserves query failure for dispatch callers that distinguish unavailable from disabled', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    await expect(isCustomAgentEnabled('x', { throwOnError: true })).rejects.toThrow('db down');
  });

  it('still returns false for a confirmed missing row in strict dispatch mode', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(isCustomAgentEnabled('x', { throwOnError: true })).resolves.toBe(false);
  });
});


it('preserves disabled-binding restriction metadata when there are no enabled skills', async () => {
  query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'audit', gateway: 'security', tier: 'custom',
    enabled: true, tool_policy_configured: true, skills: [] }] });
  expect((await listAgentsWithSkills())[0]).toMatchObject({ toolPolicyConfigured: true, skills: [] });
  const [sql] = query.mock.calls[0];
  expect(sql).toMatch(/a\.tool_policy_configured/);
  expect(sql).toMatch(/FILTER \(WHERE s\.id IS NOT NULL AND s\.enabled = true\)/);
  expect(sql).not.toMatch(/LEFT JOIN skills s ON s\.id = ags\.skill_id AND s\.enabled/);
});


it.skipIf(!process.env.POLICY_TEST_POSTGRES_SOCKET)('revokes a disabled scoped skill through the real PostgreSQL catalog query', async () => {
  const { Client } = await import('pg');
  const { resolveAgent } = await import('./agent-resolver');
  const client = new Client({ host: process.env.POLICY_TEST_POSTGRES_SOCKET, database: 'awsops', user: 'postgres' });
  await client.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE agents (id int PRIMARY KEY, name text, description text, persona text,
        gateway text, tier text, version int, enabled boolean, routing_keywords jsonb,
        agent_type text, gateways jsonb, response_language text, tool_policy_configured boolean);
      CREATE TEMP TABLE skills (id int PRIMARY KEY, name text, instructions text, content_hash text,
        tool_allowlist jsonb, enabled boolean);
      CREATE TEMP TABLE agent_skills (agent_id int, skill_id int, ord int);
      INSERT INTO agents VALUES (1,'audit','d','Read only','security','custom',1,true,'[]','generic','[]',null,true);
      INSERT INTO skills VALUES (1,'scoped','Scoped instructions','h1','["list_users"]',true),
        (2,'tone','Be concise','h2','[]',true);
      INSERT INTO agent_skills VALUES (1,1,0),(1,2,1);
    `);
    query.mockImplementation((sql, params) => client.query(sql, params));
    const before = await listAgentsWithSkills({ enabledOnly: true });
    expect(resolveAgent('audit', before).toolAllowlist).toEqual(['iam-mcp-target___list_users']);
    await client.query('UPDATE skills SET enabled=false WHERE id=1');
    const after = await listAgentsWithSkills({ enabledOnly: true });
    expect(after[0].toolPolicyConfigured).toBe(true);
    expect(after[0].skills.map(skill => skill.name)).toEqual(['tone']);
    expect(resolveAgent('audit', after).toolAllowlist).toEqual([]);
    expect(resolveAgent('audit', after).systemPromptOverride).not.toContain('Scoped instructions');
  } finally {
    await client.end();
  }
});


it.skipIf(!process.env.POLICY_TEST_POSTGRES_SOCKET)('keeps restrictions after real skill edit, detach, and reattach', async () => {
  const { Client } = await import('pg');
  const { readFileSync } = await import('node:fs');
  const { resolveAgent } = await import('./agent-resolver');
  const client = new Client({ host: process.env.POLICY_TEST_POSTGRES_SOCKET, database: 'awsops', user: 'postgres' });
  await client.connect();
  try {
    const marker = await client.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
    expect(marker.rows[0]?.marker).toBe('awsops-disposable-graph-test');
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA policy_history_test');
    await client.query('SET LOCAL search_path=policy_history_test');
    await client.query(readFileSync('../terraform/foundation/migrations/01KTY39P4SV1SQES36KCS8BESY_custom_agent_platform_p1.sql', 'utf8'));
    query.mockImplementation((sql, params) => client.query(sql, params));
    const agent = { name: 'audit-test', description: 'd', persona: 'Read only', gateway: 'security', routingKeywords: [], tier: 'custom' as const };
    const skill = { name: 'scoped-test', description: 'd', instructions: 'Check users', toolAllowlist: ['list_users'], tier: 'custom' as const };
    const aid = await upsertAgent(agent);
    const sid = await upsertSkill(skill);
    await attachSkill(aid, sid);
    await setEnabled('agent', aid, true);
    await setEnabled('skill', sid, true);
    const migration = readFileSync('../terraform/foundation/migrations/01M2K0BTQ4P4QHHFHR44ZK1YW6_agent_tool_policy_history.sql', 'utf8');
    await client.query(migration);
    await client.query(migration); // replay is idempotent and cannot reset a latched restriction
    const grant = async () => resolveAgent(agent.name, await listAgentsWithSkills({ enabledOnly: true })).toolAllowlist;
    expect(await grant()).toEqual(['iam-mcp-target___list_users']);
    await upsertSkill({ ...skill, toolAllowlist: [] });
    expect(await grant()).toEqual([]);
    await setEnabled('skill', sid, true);
    expect(await grant()).toEqual([]);
    await client.query('DELETE FROM agent_skills WHERE agent_id=$1', [aid]);
    expect(await grant()).toEqual([]);
    await attachSkill(aid, sid);
    expect(await grant()).toEqual([]);
    await upsertAgent(agent);
    await setEnabled('agent', aid, true);
    expect(await grant()).toEqual([]);
    await upsertSkill({ ...skill, toolAllowlist: ['list_roles'] });
    await setEnabled('skill', sid, true);
    expect(await grant()).toEqual(['iam-mcp-target___list_roles']);
    await client.query("UPDATE skills SET tool_allowlist='{}'::jsonb WHERE id=$1", [sid]);
    expect(await grant()).toEqual([]);
  } finally { await client.query('ROLLBACK'); await client.end(); }
});


it.skipIf(!process.env.POLICY_TEST_POSTGRES_SOCKET)('serializes scope edits with concurrent binding creation', async () => {
  const { Client } = await import('pg');
  const { readFileSync } = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  const schema = `policy_race_${randomUUID().replaceAll('-', '')}`;
  const config = { host: process.env.POLICY_TEST_POSTGRES_SOCKET, database: 'awsops', user: 'postgres' };
  const admin = new Client(config), first = new Client(config), second = new Client(config);
  await Promise.all([admin.connect(), first.connect(), second.connect()]);
  let created = false;
  let pending: Promise<unknown> | undefined;
  try {
    const marker = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
    expect(marker.rows[0]?.marker).toBe('awsops-disposable-graph-test');
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const client of [admin, first, second]) {
      await client.query(`SET search_path="${schema}"`);
      await client.query("SET statement_timeout='5s'");
    }
    await admin.query(readFileSync('../terraform/foundation/migrations/01KTY39P4SV1SQES36KCS8BESY_custom_agent_platform_p1.sql', 'utf8'));
    await admin.query(readFileSync('../terraform/foundation/migrations/01M2K0BTQ4P4QHHFHR44ZK1YW6_agent_tool_policy_history.sql', 'utf8'));
    for (const editFirst of [true, false]) {
      const a = await admin.query("INSERT INTO agents(name,description,gateway,tier) VALUES($1,'d','security','custom') RETURNING id", [String(editFirst)]);
      const k = await admin.query("INSERT INTO skills(name,description,content_hash,tier) VALUES($1,'d','h','custom') RETURNING id", [String(editFirst)]);
      const aid = a.rows[0].id, sid = k.rows[0].id;
      const edit = "UPDATE skills SET tool_allowlist='[\"list_users\"]'::jsonb WHERE id=$1";
      const bind = 'INSERT INTO agent_skills(agent_id,skill_id,ord) VALUES($1,$2,0)';
      await first.query('BEGIN');
      await first.query(editFirst ? edit : bind, editFirst ? [sid] : [aid, sid]);
      pending = second.query(editFirst ? bind : edit, editFirst ? [aid, sid] : [sid]);
      // Wait for the real conflicting row lock, not an assumed scheduling delay.
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const state = await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [(second as unknown as { processID: number }).processID]);
        waiting = state.rows[0]?.wait_event_type === 'Lock';
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await first.query('COMMIT');
      await pending; pending = undefined;
      const row = await admin.query('SELECT tool_policy_configured FROM agents WHERE id=$1', [aid]);
      expect(row.rows[0].tool_policy_configured).toBe(true);
      await admin.query('DELETE FROM agent_skills WHERE agent_id=$1', [aid]);
      expect((await admin.query('SELECT tool_policy_configured FROM agents WHERE id=$1', [aid])).rows[0].tool_policy_configured).toBe(true);
    }
  } finally {
    await first.query('ROLLBACK');
    await pending?.catch(() => {});
    await Promise.all([first.end(), second.end()]);
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}, 15_000);
