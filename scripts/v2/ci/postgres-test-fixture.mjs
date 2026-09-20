// Local-only disposable PostgreSQL. Missing Docker is a failure, never a skip.
// Credentials/certificates are generated per run, mounted read-only, then removed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const docker = args => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
}).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function disposablePostgres() {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-migration-test-'));
  const password = randomBytes(24).toString('hex');
  let id;
  const clients = new Set();
  const teardown = () => {
    if (id) {
      docker(['rm', '--force', id]);
      id = undefined;
    }
    rmSync(directory, { recursive: true, force: true });
  };
  const interrupt = () => { teardown(); process.exit(1); };
  process.once('exit', teardown);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    writeFileSync(join(directory, 'password'), password, { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.crt'),
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
    { stdio: 'ignore' });
    chmodSync(join(directory, 'server.key'), 0o600);
    const ca = readFileSync(join(directory, 'server.crt'), 'utf8');
    id = docker(['run', '--detach', '--rm', '--pull=missing',
      '--tmpfs', '/var/lib/postgresql/data', '--publish', '127.0.0.1::5432',
      '--mount', `type=bind,src=${directory},dst=/test-input,readonly`,
      '--env', 'POSTGRES_PASSWORD_FILE=/test-input/password',
      '--env', 'POSTGRES_USER=awsops_admin', '--env', 'POSTGRES_DB=awsops',
      '--entrypoint', 'sh', 'postgres:17', '-c',
      'cp /test-input/server.* /tmp/ && chown postgres:postgres /tmp/server.* && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key']);
    const port = Number(docker(['port', id, '5432/tcp']).split(':').at(-1));
    const config = {
      host: '127.0.0.1', port, user: 'awsops_admin', password,
      ssl: { ca, rejectUnauthorized: true, servername: 'localhost' },
      connectionTimeoutMillis: 3000, statement_timeout: 30_000, lock_timeout: 5000,
    };
    const client = (database, overrides = {}) => {
      const connection = new pg.Client({ ...config, database, ...overrides });
      clients.add(connection);
      return connection;
    };
    let admin;
    for (let attempt = 0; attempt < 100; attempt++) {
      admin = client('postgres');
      try { await admin.connect(); break; } catch (error) {
        await admin.end().catch(() => {});
        clients.delete(admin);
        if (attempt === 99) throw error;
        await sleep(100);
      }
    }
    await admin.query('CREATE ROLE rds_iam');
    let databaseCounter = 0;
    return {
      config, ca, password, client,
      async database() {
        const name = `test_${++databaseCounter}`;
        await admin.query(`CREATE DATABASE ${name}`);
        return name;
      },
      async close() {
        await Promise.allSettled([...clients].map(connection => connection.end()));
        teardown();
        process.removeListener('exit', teardown);
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      },
    };
  } catch (error) {
    teardown();
    process.removeListener('exit', teardown);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    throw error;
  }
}

export async function waitForQuery(client, sql, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await client.query(sql);
    if (predicate(result.rows)) return;
    await sleep(25);
  }
  throw new Error('Timed out waiting for PostgreSQL state');
}
