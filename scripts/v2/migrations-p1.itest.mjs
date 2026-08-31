#!/usr/bin/env node
// scripts/v2/migrations-p1.itest.mjs — idempotency + correctness test for the Custom Agent Platform P1
// migration against a disposable PostgreSQL 17 container.
//
//   node scripts/v2/migrations-p1.itest.mjs
//
// Spins postgres:17 (sudo docker, random port bound 127.0.0.1, runtime-random password), loads the baseline
// terraform/foundation/data/schema.sql, then applies the P1 migration TWICE and asserts: the 5 ADR-031
// catalog tables + integrations exist; the new columns exist; the agent_type CHECK is enforced; gateways[]
// is backfilled; devops/security/finops are seeded (builtin, enabled, agent_type='generic'); and the second
// apply is a clean no-op (identical agent count, no error). Skips cleanly if docker is unreachable. Tears the
// container down on EXIT/SIGINT/SIGTERM.
import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const SCHEMA = 'terraform/foundation/data/schema.sql';
const MIGRATION = 'terraform/foundation/migrations/01KTY39P4SV1SQES36KCS8BESY_custom_agent_platform_p1.sql';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) failures++; };

let CID = null;
function teardown() { if (CID) { try { execFileSync('sudo', ['docker', 'rm', '-f', CID], { stdio: 'ignore' }); } catch { /* best effort */ } CID = null; } }
process.on('exit', teardown);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { teardown(); process.exit(1); });

const docker = (args, opts = {}) => execFileSync('sudo', ['docker', ...args], { encoding: 'utf8', ...opts });

async function main() {
  try { docker(['ps'], { stdio: 'ignore' }); } catch { console.log('SKIP: docker daemon not reachable — integration test skipped'); process.exit(0); }

  const PW = randomBytes(16).toString('hex');
  CID = docker(['run', '-d', '--rm', '-e', `POSTGRES_PASSWORD=${PW}`, '-e', 'POSTGRES_DB=awsops', '-p', '127.0.0.1::5432', 'postgres:17']).trim();
  const PORT = docker(['port', CID, '5432']).trim().split(':').pop().trim();
  const DSN = `postgresql://postgres:${PW}@127.0.0.1:${PORT}/awsops`;
  console.log(`container ${CID.slice(0, 12)} on 127.0.0.1:${PORT}`);

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { docker(['exec', CID, 'pg_isready', '-U', 'postgres', '-d', 'awsops'], { stdio: 'ignore' }); ready = true; break; } catch { await sleep(1000); }
  }
  if (!ready) { console.log('✗ container never became ready'); process.exit(1); }

  const psql = (file) => execSync(`sudo docker exec -i ${CID} psql -U postgres -d awsops -v ON_ERROR_STOP=1 -q < ${file}`, { stdio: ['pipe', 'ignore', 'inherit'] });
  const q = async (sql, params) => {
    const c = new pg.Client({ connectionString: DSN }); await c.connect();
    try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
  };
  const count = async (t) => Number((await q(`SELECT count(*)::int AS c FROM ${t}`))[0].c);
  const reg = async (t) => (await q('SELECT to_regclass($1) AS r', [`public.${t}`]))[0].r;
  const hasCol = async (t, col) => Number((await q(
    'SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [t, col]))[0].c) === 1;

  // baseline schema
  psql(SCHEMA);

  // ── apply #1 ──
  console.log('\n[1] first migration apply');
  psql(MIGRATION);
  const agentsAfter1 = await count('agents');

  check('table skills exists', (await reg('skills')) !== null);
  check('table agents exists', (await reg('agents')) !== null);
  check('table agent_skills exists', (await reg('agent_skills')) !== null);
  check('table customization_audit exists', (await reg('customization_audit')) !== null);
  check('table agent_spaces exists', (await reg('agent_spaces')) !== null);
  check('table integrations exists', (await reg('integrations')) !== null);

  check('col agents.agent_type', await hasCol('agents', 'agent_type'));
  check('col agents.gateways', await hasCol('agents', 'gateways'));
  check('col agents.response_language', await hasCol('agents', 'response_language'));
  check('col skills.agent_types', await hasCol('skills', 'agent_types'));
  check('col skills.reference_keys', await hasCol('skills', 'reference_keys'));
  check('col agent_spaces.enabled_integration_ids', await hasCol('agent_spaces', 'enabled_integration_ids'));
  check('col agent_spaces.response_language', await hasCol('agent_spaces', 'response_language'));

  // frontier seeds (security reuses the baseline gateway row via ON CONFLICT DO NOTHING)
  for (const name of ['devops', 'security', 'finops']) {
    const r = (await q("SELECT tier, enabled, agent_type FROM agents WHERE name=$1", [name]))[0];
    check(`frontier '${name}' seeded builtin+enabled+agent_type=generic`,
      !!r && r.tier === 'builtin' && r.enabled === true && r.agent_type === 'generic');
  }

  // gateways[] backfill: baseline 'ops' gateway agent → ["ops"]; new 'devops' → 5-element array
  check("gateways backfill: ops → [\"ops\"]",
    JSON.stringify((await q("SELECT gateways FROM agents WHERE name='ops'"))[0].gateways) === JSON.stringify(['ops']));
  check("devops gateways = 5-section composite",
    (await q("SELECT gateways FROM agents WHERE name='devops'"))[0].gateways.length === 5);
  check('no agent left with empty gateways[]', (await count("agents WHERE gateways = '[]'::jsonb")) === 0);

  // agent_type CHECK enforced
  let checkRejected = false;
  try { await q("INSERT INTO agents (name,description,gateway,tier,agent_type) VALUES ('bad-at','x','ops','custom','bogus')"); }
  catch { checkRejected = true; }
  check('agent_type CHECK rejects out-of-set value', checkRejected);

  // ── apply #2 (idempotency) ──
  console.log('\n[2] second migration apply (idempotent no-op)');
  let reapplyOk = true;
  try { psql(MIGRATION); } catch { reapplyOk = false; }
  check('re-apply raises no error', reapplyOk);
  check('agents count unchanged after re-apply', (await count('agents')) === agentsAfter1);
  check('exactly 2 new frontier rows added over the 8 baseline gateways (devops+finops; security no-op)',
    agentsAfter1 === 10);

  console.log(`\n${failures === 0 ? '✅ ALL MIGRATION CHECKS PASSED' : `✗ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
