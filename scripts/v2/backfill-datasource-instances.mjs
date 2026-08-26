#!/usr/bin/env node
// scripts/v2/backfill-datasource-instances.mjs
// One-time, idempotent backfill for the multi-instance datasource model (ADR-039 hub).
//
// The SQL migration (01KVB3MDTTSJ3WNTJ2DCPDWJS9_…_backfill.sql) creates `integrations` rows from the
// `datasource_schemas` CACHE. But a datasource configured in Secrets Manager that was NEVER introspected
// has no cache row, so SQL can't see it. This tool closes that gap: for each datasource-kind slug present
// in the integrations credential secret but lacking an `integrations` row, it creates the row
// (enabled=true; is_default when first of its kind) and copies the slug credential to the bigint id key.
// The plain `kind` key (the managed default mirror) is left intact.
//
//   node scripts/v2/backfill-datasource-instances.mjs [--dry-run]
//
// Credentials: --dsn / BACKFILL_DSN, else AURORA_SECRET_ARN+AURORA_ENDPOINT, else terraform output
// (mirrors migrate.mjs / backfill-v1.mjs). The DSN and secret VALUES are NEVER printed.
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import {
  SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const DATASOURCE_KINDS = ['prometheus', 'mimir', 'loki', 'tempo', 'clickhouse'];
const SECRET_NAME = process.env.INTEGRATIONS_SECRET_NAME || 'ops/awsops-v2/integrations/credentials';
const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const LOCK_KEY = 472941143; // distinct from migrate.mjs / backfill-v1.mjs
const die = (m) => { console.error(`\n✗ ${m}`); process.exit(1); };
const redactDsn = (d) => { try { const u = new URL(d); if (u.password) u.password = '***'; return u.toString(); } catch { return '***'; } };

function resolveDsn() {
  if (process.env.BACKFILL_DSN) return process.env.BACKFILL_DSN;
  const ep = process.env.AURORA_ENDPOINT;
  const arn = process.env.AURORA_SECRET_ARN;
  if (ep && arn) {
    const sec = JSON.parse(
      execFileSync('aws', ['secretsmanager', 'get-secret-value', '--secret-id', arn, '--query', 'SecretString', '--output', 'text'], { encoding: 'utf8' }),
    );
    return `postgres://${sec.username}:${encodeURIComponent(sec.password)}@${ep}:${sec.port || 5432}/${sec.dbname || 'awsops'}?sslmode=require`;
  }
  die('no DSN — set BACKFILL_DSN or AURORA_ENDPOINT+AURORA_SECRET_ARN');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sm = new SecretsManagerClient({ region: REGION });

  let map = {};
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    map = r.SecretString ? JSON.parse(r.SecretString) : {};
  } catch (e) {
    if (e?.name === 'ResourceNotFoundException') { console.log('no credentials secret yet — nothing to backfill'); return; }
    throw e;
  }
  // Datasource-kind slugs that have a stored credential (slug key, not an id key).
  const slugs = Object.keys(map).filter((k) => DATASOURCE_KINDS.includes(k));
  if (slugs.length === 0) { console.log('no datasource-kind credentials — nothing to backfill'); return; }

  const pool = new pg.Pool({ connectionString: resolveDsn(), max: 2 });
  console.log(`connected: ${redactDsn(resolveDsn())}`);
  const c = await pool.connect();
  let created = 0, mirrored = 0;
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    let secretDirty = false;
    for (const slug of slugs) {
      // Ensure an integrations row for this slug (idempotent). is_default only if no default of this kind.
      const ins = await c.query(
        `INSERT INTO integrations (name, kind, direction, capability, description, enabled, is_default)
         VALUES ($1, $1, 'egress', 'read', $1 || ' (migrated datasource)', true,
                 NOT EXISTS (SELECT 1 FROM integrations WHERE kind = $1 AND is_default))
         ON CONFLICT (name) DO NOTHING
         RETURNING id`,
        [slug],
      );
      const { rows } = await c.query('SELECT id FROM integrations WHERE name = $1', [slug]);
      const id = rows[0]?.id;
      if (ins.rowCount > 0) created++;
      // Copy the slug credential to the bigint id key if the id entry is missing (keep the kind mirror).
      if (id != null && map[String(id)] === undefined) {
        if (!dryRun) { map[String(id)] = map[slug]; secretDirty = true; }
        mirrored++;
      }
    }
    if (dryRun) { await c.query('ROLLBACK'); }
    else {
      if (secretDirty) await sm.send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(map) }));
      await c.query('COMMIT');
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}rows created: ${created}, id-credentials backfilled: ${mirrored}`);
}

main().catch((e) => die(e?.message || String(e)));
