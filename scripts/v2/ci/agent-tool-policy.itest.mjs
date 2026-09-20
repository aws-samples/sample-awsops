// Mandatory offline PostgreSQL regression: owned disposable server, no application DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { disposablePostgres, waitForQuery } from './postgres-test-fixture.mjs';
const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const ts = require('typescript');
const migration = new URL('../../../terraform/foundation/migrations/01M2K0BTQ4P4QHHFHR44ZK1YW6_agent_tool_policy_history.sql', import.meta.url);
const schema = new URL('../../../terraform/foundation/migrations/01KTY39P4SV1SQES36KCS8BESY_custom_agent_platform_p1.sql', import.meta.url);
let fixture;
before(async () => { fixture = await disposablePostgres(); });
after(async () => { await fixture?.close(); });
function catalog(client) {
  const filename = new URL('../../../web/lib/catalog.ts', import.meta.url).pathname;
  const mod = new Module(filename);
  mod.require = id => id === '@/lib/db' ? { getPool: () => client } : require(id);
  mod._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}
async function setup(tools = ['list_users'], enabled = true) {
  const database = await fixture.database();
  assert.match(database, /^test_\d+$/);
  assert.equal(fixture.config.host, '127.0.0.1');
  const client = fixture.client(database);
  await client.connect();
  await client.query("COMMENT ON DATABASE " + database + " IS 'owned-agent-policy-fixture'");
  const guard = await client.query("SELECT current_database() AS name, shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
  assert.deepEqual(guard.rows, [{ name: database, marker: 'owned-agent-policy-fixture' }]);
  await client.query(readFileSync(schema, 'utf8'));
  const api = catalog(client);
  const agentId = await api.upsertAgent({ name: 'audit', description: 'd', persona: 'readonly', gateway: 'security', routingKeywords: [], tier: 'custom' });
  const skill = { name: 'scope', description: 'd', instructions: 'safe', toolAllowlist: tools, tier: 'custom' };
  const skillId = await api.upsertSkill(skill);
  await api.attachSkill(agentId, skillId);
  await api.setEnabled('skill', skillId, enabled);
  await api.setEnabled('agent', agentId, true);
  await client.query(readFileSync(migration, 'utf8'));
  const state = async () => (await api.listAgentsWithSkills()).find(a => a.id == agentId);
  return { database, client, api, agentId, skillId, skill, state };
}
test('edits/removals stay restricted, and explicit regrants restore only their tools', async () => {
  const x = await setup();
  assert.equal((await x.state()).toolPolicyConfigured, true);
  await x.api.setEnabled('skill', x.skillId, false);
  assert.equal((await x.state()).skills.length, 0);
  await x.api.upsertSkill({ ...x.skill, toolAllowlist: [] });
  await x.api.setEnabled('skill', x.skillId, true);
  assert.equal((await x.state()).toolPolicyConfigured, true);
  await x.client.query('DELETE FROM agent_skills WHERE agent_id=$1', [x.agentId]);
  await x.client.query('DELETE FROM skills WHERE id=$1', [x.skillId]);
  await x.api.upsertAgent({ name: 'audit', description: 'edited', persona: 'readonly', gateway: 'security', routingKeywords: [], tier: 'custom' });
  assert.equal((await x.state()).toolPolicyConfigured, true);
  assert.deepEqual((await x.state()).skills, []);
  const next = await x.api.upsertSkill({ ...x.skill, toolAllowlist: ['get_role_details'] });
  await x.api.attachSkill(x.agentId, next);
  await x.api.setEnabled('skill', next, true);
  assert.deepEqual((await x.state()).skills[0].toolAllowlist, ['get_role_details']);
  await x.client.query('DELETE FROM agents WHERE id=$1', [x.agentId]);
});
test('prompt-only disable preserves legacy behavior; rolled-back restrictions do not persist', async () => {
  const x = await setup([]);
  await x.api.setEnabled('skill', x.skillId, false);
  assert.equal((await x.state()).toolPolicyConfigured, false);
  await x.client.query('BEGIN');
  await x.api.upsertSkill({ ...x.skill, toolAllowlist: ['list_users'] });
  assert.equal((await x.state()).toolPolicyConfigured, true);
  await x.client.query('ROLLBACK');
  assert.equal((await x.state()).toolPolicyConfigured, false);
  await x.client.query('DELETE FROM agent_skills');
  assert.equal((await x.state()).toolPolicyConfigured, false);
});
test('binding moves preserve both histories; malformed declarations deny without a catalog outage', async () => {
  const x = await setup([]);
  await x.client.query("UPDATE skills SET tool_allowlist='{}'::jsonb WHERE id=$1", [x.skillId]);
  await x.api.setEnabled('skill', x.skillId, true);
  assert.equal((await x.state()).toolPolicyConfigured, true);
  assert.deepEqual((await x.state()).skills[0].toolAllowlist, []);
  const id = await x.api.upsertAgent({ name: 'second', description: 'd', persona: '', gateway: 'security', routingKeywords: [], tier: 'custom' });
  await x.client.query('UPDATE agent_skills SET agent_id=$1 WHERE agent_id=$2', [id, x.agentId]);
  const moved = (await x.api.listAgentsWithSkills()).filter(a => [String(x.agentId), String(id)].includes(String(a.id)));
  assert.equal(moved.length, 2);
  assert.ok(moved.every(a => a.toolPolicyConfigured));
});
for (const first of ['attach', 'edit']) test(`concurrent ${first} then the other writer retains new restrictions`, async () => {
  const x = await setup([]);
  await x.client.query('DELETE FROM agent_skills');
  const other = fixture.client(x.database);
  await other.connect();
  const otherApi = catalog(other);
  await x.client.query('BEGIN');
  if (first === 'attach') await x.api.attachSkill(x.agentId, x.skillId);
  else await x.api.upsertSkill({ ...x.skill, toolAllowlist: ['list_users'] });
  const pending = first === 'attach'
    ? otherApi.upsertSkill({ ...x.skill, toolAllowlist: ['list_users'] })
    : otherApi.attachSkill(x.agentId, x.skillId);
  await waitForQuery(x.client, "SELECT wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()", rows => rows.some(r => r.wait_event_type === 'Lock'));
  await x.client.query('COMMIT');
  await pending;
  await x.api.upsertSkill({ ...x.skill, toolAllowlist: [] });
  assert.equal((await x.state()).toolPolicyConfigured, true);
});

test('disabled restrictive binding is backfilled and reapplying the migration preserves history', async () => {
  const x = await setup(['list_users'], false);
  assert.equal((await x.state()).toolPolicyConfigured, true);
  assert.deepEqual((await x.state()).skills, []);
  await x.client.query('DELETE FROM agent_skills WHERE agent_id=$1', [x.agentId]);
  await x.client.query(readFileSync(migration, 'utf8'));
  assert.equal((await x.state()).toolPolicyConfigured, true);
});
