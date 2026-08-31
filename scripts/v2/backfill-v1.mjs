#!/usr/bin/env node
// scripts/v2/backfill-v1.mjs
// One-time, idempotent backfill of v1 high-value history (data/*.json) into the
// v2 Aurora ADR-030 app-state tables. Tool only — reads a *copy* of v1's data/.
//
//   node scripts/v2/backfill-v1.mjs --data-dir <path> [--only a,b] [--account-id <id>]
//                                   [--alert-source <s>] [--dry-run]
//
// Sources → tables:
//   inventory  data/inventory/[<acct>/]<YYYY-MM-DD>.json   → inventory_snapshots
//   cost       data/cost/[<acct>/]<YYYY-MM-DD>.json         → cost_snapshots
//   alert      data/alert-diagnosis/<YYYY-MM>/<id>.json     → alert_diagnosis
//   scaling    data/event-scaling/<id>.json                 → event_scaling_plans
//
// Credentials (live runs): --dsn / BACKFILL_DSN → AURORA_SECRET_ARN+AURORA_ENDPOINT
//   → `terraform -chdir=terraform/foundation output -raw …` (mirrors migrate.mjs).
// The DSN/credentials are NEVER printed. --dry-run parses + counts with NO DB connection.
//
// Spec:  docs/superpowers/specs/2026-06-12-v1-to-v2-aurora-backfill-design.md
// Mapping is in backfill-core.mjs (derived from src/lib/db/*-writer.ts).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import * as core from './backfill-core.mjs';

// Fixed 64-bit advisory-lock key — DISTINCT from migrate.mjs's 4729411 so a
// backfill and a migration never block each other.
const LOCK_KEY = 472941142;

export const SOURCES = ['inventory', 'cost', 'alert', 'scaling'];

const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

function printHelp() {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n')
    .filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
}

/** Hide the password in any DSN before it can reach a log line. */
export function redactDsn(dsn) {
  if (!dsn) return dsn;
  // URL-parse so a password containing '@' is fully masked (the naive regex
  // stopped at the first '@' and leaked the remainder — panel codex MAJOR).
  try { const u = new URL(dsn); if (u.password) u.password = '***'; return u.toString(); }
  catch { return dsn.replace(/(:\/\/[^:/@]+:)[^@]*(@)/, '$1***$2'); }
}

export function parseArgs(argv) {
  const a = {
    dataDir: null, only: [...SOURCES], accountId: 'self', alertSource: 'unknown',
    dryRun: process.env.DRY_RUN === '1', dsn: process.env.BACKFILL_DSN || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--help' || x === '-h') { printHelp(); process.exit(0); }
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--data-dir') a.dataDir = argv[++i];
    else if (x === '--only') a.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (x === '--account-id') a.accountId = argv[++i];
    else if (x === '--alert-source') a.alertSource = argv[++i];
    else if (x === '--dsn') a.dsn = argv[++i];
    else die(`unknown arg: ${x} (try --help)`);
  }
  if (!a.dataDir) die('--data-dir <path> is required');
  if (!existsSync(a.dataDir)) die(`--data-dir not found: ${a.dataDir}`);
  const bad = a.only.filter((s) => !SOURCES.includes(s));
  if (bad.length) die(`--only: unknown source(s): ${bad.join(',')} (valid: ${SOURCES.join(',')})`);
  return a;
}

// --- filesystem helpers ----------------------------------------------------

const listEntries = (dir) => readdirSync(dir, { withFileTypes: true })
  .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Wrap a mapper call so a parse/map throw becomes an {error} work item. */
function tryMap(file, fn) {
  try { return { file, result: fn() }; }
  catch (e) { return { file, result: { error: e instanceof Error ? e.message : String(e) } }; }
}

// --- per-source gatherers (parse → core mapper) ----------------------------

export function gatherInventory(dataDir, defaultAccount) {
  const dir = join(dataDir, 'inventory');
  if (!existsSync(dir)) return [];
  const { accountDirs, rootDateFiles } = core.partitionAccountDir(listEntries(dir));
  const jobs = [];
  for (const acct of accountDirs) {
    const adir = join(dir, acct);
    for (const e of listEntries(adir)) if (!e.isDirectory && core.isDateFile(e.name)) jobs.push({ file: join(adir, e.name), account: acct });
  }
  // In a multi-account layout, root date files are the cross-account AGGREGATE —
  // mapping them to --account-id would let the aggregate clobber a real account's
  // rows (panel codex MAJOR). Bucket them under 'aggregate'; only a pure root-only
  // (single-account) layout uses --account-id.
  const rootAccount = accountDirs.length ? 'aggregate' : defaultAccount;
  for (const f of rootDateFiles) jobs.push({ file: join(dir, f), account: rootAccount });
  return jobs.map((j) => tryMap(j.file, () => core.mapInventory(readJson(j.file), j.account)));
}

export function gatherCost(dataDir, defaultAccount) {
  const dir = join(dataDir, 'cost');
  if (!existsSync(dir)) return [];
  const { accountDirs, rootDateFiles } = core.partitionAccountDir(listEntries(dir));
  const jobs = [];
  for (const acct of accountDirs) {
    const adir = join(dir, acct);
    for (const e of listEntries(adir)) if (!e.isDirectory && core.isDateFile(e.name)) jobs.push({ file: join(adir, e.name), account: acct });
  }
  const rootAccount = accountDirs.length ? 'aggregate' : defaultAccount; // see gatherInventory
  for (const f of rootDateFiles) jobs.push({ file: join(dir, f), account: rootAccount });
  return jobs.map((j) => tryMap(j.file, () => core.mapCost(readJson(j.file), j.account)));
}

export function gatherAlert(dataDir, source) {
  const dir = join(dataDir, 'alert-diagnosis');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of listEntries(dir)) {
    if (!e.isDirectory || !core.isMonthDir(e.name)) continue;
    const mdir = join(dir, e.name);
    for (const f of listEntries(mdir)) {
      if (f.isDirectory || !core.isAlertRecordFile(f.name)) continue;
      const file = join(mdir, f.name);
      out.push(tryMap(file, () => core.mapAlert(readJson(file), { source })));
    }
  }
  return out;
}

export function gatherScaling(dataDir) {
  const dir = join(dataDir, 'event-scaling');
  if (!existsSync(dir)) return [];
  return listEntries(dir)
    .filter((e) => !e.isDirectory && e.name.endsWith('.json'))
    .map((e) => { const file = join(dir, e.name); return tryMap(file, () => core.mapScaling(readJson(file))); });
}

export function gatherAll(args) {
  const g = {};
  if (args.only.includes('inventory')) g.inventory = gatherInventory(args.dataDir, args.accountId);
  if (args.only.includes('cost')) g.cost = gatherCost(args.dataDir, args.accountId);
  if (args.only.includes('alert')) g.alert = gatherAlert(args.dataDir, args.alertSource);
  if (args.only.includes('scaling')) g.scaling = gatherScaling(args.dataDir);
  return g;
}

/** Count what a source would write/skip/error (no DB). */
export function summarizeDryRun(source, items) {
  let wouldWrite = 0, skipped = 0, errored = 0;
  for (const { result } of items) {
    if (result.error) errored++;
    else if (result.skip) skipped++;
    else if (source === 'inventory') wouldWrite += result.rows.length;
    else wouldWrite += 1;
  }
  return { files: items.length, wouldWrite, skipped, errored };
}

function sampleLine(source, r) {
  if (source === 'inventory') return `${r.account} ${r.capturedAt} (${r.rows.length} rows)`;
  if (source === 'cost') return `${r.account} ${r.periodStart} ${r.granularity}`;
  if (source === 'alert') return `${r.incidentId} ${r.severity} ${r.occurredAt}`;
  return `${r.planId} ${r.status} ${r.eventStartAt}`;
}

// --- DB connection (creds never logged) ------------------------------------

function sslOption() {
  // Full verification when an operator supplies the RDS CA bundle; otherwise
  // match migrate.mjs (accepts any cert — acceptable for a one-time operator tool).
  if (process.env.PGSSLROOTCERT) return { ssl: { ca: readFileSync(process.env.PGSSLROOTCERT, 'utf8') } };
  return { ssl: { rejectUnauthorized: false } };
}

/** Resolve a pg.Client config + a credential-free display string. */
export function connConfig(args, env = process.env) {
  // --dsn governs its own TLS via the connection string's sslmode (so a local
  // non-SSL test container works, and an Aurora DSN can opt in with sslmode=require).
  if (args.dsn) return { config: { connectionString: args.dsn }, display: redactDsn(args.dsn) };
  const region = env.AWS_REGION || 'ap-northeast-2';
  // execFileSync with arg arrays (no shell) — env/terraform values can't inject a command.
  const tf = (o) => execFileSync('terraform', ['-chdir=terraform/foundation', 'output', '-raw', o], { encoding: 'utf8' }).trim();
  const secretArn = env.AURORA_SECRET_ARN || tf('aurora_secret_arn');
  const endpoint = env.AURORA_ENDPOINT || tf('aurora_endpoint');
  const database = env.AURORA_DATABASE || 'awsops';
  const secret = JSON.parse(execFileSync('aws',
    ['secretsmanager', 'get-secret-value', '--region', region, '--secret-id', secretArn, '--query', 'SecretString', '--output', 'text'],
    { encoding: 'utf8' }));
  return {
    config: { host: endpoint, user: secret.username, password: secret.password, database, port: 5432, ...sslOption() },
    display: `${endpoint}/${database}`,
  };
}

// --- per-source SQL (mirrors spec §5; idempotent) ---------------------------

async function execOne(client, source, r, c) {
  if (source === 'inventory') {
    const del = await client.query(
      'DELETE FROM inventory_snapshots WHERE account_id=$1 AND captured_at>=$2 AND captured_at<$3',
      [r.account, r.dayStartISO, r.dayNextISO],
    );
    c.deleted += del.rowCount;
    for (const row of r.rows) {
      await client.query(
        'INSERT INTO inventory_snapshots (account_id, captured_at, resource_type, resource_count, payload) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [row.account, row.capturedAt, row.resourceType, row.resourceCount, row.payload],
      );
      c.inserted++;
    }
  } else if (source === 'cost') {
    const res = await client.query(
      `INSERT INTO cost_snapshots (account_id, period_start, period_end, granularity, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (account_id, period_start, period_end, granularity) DO UPDATE SET payload=EXCLUDED.payload
       RETURNING (xmax = 0) AS inserted`,
      [r.account, r.periodStart, r.periodEnd, r.granularity, r.payload],
    );
    res.rows[0].inserted ? c.inserted++ : c.updated++;
  } else if (source === 'alert') {
    const res = await client.query(
      `INSERT INTO alert_diagnosis (incident_id, occurred_at, severity, source, services, resources, fingerprint, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (incident_id) DO NOTHING
       RETURNING incident_id`,
      [r.incidentId, r.occurredAt, r.severity, r.source, r.services, r.resources, r.fingerprint, r.payload],
    );
    res.rowCount ? c.inserted++ : c.conflictSkip++;
  } else { // scaling
    const res = await client.query(
      `INSERT INTO event_scaling_plans (plan_id, event_name, event_start_at, event_end_at, status, owner_email, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (plan_id) DO UPDATE SET
         event_name=EXCLUDED.event_name, event_start_at=EXCLUDED.event_start_at, event_end_at=EXCLUDED.event_end_at,
         status=EXCLUDED.status, owner_email=EXCLUDED.owner_email, payload=EXCLUDED.payload
       RETURNING (xmax = 0) AS inserted`,
      [r.planId, r.eventName, r.eventStartAt, r.eventEndAt, r.status, r.ownerEmail, r.payload],
    );
    res.rows[0].inserted ? c.inserted++ : c.updated++;
  }
}

/** Write one source; each file in its own transaction (skip-and-report on error). */
export async function writeSource(client, source, items) {
  const c = { scanned: items.length, skipped: 0, inserted: 0, updated: 0, conflictSkip: 0, deleted: 0, errored: 0, errors: [] };
  for (const { file, result } of items) {
    if (result.error) { c.errored++; c.errors.push(`${file}: ${result.error}`); continue; }
    if (result.skip) { c.skipped++; continue; }
    try {
      await client.query('BEGIN');
      await execOne(client, source, result, c);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      c.errored++; c.errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return c;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gathered = gatherAll(args);

  if (args.dryRun) {
    console.log(`DRY-RUN (no DB) — data-dir=${args.dataDir} account=${args.accountId} alert-source=${args.alertSource}`);
    let totalErr = 0;
    for (const s of args.only) {
      const sum = summarizeDryRun(s, gathered[s]);
      totalErr += sum.errored;
      console.log(`  ${s}: scanned=${sum.files} would-write=${sum.wouldWrite} skipped=${sum.skipped} errored=${sum.errored}`);
      const sample = gathered[s].find((i) => !i.result.error && !i.result.skip);
      if (sample) console.log(`    sample: ${sampleLine(s, sample.result)}`);
    }
    process.exit(totalErr > 0 ? 1 : 0);
  }

  // Live write path.
  const { config, display } = connConfig(args);
  const client = new pg.Client({ ...config, statement_timeout: 300_000 });
  await client.connect();
  let locked = false, totalErr = 0;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;
    console.log(`backfill → ${display} | account=${args.accountId} alert-source=${args.alertSource}`);
    for (const s of args.only) {
      const c = await writeSource(client, s, gathered[s]);
      totalErr += c.errored;
      console.log(`  ${s}: scanned=${c.scanned} inserted=${c.inserted} updated=${c.updated} conflict-skip=${c.conflictSkip} skipped=${c.skipped} deleted=${c.deleted} errored=${c.errored}`);
      for (const e of c.errors.slice(0, 5)) console.log(`      ! ${e}`);
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
  console.log(totalErr > 0 ? `\n■ completed WITH ${totalErr} errored file(s)` : '\n✅ completed, no errors');
  process.exit(totalErr > 0 ? 1 : 0);
}

// Only run when executed directly (not when imported by tests/itest).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => die(e instanceof Error ? e.message : String(e)));
}
