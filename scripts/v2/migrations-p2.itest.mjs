#!/usr/bin/env node
// scripts/v2/migrations-p2.itest.mjs — idempotency + correctness for the Custom Agent Platform P2
// migration (integrations direction + ingress columns + kind CHECK; agent_spaces opt-in flags) against
// a disposable PostgreSQL 17 container.
//
//   node scripts/v2/migrations-p2.itest.mjs
//
// Loads schema.sql, then the P1 migration (creates `integrations` + agent_spaces.enabled_integration_ids),
// then the P2 migration TWICE, and asserts the new columns/CHECKs exist, the direction-conditional kind
// CHECK actually rejects a mismatched row, and the second apply is a clean no-op. Skips if docker is
// unreachable; tears the container down on EXIT/SIGINT/SIGTERM.
import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const SCHEMA = 'terraform/foundation/data/schema.sql';
const MIG_P1 = 'terraform/foundation/migrations/01KTY39P4SV1SQES36KCS8BESY_custom_agent_platform_p1.sql';
const MIG_P2 = 'terraform/foundation/migrations/01KV0JKFF7Q28CMKQ2JGM2D1NK_integrations_p2.sql';
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
  const hasCol = async (t, col) => Number((await q(
    'SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [t, col]))[0].c) === 1;
  const hasConstraint = async (name) => Number((await q('SELECT count(*)::int AS c FROM pg_constraint WHERE conname=$1', [name]))[0].c) === 1;

  psql(SCHEMA);
  psql(MIG_P1);

  // ── apply P2 #1 ──
  console.log('\n[1] first P2 apply');
  psql(MIG_P2);
  for (const c of ['direction', 'auth_mode', 'receive_path', 'inbound_auth_ref', 'source_allowlist', 'trigger_target']) {
    check(`integrations.${c}`, await hasCol('integrations', c));
  }
  check('agent_spaces.allow_private_datasource', await hasCol('agent_spaces', 'allow_private_datasource'));
  check('agent_spaces.non_admin_authoring', await hasCol('agent_spaces', 'non_admin_authoring'));
  check('constraint integrations_direction_check', await hasConstraint('integrations_direction_check'));
  check('constraint integrations_kind_check', await hasConstraint('integrations_kind_check'));

  // conditional kind CHECK actually enforces: egress row with an ingress kind must be rejected
  let mismatchRejected = false;
  try { await q("INSERT INTO integrations (name,kind,direction,tier) VALUES ('bad','generic_webhook','egress','custom')"); }
  catch { mismatchRejected = true; }
  check('kind CHECK rejects egress row with an ingress kind', mismatchRejected);
  // a valid egress row is accepted
  await q("INSERT INTO integrations (name,kind,direction,tier) VALUES ('grafana-ro','grafana','egress','custom') ON CONFLICT (name) DO NOTHING");
  check('valid egress row accepted', Number((await q("SELECT count(*)::int c FROM integrations WHERE name='grafana-ro'"))[0].c) === 1);
  // a valid ingress row is accepted
  await q("INSERT INTO integrations (name,kind,direction,tier) VALUES ('pd-in','pagerduty','ingress','custom') ON CONFLICT (name) DO NOTHING");
  check('valid ingress row accepted', Number((await q("SELECT count(*)::int c FROM integrations WHERE name='pd-in'"))[0].c) === 1);
  const rowsAfter1 = Number((await q('SELECT count(*)::int c FROM integrations'))[0].c);

  // ── apply P2 #2 (idempotent) ──
  console.log('\n[2] second P2 apply (idempotent no-op)');
  let reapplyOk = true;
  try { psql(MIG_P2); } catch { reapplyOk = false; }
  check('re-apply raises no error', reapplyOk);
  check('integrations row count unchanged after re-apply', Number((await q('SELECT count(*)::int c FROM integrations'))[0].c) === rowsAfter1);

  console.log(`\n${failures === 0 ? '✅ ALL P2 MIGRATION CHECKS PASSED' : `✗ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
