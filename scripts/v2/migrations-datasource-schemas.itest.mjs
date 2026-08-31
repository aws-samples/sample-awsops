#!/usr/bin/env node
// scripts/v2/migrations-datasource-schemas.itest.mjs — idempotency + upsert for the datasource_schemas
// migration against a disposable PostgreSQL 17 container. Standalone table (no schema.sql dependency).
//   node scripts/v2/migrations-datasource-schemas.itest.mjs
import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const MIG = 'terraform/foundation/migrations/01KV9GHENRHPGTX4KFMEH0ZFYT_datasource_schemas.sql';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) failures++; };
let CID = null;
function teardown() { if (CID) { try { execFileSync('sudo', ['docker', 'rm', '-f', CID], { stdio: 'ignore' }); } catch {} CID = null; } }
process.on('exit', teardown);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { teardown(); process.exit(1); });
const docker = (args, opts = {}) => execFileSync('sudo', ['docker', ...args], { encoding: 'utf8', ...opts });

async function main() {
  try { docker(['ps'], { stdio: 'ignore' }); } catch { console.log('SKIP: docker daemon not reachable'); process.exit(0); }
  const PW = randomBytes(16).toString('hex');
  CID = docker(['run', '-d', '--rm', '-e', `POSTGRES_PASSWORD=${PW}`, '-e', 'POSTGRES_DB=awsops', '-p', '127.0.0.1::5432', 'postgres:17']).trim();
  const PORT = docker(['port', CID, '5432']).trim().split(':').pop().trim();
  const DSN = `postgresql://postgres:${PW}@127.0.0.1:${PORT}/awsops`;
  let ready = false;
  for (let i = 0; i < 30; i++) { try { docker(['exec', CID, 'pg_isready', '-U', 'postgres', '-d', 'awsops'], { stdio: 'ignore' }); ready = true; break; } catch { await sleep(1000); } }
  if (!ready) { console.log('container not ready'); process.exit(1); }
  const psql = () => execSync(`sudo docker exec -i ${CID} psql -U postgres -d awsops -v ON_ERROR_STOP=1 -q < ${MIG}`, { stdio: ['pipe', 'ignore', 'inherit'] });
  const q = async (sql, params) => { const c = new pg.Client({ connectionString: DSN }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };

  psql(); psql();  // apply twice — idempotent (CREATE TABLE IF NOT EXISTS)
  check('table exists', Number((await q("SELECT count(*)::int c FROM information_schema.tables WHERE table_name='datasource_schemas'"))[0].c) === 1);
  check('pk is (account_id, slug)', (await q("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='datasource_schemas'::regclass AND i.indisprimary ORDER BY a.attname")).map(r=>r.attname).join(',') === 'account_id,slug');
  await q("INSERT INTO datasource_schemas(account_id,slug,kind,schema) VALUES('a','prometheus','prometheus','{\"metrics\":[\"up\"]}'::jsonb)");
  await q("INSERT INTO datasource_schemas(account_id,slug,kind,schema) VALUES('a','prometheus','prometheus','{\"metrics\":[\"up\",\"down\"]}'::jsonb) ON CONFLICT (account_id,slug) DO UPDATE SET schema=EXCLUDED.schema, fetched_at=now()");
  const rows = await q("SELECT schema->'metrics' m FROM datasource_schemas WHERE account_id='a' AND slug='prometheus'");
  check('upsert updated the row (1 row, 2 metrics)', rows.length === 1 && rows[0].m.length === 2);
  console.log(failures ? `\nFAIL (${failures})` : '\nOK'); process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
