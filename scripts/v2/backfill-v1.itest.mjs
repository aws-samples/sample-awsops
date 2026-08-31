#!/usr/bin/env node
// scripts/v2/backfill-v1.itest.mjs — end-to-end integration test for the
// v1→v2 Aurora backfill against a disposable PostgreSQL 17 container.
//
//   node scripts/v2/backfill-v1.itest.mjs
//
// Spins postgres:17 (sudo docker, random port bound 127.0.0.1, runtime-random
// password), loads terraform/foundation/data/schema.sql, builds a fixture
// data/ tree, runs the real backfill via --dsn, and asserts counts / fan-out /
// payload / idempotency / corrupt-handling / --only. Skips cleanly if docker is
// unreachable. Tears the container down on EXIT/SIGINT/SIGTERM.
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const SCHEMA = 'terraform/foundation/data/schema.sql';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) failures++; };

let CID = null;
function teardown() { if (CID) { try { execFileSync('sudo', ['docker', 'rm', '-f', CID], { stdio: 'ignore' }); } catch { /* best effort */ } CID = null; } }
process.on('exit', teardown);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { teardown(); process.exit(1); });

const docker = (args, opts = {}) => execFileSync('sudo', ['docker', ...args], { encoding: 'utf8', ...opts });

function buildFixture({ corrupt }) {
  const root = mkdtempSync(join(tmpdir(), 'bf-itest-'));
  const W = (p, o) => {
    mkdirSync(join(root, p.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(root, p), typeof o === 'string' ? o : JSON.stringify(o));
  };
  // inventory: multi-account + aws→aggregate + single-account root + .prev_ (skip)
  W('inventory/123456789012/2026-06-01.json', { date: '2026-06-01', timestamp: '2026-06-01T09:00:00Z', resources: { 'EC2 Instances': 2, 'S3 Buckets': 1 } });
  // Root date file on the SAME day as the account dir: must bucket under 'aggregate'
  // (NOT --account-id) so the cross-account aggregate can't clobber 123456789012's rows.
  W('inventory/2026-06-01.json', { date: '2026-06-01', timestamp: '2026-06-01T00:00:00Z', resources: { 'EC2 Instances': 99 } });
  W('inventory/aws/2026-06-02.json', { date: '2026-06-02', resources: { Total: 5 } });
  W('inventory/.prev_aws.json', { date: 'x', resources: {} });
  // cost
  W('cost/123456789012/2026-06-01.json', { date: '2026-06-01', timestamp: '2026-06-01T09:00:00Z', monthlyCost: [{ svc: 'EC2', cost: 10 }], dailyCost: [], serviceCost: [] });
  // alert: valid + summary (skip)
  W('alert-diagnosis/2026-06/inc-1.json', { incidentId: 'inc-1', timestamp: '2026-06-01T00:00:00Z', severity: 'critical', affectedServices: ['api'], affectedResources: ['i-1'], rootCause: 'rc', rootCauseCategory: 'cat', confidence: 'high', diagnosisMarkdown: '# md', investigationSources: [], processingTimeMs: 1200, alertCount: 1, labels: {} });
  W('alert-diagnosis/2026-06/summary.json', { month: '2026-06' });
  // scaling: valid + out-of-set (skip, NOT error)
  W('event-scaling/e-1.json', { eventId: 'e-1', name: 'Black Friday', eventStart: '2026-11-27T00:00:00Z', status: 'approved', createdBy: 'ops@x.com' });
  W('event-scaling/e-2.json', { eventId: 'e-2', name: 'Bad status', eventStart: '2026-11-27T00:00:00Z', status: 'bogus' });
  if (corrupt) W('event-scaling/bad.json', '{ this is not valid json');
  return root;
}

function runBackfill(dsn, fix, extra = []) {
  const r = spawnSync('node', ['scripts/v2/backfill-v1.mjs', '--data-dir', fix, '--dsn', dsn, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function main() {
  try { docker(['ps'], { stdio: 'ignore' }); } catch { console.log('SKIP: docker daemon not reachable — integration test skipped'); process.exit(0); }

  const PW = randomBytes(16).toString('hex');
  CID = docker(['run', '-d', '--rm', '-e', `POSTGRES_PASSWORD=${PW}`, '-e', 'POSTGRES_DB=awsops', '-p', '127.0.0.1::5432', 'postgres:17']).trim();
  const PORT = docker(['port', CID, '5432']).trim().split(':').pop().trim();
  const DSN = `postgresql://postgres:${PW}@127.0.0.1:${PORT}/awsops`;
  console.log(`container ${CID.slice(0, 12)} on 127.0.0.1:${PORT}`);

  // wait for readiness
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { docker(['exec', CID, 'pg_isready', '-U', 'postgres', '-d', 'awsops'], { stdio: 'ignore' }); ready = true; break; } catch { await sleep(1000); }
  }
  if (!ready) { console.log('✗ container never became ready'); process.exit(1); }

  // load the baseline schema (use the container's own psql 17 via stdin)
  execSync(`sudo docker exec -i ${CID} psql -U postgres -d awsops -v ON_ERROR_STOP=1 -q < ${SCHEMA}`, { stdio: ['pipe', 'ignore', 'inherit'] });

  const q = async (sql, params) => {
    const c = new pg.Client({ connectionString: DSN }); await c.connect();
    try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
  };
  const count = async (t) => Number((await q(`SELECT count(*)::int AS c FROM ${t}`))[0].c);

  const cleanFix = buildFixture({ corrupt: false });

  // (a) clean run #1 — full load
  console.log('\n[a] clean run #1');
  const r1 = runBackfill(DSN, cleanFix);
  check('exit 0', r1.code === 0);
  check('inventory_snapshots = 4 (123456789012×2 + aggregate×2)', (await count('inventory_snapshots')) === 4);
  check('  fan-out: 123456789012 has 2 rows (same-day root did NOT clobber)', (await count("inventory_snapshots WHERE account_id='123456789012'")) === 2);
  check('  multi-account root + aws → aggregate (2 rows)', (await count("inventory_snapshots WHERE account_id='aggregate'")) === 2);
  check('  no leak to default account (self=0)', (await count("inventory_snapshots WHERE account_id='self'")) === 0);
  check('cost_snapshots = 1', (await count('cost_snapshots')) === 1);
  check('alert_diagnosis = 1', (await count('alert_diagnosis')) === 1);
  check('event_scaling_plans = 1 (e-2 bogus skipped)', (await count('event_scaling_plans')) === 1);
  const costPayload = (await q('SELECT payload FROM cost_snapshots LIMIT 1'))[0].payload;
  check('cost payload spot-check (monthlyCost present)', Array.isArray(costPayload.monthlyCost) && costPayload.monthlyCost[0].svc === 'EC2');
  check('cost granularity = SNAPSHOT', (await q("SELECT granularity FROM cost_snapshots LIMIT 1"))[0].granularity === 'SNAPSHOT');
  check('alert fingerprint is NULL (fidelity gap)', (await q("SELECT fingerprint FROM alert_diagnosis"))[0].fingerprint === null);
  const alertPayload1 = JSON.stringify((await q("SELECT payload FROM alert_diagnosis WHERE incident_id='inc-1'"))[0].payload);

  // (a) clean run #2 — idempotency + insert-vs-update count semantics
  console.log('\n[a] clean run #2 (idempotency)');
  const r2 = runBackfill(DSN, cleanFix);
  check('exit 0', r2.code === 0);
  check('counts unchanged: inventory=4', (await count('inventory_snapshots')) === 4);
  check('counts unchanged: cost=1 alert=1 scaling=1', (await count('cost_snapshots')) === 1 && (await count('alert_diagnosis')) === 1 && (await count('event_scaling_plans')) === 1);
  check('2nd-run summary: cost updated=1 (not inserted)', /cost:.*inserted=0 updated=1/.test(r2.out));
  check('2nd-run summary: scaling updated=1 (not inserted)', /scaling:.*inserted=0 updated=1/.test(r2.out));
  check('2nd-run summary: alert conflict-skip=1 (not inserted)', /alert:.*inserted=0 .*conflict-skip=1/.test(r2.out));
  const alertPayload2 = JSON.stringify((await q("SELECT payload FROM alert_diagnosis WHERE incident_id='inc-1'"))[0].payload);
  check('alert payload unchanged on rerun (DO NOTHING)', alertPayload1 === alertPayload2);

  // (c) --only cost — only cost_snapshots touched
  console.log('\n[c] --only cost');
  const before = { inv: await count('inventory_snapshots'), alert: await count('alert_diagnosis'), scaling: await count('event_scaling_plans') };
  const r3 = runBackfill(DSN, cleanFix, ['--only', 'cost']);
  check('exit 0', r3.code === 0);
  check('only cost in output', /cost:/.test(r3.out) && !/inventory:/.test(r3.out));
  check('other tables untouched', (await count('inventory_snapshots')) === before.inv && (await count('alert_diagnosis')) === before.alert && (await count('event_scaling_plans')) === before.scaling);

  // (b) corrupt run — non-zero exit, good rows kept, corrupt not loaded
  console.log('\n[b] corrupt-fixture run');
  const corruptFix = buildFixture({ corrupt: true });
  const r4 = runBackfill(DSN, corruptFix);
  check('non-zero exit on corrupt file', r4.code !== 0);
  check('scaling errored=1 reported', /scaling:.*errored=1/.test(r4.out));
  check('scaling skipped=1 (e-2 bogus, not errored)', /scaling:.*skipped=1/.test(r4.out));
  check('good rows still present (scaling=1: e-1)', (await count('event_scaling_plans')) === 1);
  check('corrupt produced no row', (await count("event_scaling_plans WHERE plan_id='bad'")) === 0);

  console.log(`\n${failures === 0 ? '✅ ALL INTEGRATION CHECKS PASSED' : `✗ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
