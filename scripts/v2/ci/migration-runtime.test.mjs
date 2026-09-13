import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import * as runner from '../migrate.mjs';
import { databaseFailure } from '../migration-errors.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('importing the runner never exits the caller or starts CLI work', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'await import("./scripts/v2/migrate.mjs"); console.log("import-completed");'], {
    cwd: root,
    env: { PATH: process.env.PATH, DRY_RUN: '1', OFFLINE: '1' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'import-completed');
});

test('imports with an absent or unresolvable argv entry remain side-effect free', () => {
  for (const entry of [undefined, '/missing-entry.mjs']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `process.argv[1] = ${JSON.stringify(entry)}; await import("./scripts/v2/migrate.mjs"); console.log("import-completed");`], {
      cwd: root, env: { PATH: '/no-external-tools' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'import-completed');
  }
});

test('direct file and directory symlinks run status and reject incomplete runtime config', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-entry-test-'));
  try {
    symlinkSync(root, join(directory, 'repo'));
    symlinkSync(join(root, 'scripts/v2/migrate.mjs'), join(directory, 'migrate.mjs'));
    for (const entry of [join(directory, 'migrate.mjs'), join(directory, 'repo/scripts/v2/migrate.mjs')]) {
      for (const args of [['--status'], []]) {
        const result = spawnSync(process.execPath, [entry, ...args], {
          env: { PATH: '/no-external-tools', AURORA_SECRET_ARN: 'incomplete' },
          encoding: 'utf8', timeout: 10_000,
        });
        assert.equal(result.status, args.length ? 0 : 1, result.stderr);
        if (args.length) assert.match(result.stdout, /migration files \(\d+\):/);
        else assert.match(result.stderr, /SQL_READER_SYNC_MODE/);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const [name, args, env, expected] of [
  ['status', ['--status'], {}, /app version:.*\nmigration files \(\d+\):/],
  ['offline preview', [], { DRY_RUN: '1', OFFLINE: '1' }, /migrations dir:.*\nfiles \(\d+\):/],
]) {
  test(`${name} works without credentials or Terraform`, () => {
    const result = spawnSync(process.execPath, ['scripts/v2/migrate.mjs', ...args], {
      cwd: root,
      env: { PATH: '/no-external-tools', AURORA_SECRET_ARN: 'incomplete-config', ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, expected);
  });
}

const runtimeEnv = {
  AWS_REGION: 'ap-northeast-2',
  AURORA_ENDPOINT: 'cluster.example.rds.amazonaws.com',
  AURORA_DATABASE: 'awsops',
  AURORA_SECRET_ARN: 'master-secret',
  SQL_READER_SYNC_MODE: 'disabled',
};
const noTerraform = () => assert.fail('runtime credentials must not invoke Terraform');
const master = { username: 'awsops_admin', password: 'test-only-master-password' };

test('runtime credentials use only the selected secret and verify the bundled CA and hostname', async () => {
  const config = await runner.loadCredentials(runtimeEnv, {
    terraformOutput: noTerraform,
    readSecret: async arn => {
      assert.equal(arn, 'master-secret');
      return { ...master, host: 'untrusted-secret-host', dbname: 'untrusted-db' };
    },
  });
  assert.equal(config.host, 'cluster.example.rds.amazonaws.com');
  assert.equal(config.database, 'awsops');
  assert.equal(config.user, master.username);
  assert.equal(config.password, master.password);
  assert.equal(config.port, 5432);
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.servername, runtimeEnv.AURORA_ENDPOINT);
  assert.equal(config.ssl.ca, readFileSync(new URL('../eks/rds-ca-bundle.pem', import.meta.url), 'utf8'));
  assert.equal(config.ssl.checkServerIdentity, undefined);
});

test('runtime rejects unsupported database names before reading credentials', async () => {
  await assert.rejects(runner.loadCredentials({ ...runtimeEnv, AURORA_DATABASE: 'other_database' }, {
    terraformOutput: noTerraform,
    readSecret: () => assert.fail('unsupported database must fail before secret lookup'),
  }), /requires database awsops/);
});

test('migration credentials require the master identity used by the immutable SQL', async () => {
  for (const username of ['migration_admin', 'awsops_sql_reader', 'awsops_admin ']) {
    await assert.rejects(runner.loadCredentials(runtimeEnv, {
      terraformOutput: noTerraform, readSecret: async () => ({ ...master, username }),
    }), /requires master username awsops_admin/);
  }
});

test('legacy CLI credentials still resolve Terraform outputs and default database', async () => {
  const config = await runner.loadCredentials({}, {
    terraformOutput: key => {
      const outputs = { aurora_secret_arn: 'cli-master', aurora_endpoint: 'cli.example.rds.amazonaws.com' };
      assert.ok(key in outputs);
      return outputs[key];
    },
    readSecret: async arn => {
      assert.equal(arn, 'cli-master');
      return master;
    },
  });
  assert.equal(config.host, 'cli.example.rds.amazonaws.com');
  assert.equal(config.database, 'awsops');
  assert.equal(config.ssl.rejectUnauthorized, true);
});

for (const key of ['AWS_REGION', 'AURORA_ENDPOINT', 'AURORA_DATABASE', 'AURORA_SECRET_ARN']) {
  test(`incomplete runtime config fails before external work: ${key}`, async () => {
    await assert.rejects(runner.loadCredentials({ ...runtimeEnv, [key]: '' }, {
      terraformOutput: noTerraform,
      readSecret: () => assert.fail('incomplete config must not read a secret'),
    }), new RegExp(key));
  });
}

for (const host of ['/tmp/postgresql', 'postgresql://localhost', 'localhost:5432', 'host name', 'host\0name']) {
  test(`non-hostname endpoints cannot bypass PostgreSQL TLS: ${JSON.stringify(host)}`, async () => {
    await assert.rejects(runner.loadCredentials({ ...runtimeEnv, AURORA_ENDPOINT: host }, {
      terraformOutput: noTerraform,
      readSecret: async () => master,
    }), /endpoint|hostname/i);
  });
}

for (const secret of [null, [], {}, { username: 'admin' }, { username: 1, password: 'secret' },
  { username: 'admin', password: '' }, { username: 'admin', password: 1 }]) {
  test(`malformed master credentials fail closed: ${JSON.stringify(secret)}`, async () => {
    await assert.rejects(runner.loadCredentials(runtimeEnv, {
      terraformOutput: noTerraform, readSecret: async () => secret,
    }), /username.*password/);
  });
}

// The SDK transport is the only fake: exercise real command serialization and
// response decoding without an AWS endpoint, credentials file, or network.
function secretClient(payload, statusCode = 200) {
  return new SecretsManagerClient({
    region: 'ap-northeast-2',
    credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test' },
    maxAttempts: 1,
    requestHandler: { handle: async request => {
      assert.equal(JSON.parse(request.body).SecretId, 'selected-secret');
      assert.equal(request.headers['x-amz-target'], 'secretsmanager.GetSecretValue');
      return { response: { statusCode, headers: { 'content-type': 'application/x-amz-json-1.1' },
        body: Buffer.from(JSON.stringify(payload)) } };
    } },
  });
}

test('Secrets Manager JSON remains in memory and is fetched by explicit SecretId', async () => {
  const client = secretClient({ SecretString: JSON.stringify(master) });
  try {
    assert.deepEqual(await runner.readJsonSecret('selected-secret', client), master);
  } finally { client.destroy(); }
});

for (const payload of [
  { SecretString: '{"password":"do-not-echo-secret"' },
  { SecretBinary: Buffer.from('do-not-echo-secret').toString('base64') },
  { SecretString: '["do-not-echo-secret"]' },
  { SecretString: 'null' },
]) {
  test('invalid secret responses are rejected without exposing response contents', async () => {
    const client = secretClient(payload);
    try {
      await assert.rejects(runner.readJsonSecret('selected-secret', client), error => {
        assert.match(error.message, /Secret.*JSON|secret.*JSON/i);
        assert.doesNotMatch(error.message, /do-not-echo-secret/);
        return true;
      });
    } finally { client.destroy(); }
  });
}

test('Secrets Manager failures do not expose remote error messages', async () => {
  const client = secretClient({ __type: 'AccessDeniedException', message: 'do-not-echo-secret' }, 400);
  try {
    await assert.rejects(runner.readJsonSecret('selected-secret', client), error => {
      assert.match(error.message, /Secret.*read|read.*secret/i);
      assert.match(error.message, /GetSecretValue/);
      assert.match(error.message, /AccessDeniedException/);
      assert.match(error.message, /HTTP=400/);
      assert.doesNotMatch(error.message, /do-not-echo-secret/);
      return true;
    });
  } finally { client.destroy(); }
});

test('unknown SDK names and malformed status cannot become diagnostic text', async () => {
  for (const status of ['do-not-echo-secret', 400.5, 999]) {
    await assert.rejects(runner.readJsonSecret('do-not-echo-secret', {
      send: async () => { throw { name: 'do-not-echo-secret', code: 'do-not-echo-secret',
        message: 'do-not-echo-secret', $metadata: { httpStatusCode: status } }; },
    }), error => {
      assert.match(error.message, /GetSecretValue/);
      assert.doesNotMatch(error.message, /do-not-echo-secret|HTTP=/);
      return true;
    });
  }
});

test('SDK-decoded unknown error types are not echoed even when the HTTP status is valid', async () => {
  const client = secretClient({ __type: 'do-not-echo-secret', message: 'do-not-echo-secret' }, 500);
  try {
    await assert.rejects(runner.readJsonSecret('selected-secret', client), error => {
      assert.match(error.message, /HTTP=500/);
      assert.doesNotMatch(error.message, /do-not-echo-secret/);
      return true;
    });
  } finally { client.destroy(); }
});

test('database diagnostics reject arbitrary SQLSTATE text and non-Error throws', () => {
  for (const error of ['do-not-echo-secret', null, { name: 'do-not-echo-secret',
    code: '42501\ndo-not-echo-secret', message: 'do-not-echo-secret' }]) {
    const safe = databaseFailure('Connect to Aurora failed', error);
    assert.match(safe.message, /Connect to Aurora failed/);
    assert.doesNotMatch(safe.message, /do-not-echo-secret|SQLSTATE=/);
  }
  assert.match(databaseFailure('Connect to Aurora failed', {
    name: 'do-not-echo-secret', code: 'ERR_TLS_CERT_ALTNAME_INVALID',
  }).message, /ERR_TLS_CERT_ALTNAME_INVALID/);
});

test('filesystem errors retain safe errno without paths or SQLSTATE misclassification', () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EPIPE', 'EBUSY']) {
    const error = databaseFailure('Read frozen baseline failed', {
      code, message: 'do-not-echo-secret', path: '/do-not-echo-secret',
    });
    assert.ok(error.message.includes(code), error.message);
    assert.doesNotMatch(error.message, /SQLSTATE|do-not-echo-secret/);
  }
});

test('only reviewed SQL failures expose validated identifiers and P0001 guidance', () => {
  const raw = { code: 'P0001', severity: 'ERROR', schema: 'public', table: 'report_schedules',
    column: 'user_sub', constraint: 'uq_schedule_one_active', message: 'repair\nnext\u001b[31m',
    detail: 'do-not-echo-secret', hint: 'do-not-echo-secret', where: 'do-not-echo-secret' };
  const safe = databaseFailure('Migration failed', raw, { migrationSql: true }).message;
  for (const field of ['severity', 'schema', 'table', 'column', 'constraint']) {
    assert.ok(safe.includes(`${field}=${raw[field]}`), safe);
    for (const invalid of ['do-not-echo-secret\n', 'x'.repeat(64), {}, 'bad name']) {
      assert.doesNotMatch(databaseFailure('Migration failed', { ...raw, [field]: invalid },
        { migrationSql: true }).message, new RegExp(`${field}=`));
    }
  }
  assert.match(safe, /repair\\nnext\\u001b/);
  assert.doesNotMatch(safe, /[\r\n\u001b]|do-not-echo-secret/);
  assert.ok(databaseFailure('Migration failed', { ...raw, message: 'x'.repeat(100_000) },
    { migrationSql: true }).message.length < 5000);
  for (const purpose of ['Connect to Aurora failed', 'sql-reader: password synchronization failed']) {
    const hidden = databaseFailure(purpose, raw).message;
    assert.match(hidden, /SQLSTATE=P0001/);
    assert.doesNotMatch(hidden, /repair|severity=|schema=|table=|column=|constraint=/);
  }
});

// Child processes reproduce EventEmitter's uncaught-error exit without crashing
// the test harness. Only the socket/secret transport is replaced.
for (const phase of ['connect', 'idle-secret', 'reader-event', 'reader-reject',
  'unlock-event', 'end-event', 'unlock-reject', 'end-reject']) {
  test(`connection lifecycle fails closed without raw output: ${phase}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'awsops-lifecycle-'));
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { EventEmitter } from 'node:events';
        import { setImmediate } from 'node:timers/promises';
        import pg from ${JSON.stringify(import.meta.resolve('pg'))};
        import { migrateDatabase } from './scripts/v2/migrate.mjs';
        const phase = ${JSON.stringify(phase)};
        const raw = () => Object.assign(new Error('do-not-echo-secret'), {
          code: 'P0001', detail: 'do-not-echo-secret', where: 'ALTER ROLE PASSWORD do-not-echo-secret',
          schema: 'do_not_echo_secret', severity: 'ERROR',
        });
        class Client extends EventEmitter {
          escapeLiteral(value) { return pg.escapeLiteral(value); }
          fail() {
            return new Promise(resolve => setTimeout(() => {
              this.emit('error', raw()); resolve();
            }, 0));
          }
          async connect() {
            await setImmediate();
            this.emit('notice', raw());
            if (phase === 'connect') await this.fail();
          }
          async query(sql) {
            if (sql.startsWith('ALTER ROLE')) {
              this.emit('notice', raw());
              if (phase === 'reader-event') await this.fail();
              if (phase === 'reader-reject') throw raw();
            }
            if (sql.includes('pg_advisory_unlock')) {
              await setImmediate();
              this.emit('notice', raw());
              if (phase === 'unlock-event') await this.fail();
              if (phase === 'unlock-reject') throw raw();
            }
            if (sql.includes('information_schema.columns')) return { rows: [
              { column_name: 'version', data_type: 'text' },
              { column_name: 'checksum', data_type: 'text' },
            ] };
            if (sql.includes('FROM pg_roles')) return { rows: [
              { rolsuper: false, rolreplication: false, rolbypassrls: false },
            ] };
            return { rows: [] };
          }
          async end() {
            await setImmediate();
            this.emit('notice', raw());
            if (phase === 'end-event') await this.fail();
            if (phase === 'end-reject') throw raw();
          }
        }
        const client = new Client();
        const watchdog = setTimeout(() => { console.error('lifecycle did not settle'); process.exit(2); }, 2000);
        try {
          await migrateDatabase(client, {
            migrationDir: ${JSON.stringify(directory)},
            env: { SQL_READER_SYNC_MODE: 'secret', SQL_READER_SECRET_ARN: 'reader' },
            readSecret: async () => {
              await setImmediate();
              client.emit('notice', raw());
              if (phase === 'idle-secret') {
                await client.fail();
                return new Promise(() => {});
              }
              return { username: 'awsops_sql_reader', password: 'local-only' };
            },
          });
          console.log('RUN SUCCEEDED');
        } catch (error) { console.error(error.message); process.exitCode = 1; }
        finally { clearTimeout(watchdog); }
      `], { cwd: root, env: { PATH: '/no-external-tools' }, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Aurora connection error|advisory unlock|connection cleanup|password synchronization failed/);
      assert.match(result.stderr, /SQLSTATE=P0001/);
      assert.doesNotMatch(result.stdout + result.stderr,
        /do.not.echo.secret|RUN SUCCEEDED|up to date|applied \d+ migration|lifecycle did not settle/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('master secret failures identify their purpose and recognized SDK code safely', async () => {
  await assert.rejects(runner.loadCredentials(runtimeEnv, {
    terraformOutput: noTerraform,
    readSecret: async () => { throw { name: 'do-not-echo-secret', code: 'ResourceNotFoundException',
      message: 'do-not-echo-secret', $metadata: { httpStatusCode: 400 } }; },
  }), error => {
    assert.match(error.message, /Aurora master.*GetSecretValue/);
    assert.match(error.message, /ResourceNotFoundException.*HTTP=400/);
    assert.doesNotMatch(error.message, /do-not-echo-secret/);
    return true;
  });
});

test('Terraform failures expose only a safe category, output purpose, and exit status', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-tf-error-'));
  try {
    for (const [stderr, category] of [
      ['Backend initialization required', 'backend-initialization'],
      ['Output "aurora_secret_arn" not found', 'missing-output'],
      ['do-not-echo-secret', 'command-failed'],
    ]) {
      writeFileSync(join(directory, 'terraform'),
        `#!/bin/sh\nprintf '%s\\n' '${stderr} do-not-echo-secret' >&2\nexit 7\n`, { mode: 0o700 });
      const result = spawnSync(process.execPath, ['scripts/v2/migrate.mjs'], {
        cwd: root, env: { PATH: directory }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Terraform output aurora_secret_arn/);
      assert.ok(result.stderr.includes(`category=${category}`), result.stderr);
      assert.match(result.stderr, /exit=7/);
      assert.doesNotMatch(result.stderr + result.stdout, /do-not-echo-secret/);
    }
    const missing = spawnSync(process.execPath, ['scripts/v2/migrate.mjs'], {
      cwd: root, env: { PATH: '/no-external-tools' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /category=executable-unavailable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
