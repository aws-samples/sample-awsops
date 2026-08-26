#!/usr/bin/env node
// scripts/v2/migrations-readwrite-slack.itest.mjs — idempotency + correctness for the Slack
// governed-write action_catalog seed (RW-slice T1, ADR-040/041) against a disposable PostgreSQL 17.
//
//   node scripts/v2/migrations-readwrite-slack.itest.mjs
//
// Spins postgres:17 (sudo docker, random port, runtime-random password), loads the baseline schema.sql
// (which creates action_catalog + its baseline seeds), applies the Slack migration TWICE and asserts the
// 'slack.post_message' row exists with the right governance fields (executor lambda, target external:slack,
// 4-eyes, enabled=false, preview dry-run) and the second apply is a clean no-op. Skips if docker unreachable.
import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const SCHEMA = 'terraform/foundation/data/schema.sql';
const MIGRATION = 'terraform/foundation/migrations/01KV2FMC1AJN72SBHY8QV7P5AB_integrations_write_slack.sql';
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

  // baseline schema (creates action_catalog + baseline seeds)
  psql(SCHEMA);
  const catBefore = await count('action_catalog');

  // ── apply #1 ──
  console.log('\n[1] first migration apply');
  psql(MIGRATION);
  const row = (await q("SELECT executor_type, target_resource_type, approval_mode, enabled, required_inputs, dry_run_contract, assume_role_ref FROM action_catalog WHERE name='slack.post_message'"))[0];
  check('slack.post_message row exists', !!row);
  check("executor_type = 'lambda'", row?.executor_type === 'lambda');
  check("target_resource_type = 'external:slack' (DATA-write marker)", row?.target_resource_type === 'external:slack');
  check("approval_mode = 'four_eyes'", row?.approval_mode === 'four_eyes');
  check('enabled = false (do-not-enable)', row?.enabled === false);
  check('required_inputs = [channel, text]', JSON.stringify(row?.required_inputs) === JSON.stringify(['channel', 'text']));
  check("dry_run_contract.mode = 'preview'", row?.dry_run_contract?.mode === 'preview');
  check('assume_role_ref = integrations-slack-write (no-AWS-mutation role)', row?.assume_role_ref === 'integrations-slack-write');
  check('exactly 1 new catalog row added', (await count('action_catalog')) === catBefore + 1);

  // ── apply #2 (idempotency) ──
  console.log('\n[2] second migration apply (idempotent no-op)');
  let reapplyOk = true;
  try { psql(MIGRATION); } catch { reapplyOk = false; }
  check('re-apply raises no error', reapplyOk);
  check('action_catalog count unchanged after re-apply', (await count('action_catalog')) === catBefore + 1);

  console.log(`\n${failures === 0 ? '✅ ALL MIGRATION CHECKS PASSED' : `✗ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
