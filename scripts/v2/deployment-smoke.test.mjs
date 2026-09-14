import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { smokeArgs } from './deployment-smoke.mjs';
// The required merge verifier enters through this file, so runtime checks cannot be skipped.
import './runtime-smoke.test.mjs';

test('smoke uses service Host/SNI and verified TLS via the CloudFront connection', () => {
  assert.deepEqual(smokeArgs('https://dev.example.com', 'd123.cloudfront.net'), [
    '-fsS', '--max-time', '30', '--connect-to',
    'dev.example.com:443:d123.cloudfront.net:443', 'https://dev.example.com/api/health',
  ]);
});

test('smoke refuses non-HTTPS, credentials, unexpected ports/paths and foreign destinations', () => {
  for (const url of ['http://dev.example.com', 'https://user@dev.example.com',
    'https://dev.example.com:8443', 'https://dev.example.com/path', 'https://dev.example.com?q=1']) {
    assert.throws(() => smokeArgs(url, 'd123.cloudfront.net'));
  }
  for (const destination of ['internal-alb.example.com', 'd123.cloudfront.net.evil.com', '-k']) {
    assert.throws(() => smokeArgs('https://dev.example.com', destination));
  }
});

// Synthetic credentials deliberately contain JSON/shell metacharacters. The only
// substituted boundary is curl; request files, permissions and cleanup are real.
const email = 'configured-demo@example.com';
const password = 'fixture-only-"\\\n$(false)-Password9';
const token = 'fixture-only.session.cookie';
const cookie = `# Netscape HTTP Cookie File\n#HttpOnly_dev.example.com\tFALSE\t/\tTRUE\t0\tawsops_token\t${token}\n`;
const configuration = {
  publicUrl: 'https://dev.example.com',
  cloudfrontDomain: 'd123.cloudfront.net',
  email,
  password,
};

async function scenario(t, {
  config = {}, loginStatus = '200', loginBody = '{"ok":true,"redirect":"/"}',
  dbStatus = '200', dbBody = '{"status":"ok","public_tables":42}',
  jar = cookie, failureAt, interruptAt, emptyDbOutput = false,
  runtimeOptions = {}, onRequest,
  accountsBody = '{"accounts":[{"accountId":"123456789012","isHost":true,"enabled":true}]}',
} = {}) {
  const moduleUrl = new URL('./authenticated-smoke.mjs', import.meta.url);
  assert.ok(existsSync(moduleUrl), 'authenticated smoke implementation is missing');
  const { authenticatedSmoke } = await import(moduleUrl);
  const tempRoot = mkdtempSync(join(tmpdir(), 'authenticated-smoke-test-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const calls = [];
  const runCurl = async (file, args, options) => {
    const output = args[args.indexOf('--output') + 1];
    const jarPath = args[args.indexOf(calls.length === 0 ? '--cookie-jar' : '--cookie') + 1];
    const bodyArg = args[args.indexOf('--data-binary') + 1];
    calls.push({
      file, args, options, directory: dirname(output),
      modes: readdirSync(dirname(output)).map(name => statSync(join(dirname(output), name)).mode & 0o777),
      directoryMode: statSync(dirname(output)).mode & 0o777,
      body: calls.length === 0 ? JSON.parse(readFileSync(bodyArg.slice(1), 'utf8')) : undefined,
      jar: readFileSync(jarPath, 'utf8'),
    });
    const path = new URL(args.at(-1)).pathname;
    onRequest?.(path);
    if (calls.length === 1 && jar !== undefined) writeFileSync(jarPath, jar);
    if (calls.length === 1 || !emptyDbOutput) writeFileSync(output,
      calls.length === 1 ? loginBody : path === '/api/accounts' ? accountsBody : dbBody);
    if (calls.length === interruptAt) {
      const aborted = new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error(password + token)), { once: true });
      });
      process.emit('SIGTERM');
      return aborted;
    }
    if (calls.length === failureAt) {
      const error = new Error(password + token);
      error.stdout = password;
      error.stderr = token;
      throw error;
    }
    return { stdout: calls.length === 1 ? loginStatus : path === '/api/accounts' ? '200' : dbStatus };
  };
  let result;
  let error;
  try {
    result = await authenticatedSmoke({ ...configuration, ...config }, { runCurl, tempRoot, ...runtimeOptions });
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual(readdirSync(tempRoot), [], 'private files must be removed on every outcome');
  for (const call of calls) {
    assert.equal(call.directoryMode, 0o700);
    assert.ok(call.modes.every(mode => mode === 0o600), 'all temporary files must be private');
    assert.ok(!existsSync(call.directory));
    for (const secret of [email, password, token]) {
      assert.ok(!JSON.stringify(call.args).includes(secret), 'curl argv must not contain credentials/cookies');
      assert.ok(!JSON.stringify(call.options.env).includes(secret), 'curl env must not inherit credentials');
    }
  }
  if (error) {
    assert.ok(!String(error.stack).includes(password));
    assert.ok(!String(error.stack).includes(token));
    assert.equal(error.cause, undefined);
    assert.equal(error.stdout, undefined);
    assert.equal(error.stderr, undefined);
  }
  return { result, error, calls };
}

test('authenticated smoke logs in and queries DB with a private cookie jar and verified service TLS', async t => {
  const { result, error, calls } = await scenario(t);
  assert.ifError(error);
  assert.deepEqual(result, { status: 'ok', public_tables: 42 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, { email, password });
  assert.equal(calls[0].jar, '');
  assert.equal(calls[1].jar, cookie);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.file, 'curl');
    assert.equal(call.args[0], '-q', 'ignore persistent runner curlrc options');
    assert.equal(call.args.at(-1), `https://dev.example.com/api/${index === 0 ? 'auth/login' : 'db'}`);
    assert.equal(call.args[call.args.indexOf('--connect-to') + 1], 'dev.example.com:443:d123.cloudfront.net:443');
    assert.equal(call.args[call.args.indexOf('--proto') + 1], '=https');
    assert.equal(call.args[call.args.indexOf('--max-redirs') + 1], '0');
    assert.equal(call.args[call.args.indexOf('--request') + 1], index === 0 ? 'POST' : 'GET');
    assert.ok(!call.args.some(arg => ['-k', '--insecure', '-L', '--location', '--location-trusted', '-v', '--verbose'].includes(arg)));
  }
  assert.ok(calls[0].args.includes('Content-Type: application/json'));
  assert.ok(!calls[1].args.includes('--data-binary'));
  assert.notEqual(calls[0].args[calls[0].args.indexOf('--output') + 1],
    calls[1].args[calls[1].args.indexOf('--output') + 1], 'responses must not share stale contents');
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf('--max-filesize') + 1], '65536');
    assert.ok(!call.args.some(arg => ['-f', '-fsS', '--fail', '--fail-with-body'].includes(arg)));
  }
});

const prepareRuntime = { schemaVersion: 1, mode: 'prepare', expectedAccountId: '123456789012' };
const databaseTime = '2026-09-14T12:34:56.789Z';
for (const offset of [-3_600_000, 3_600_000]) {
  test(`prepare clock sample preserves the database time with runner offset ${offset}`, async t => {
    const start = Date.parse(databaseTime) + offset;
    let clock = start;
    const { result, error, calls } = await scenario(t, {
      config: { runtimeConfig: prepareRuntime },
      dbBody: JSON.stringify({ status: 'ok', public_tables: 42, server_time: databaseTime, secret: token }),
      runtimeOptions: { includeDatabaseClock: true, now: () => clock },
      onRequest: path => { clock += path === '/api/auth/login' ? 7 : path === '/api/db' ? 23 : 41; },
    });
    assert.ifError(error);
    assert.deepEqual(result, { status: 'ok', mode: 'prepare', public_tables: 42,
      database_clock: { server_time: databaseTime, request_started_at_ms: start + 7,
        response_observed_at_ms: start + 30 } });
    assert.equal(clock, start + 71);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].options.timeout, 35_000);
    assert.ok(!JSON.stringify(result).includes(token));
  });
}

test('database clock opt-in is prepare-only and rejects invalid options before HTTP', async t => {
  const verify = { schemaVersion: 1, mode: 'verify', expectedAccountId: '123456789012',
    expectedCloudfrontId: 'E123EXAMPLE', expectedQueuedTypes: ['cloudfront'], collectionStartedAt: databaseTime };
  for (const [runtimeConfig, includeDatabaseClock] of [[undefined, true], [verify, true], [prepareRuntime, 'true']]) {
    const { error, calls } = await scenario(t, {
      config: { runtimeConfig },
      runtimeOptions: { includeDatabaseClock, now: () => Date.parse(databaseTime) + 1000 },
    });
    assert.ok(error);
    assert.equal(calls.length, 0);
  }
});

test('only clock opt-in rejects missing, malformed or non-UTC database clocks', async t => {
  for (const server_time of [undefined, null, 42, {}, token, '2026-02-30T12:00:00.000Z',
    '2026-09-14T25:00:00.000Z', '2026-09-14T12:34:56.789+00:00', '2026-09-14T12:34:56Z']) {
    const options = { config: { runtimeConfig: prepareRuntime },
      dbBody: JSON.stringify({ status: 'ok', public_tables: 42, server_time }) };
    const failed = await scenario(t, { ...options, runtimeOptions: { includeDatabaseClock: true } });
    assert.match(failed.error?.message || '', /database_clock_invalid/);
    assert.equal(failed.calls.length, 2);
    const unchanged = await scenario(t, options);
    assert.ifError(unchanged.error);
    assert.deepEqual(unchanged.result, { status: 'ok', mode: 'prepare', public_tables: 42 });
  }
});

test('clock samples reject elapsed time above 35 seconds or a backwards runner clock', async t => {
  for (const elapsed of [0, 35_000, 35_001, -1]) {
    const start = Date.parse(databaseTime);
    let clock = start;
    const { result, error } = await scenario(t, {
      config: { runtimeConfig: prepareRuntime },
      dbBody: JSON.stringify({ status: 'ok', public_tables: 42, server_time: databaseTime }),
      runtimeOptions: { includeDatabaseClock: true, now: () => clock },
      onRequest: path => { if (path === '/api/db') clock += elapsed; },
    });
    if (elapsed >= 0 && elapsed <= 35_000) {
      assert.ifError(error);
      assert.equal(result.database_clock.response_observed_at_ms - result.database_clock.request_started_at_ms, elapsed);
    } else {
      assert.match(error?.message || '', /database_clock_invalid/);
    }
  }
});

test('a database clock cannot extend an earlier caller deadline', async t => {
  let clock = Date.parse(databaseTime) - 3_600_000;
  const deadline = clock + 40_000;
  const { error, calls } = await scenario(t, {
    config: { runtimeConfig: prepareRuntime },
    dbBody: JSON.stringify({ status: 'ok', public_tables: 42, server_time: databaseTime }),
    runtimeOptions: { includeDatabaseClock: true, now: () => clock, deadline },
    onRequest: path => { if (path === '/api/db') clock += 10_000; },
  });
  assert.match(error?.message || '', /release_timeout/);
  assert.equal(calls.length, 2);
});

test('an ignored database clock does not change DB-only returns or explicit opt-out', async t => {
  for (const runtimeOptions of [{}, { includeDatabaseClock: false }]) {
    const { result, error } = await scenario(t, {
      dbBody: JSON.stringify({ status: 'ok', public_tables: 42, server_time: token, secret: password }),
      runtimeOptions,
    });
    assert.ifError(error);
    assert.deepEqual(result, { status: 'ok', public_tables: 42 });
  }
});

for (const [name, fixture, callCount] of [
  ['login transport error', { failureAt: 1 }, 1],
  ['DB transport error', { failureAt: 2 }, 2],
  ['login unauthorized', { loginStatus: '401' }, 1],
  ['login challenge', { loginStatus: '403' }, 1],
  ['DB server error', { dbStatus: '500' }, 2],
  ['login redirect', { loginStatus: '302' }, 1],
  ['login temporary redirect', { loginStatus: '307' }, 1],
  ['DB redirect', { dbStatus: '302' }, 2],
  ['malformed login JSON', { loginBody: password }, 1],
  ['login null', { loginBody: 'null' }, 1],
  ['login ok missing', { loginBody: '{}' }, 1],
  ['login ok false', { loginBody: '{"ok":false}' }, 1],
  ['login ok nonboolean', { loginBody: '{"ok":"true"}' }, 1],
  ['missing cookie', { jar: '' }, 1],
  ['cookie comments only', { jar: '# Netscape HTTP Cookie File\n' }, 1],
  ['wrong cookie name', { jar: cookie.replace('awsops_token', 'other_cookie') }, 1],
  ['empty token', { jar: cookie.replace(token, '') }, 1],
  ['foreign cookie host', { jar: cookie.replace('dev.example.com', 'other.example.com') }, 1],
  ['wrong cookie path', { jar: cookie.replace('\t/\t', '\t/login\t') }, 1],
  ['insecure cookie', { jar: cookie.replace('\tTRUE\t', '\tFALSE\t') }, 1],
  ['non-HttpOnly cookie', { jar: cookie.replace('#HttpOnly_', '') }, 1],
  ['expired cookie', { jar: cookie.replace('\t0\t', '\t1\t') }, 1],
  ['malformed DB JSON', { dbBody: password + token }, 2],
  ['DB null', { dbBody: 'null' }, 2],
  ['DB wrong status', { dbBody: '{"status":"unconfigured","public_tables":42}' }, 2],
  ['DB count missing', { dbBody: '{"status":"ok"}' }, 2],
  ['DB count string', { dbBody: '{"status":"ok","public_tables":"42"}' }, 2],
  ['DB count zero', { dbBody: '{"status":"ok","public_tables":0}' }, 2],
  ['DB count negative', { dbBody: '{"status":"ok","public_tables":-1}' }, 2],
  ['DB count fractional', { dbBody: '{"status":"ok","public_tables":1.5}' }, 2],
  ['DB count unsafe', { dbBody: '{"status":"ok","public_tables":9007199254740992}' }, 2],
  ['DB count nonfinite', { dbBody: '{"status":"ok","public_tables":1e999}' }, 2],
]) {
  test(`authenticated smoke rejects ${name} and cleans without leaking secrets`, async t => {
    const { error, calls } = await scenario(t, fixture);
    assert.ok(error, 'smoke must fail closed');
    assert.match(error.message, /^Authenticated smoke:/);
    assert.equal(calls.length, callCount);
  });
}

test('empty database output cannot reuse a successful login body', async t => {
  const { error, calls } = await scenario(t, {
    loginBody: '{"ok":true,"status":"ok","public_tables":42}', emptyDbOutput: true,
  });
  assert.ok(error);
  assert.match(error.message, /database verification failed/);
  assert.equal(calls.length, 2);
});

test('response reads reject bodies over 64 KiB even if the transport fails to enforce the limit', async t => {
  for (const phase of ['login', 'db']) {
    const body = phase === 'login' ? '{"ok":true}' : '{"status":"ok","public_tables":42}';
    const { error } = await scenario(t, { [`${phase}Body`]: body.padEnd(65537, ' ') });
    assert.ok(error);
    assert.match(error.message, phase === 'login' ? /login failed/ : /database verification failed/);
  }
  const { error } = await scenario(t, {
    loginBody: '{"ok":true}'.padEnd(65536, ' '),
    dbBody: '{"status":"ok","public_tables":42}'.padEnd(65536, ' '),
  });
  assert.ifError(error);
});

test('phase errors admit only a valid three-digit HTTP status', async t => {
  for (const status of ['401', '403', '502']) {
    const { error } = await scenario(t, { loginStatus: status });
    assert.match(error.message, new RegExp(`login failed.*HTTP status ${status}$`));
  }
  for (const status of ['000', '999', '200\n', '401 SECRET', '::error::401', '', undefined]) {
    const { error } = await scenario(t, { loginStatus: status === undefined ? null : status });
    assert.ok(error);
    assert.doesNotMatch(error.message, /HTTP status|SECRET|::error::/);
  }
});

test('authenticated smoke defaults scratch to RUNNER_TEMP', async t => {
  const { authenticatedSmoke } = await import('./authenticated-smoke.mjs');
  const temporary = mkdtempSync(join(tmpdir(), 'smoke-runner-temp-'));
  const previous = process.env.RUNNER_TEMP;
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  let output;
  try {
    process.env.RUNNER_TEMP = temporary;
    await assert.rejects(authenticatedSmoke(configuration, {
      runCurl: async (_file, args) => {
        output = args[args.indexOf('--output') + 1];
        throw new Error('fixture transport failure');
      },
    }));
    assert.equal(dirname(dirname(output)), temporary);
    assert.deepEqual(readdirSync(temporary), []);
  } finally {
    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
  }
});

test('real curl preserves HTTP phase/status, TLS, cookies and bounded response handling', async t => {
  const { authenticatedSmoke } = await import('./authenticated-smoke.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'smoke-real-curl-'));
  const cert = join(directory, 'cert.pem');
  const key = join(directory, 'key.pem');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=dev.example.com',
    '-addext', 'subjectAltName=DNS:dev.example.com'], { stdio: 'pipe' });
  let current, requests;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    requests.push({ path: req.url, host: req.headers.host, sni: req.socket.servername, cookie: req.headers.cookie });
    req.resume();
    const login = req.url === '/api/auth/login';
    const status = (login ? current.loginStatus : current.dbStatus) ?? 200;
    const body = current.largeBody
      ? '{"ok":true,"status":"ok","public_tables":42}'.padEnd(current.largeBody, ' ')
      : status === 200 ? login ? '{"ok":true}' : '{"status":"ok","public_tables":42}' : password + token;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...(current.chunked ? {} : { 'Content-Length': Buffer.byteLength(body) }),
      ...(login ? { 'Set-Cookie': `awsops_token=${token}; Path=/; Secure; HttpOnly` } : {}),
      ...(status === 302 ? { Location: '/must-not-follow' } : {}),
    });
    if (current.chunked) res.write(body.slice(0, 10));
    res.end(current.chunked ? body.slice(10) : body);
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const execute = promisify(execFile);
  try {
    for (const [name, fixture, phase, status] of [
      ['login unauthorized', { loginStatus: 401 }, 'login', 401],
      ['login challenge', { loginStatus: 403 }, 'login', 403],
      ['login gateway error', { loginStatus: 502 }, 'login', 502],
      ['database server error', { dbStatus: 500 }, 'database verification', 500],
      ['database unconfigured', { dbStatus: 503 }, 'database verification', 503],
      ['login redirect', { loginStatus: 302 }, 'login', 302],
      ['database redirect', { dbStatus: 302 }, 'database verification', 302],
      ['oversized content length', { largeBody: 65537 }, 'login'],
      ['oversized chunked response', { largeBody: 65537, chunked: true }, 'login'],
      ['exact 64 KiB response', { largeBody: 65536 }],
      ['normal success', {}],
    ]) await t.test(name, async () => {
      current = fixture;
      requests = [];
      const runCurl = (file, args, options) => {
        const localArgs = [...args];
        localArgs[localArgs.indexOf('--connect-to') + 1] = `dev.example.com:443:127.0.0.1:${server.address().port}`;
        // Only destination and local certificate trust differ from production.
        localArgs.splice(-1, 0, '--cacert', cert);
        return execute(file, localArgs, options);
      };
      if (phase) {
        await assert.rejects(authenticatedSmoke(configuration, { runCurl, tempRoot: directory }), error => {
          assert.match(error.message, new RegExp(`${phase} failed`));
          if (status) assert.match(error.message, new RegExp(`HTTP status ${status}$`));
          for (const secret of [email, password, token]) assert.ok(!String(error.stack).includes(secret));
          return true;
        });
      } else {
        assert.deepEqual(await authenticatedSmoke(configuration, { runCurl, tempRoot: directory }),
          { status: 'ok', public_tables: 42 });
      }
      assert.equal(requests.length, phase === 'login' ? 1 : 2);
      for (const req of requests) {
        assert.equal(req.host, 'dev.example.com');
        assert.equal(req.sni, 'dev.example.com');
      }
      if (requests.length === 2) assert.equal(requests[1].cookie, `awsops_token=${token}`);
      assert.deepEqual(readdirSync(directory).sort(), ['cert.pem', 'key.pem']);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const [name, config] of [
  ['HTTP URL', { publicUrl: 'http://dev.example.com' }],
  ['URL credentials', { publicUrl: `https://user:${encodeURIComponent(password)}@dev.example.com` }],
  ['URL path', { publicUrl: 'https://dev.example.com/login' }],
  ['URL query', { publicUrl: 'https://dev.example.com?foo=bar' }],
  ['URL fragment', { publicUrl: 'https://dev.example.com#foo' }],
  ['URL port', { publicUrl: 'https://dev.example.com:8443' }],
  ['invalid URL', { publicUrl: password }],
  ['foreign destination', { cloudfrontDomain: 'd123.cloudfront.net.evil.com' }],
  ['missing username', { email: '' }],
  ['undefined username', { email: undefined }],
  ['blank username', { email: ' \n' }],
  ['overlong username', { email: 'a'.repeat(255) }],
  ['missing password', { password: '' }],
  ['undefined password', { password: undefined }],
  ['overlong password', { password: 'a'.repeat(257) }],
]) {
  test(`authenticated smoke refuses ${name} before invoking curl`, async t => {
    const { error, calls } = await scenario(t, { config });
    assert.ok(error);
    assert.match(error.message, /^Authenticated smoke:/);
    assert.equal(calls.length, 0);
  });
}

test('authenticated smoke accepts the positive safe-integer count boundaries', async t => {
  for (const public_tables of [1, Number.MAX_SAFE_INTEGER]) {
    const { result, error } = await scenario(t, { dbBody: JSON.stringify({ status: 'ok', public_tables }) });
    assert.ifError(error);
    assert.equal(result.public_tables, public_tables);
  }
});

test('authenticated smoke aborts and removes private files on runner cancellation', async t => {
  const before = process.listenerCount('SIGTERM');
  for (const interruptAt of [1, 2]) {
    const { error, calls } = await scenario(t, { interruptAt });
    assert.ok(error);
    assert.equal(calls.length, interruptAt);
    assert.equal(process.listenerCount('SIGTERM'), before);
  }
});

const root = fileURLToPath(new URL('../../', import.meta.url));
test('the actual edge public-path function keeps DB authenticated and health public', () => {
  const result = JSON.parse(execFileSync('python3', ['-c', [
    'import ast,json,pathlib,sys',
    'path=pathlib.Path(sys.argv[1])',
    'function=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=="is_public")',
    'namespace={}',
    'exec(compile(ast.Module(body=[function],type_ignores=[]),str(path),"exec"),namespace)',
    'print(json.dumps({p:namespace["is_public"](p) for p in ["/api/db","/api/health"]}))',
  ].join('\n'), join(root, 'terraform/foundation/edge-lambda/cognito_edge.py.tftpl')], { encoding: 'utf8' }));
  assert.deepEqual(result, { '/api/db': false, '/api/health': true });
});

// PyYAML is already installed by Merge Verify for the workflow fixture suite.
const workflow = JSON.parse(execFileSync('python3', ['-c', [
  'import json,sys,yaml',
  'print(json.dumps(yaml.safe_load(open(sys.argv[1]))))',
].join('\n'), join(root, '.github/workflows/deploy-web.yml')], { encoding: 'utf8' }));
const deploySteps = workflow.jobs.deploy.steps;
const stepNamed = (steps, name) => {
  const step = steps.find(item => item.name === name);
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
};
const enabled = (step, event, verify, ref = 'refs/heads/dev') => {
  // These step conditions use the shared JS/GitHub expression subset.
  return Boolean(Function('github', 'inputs', `return (${step.if});`)(
    { event_name: event, ref }, { verify_database: verify },
  ));
};

test('Deploy Web automatically verifies dev authentication and DB after exact image verification', () => {
  const input = (workflow.on ?? workflow.true).workflow_dispatch.inputs.verify_database;
  assert.ok(input, 'missing compatibility database verification input');
  assert.equal(input.type, 'boolean');
  assert.equal(input.default, false);
  assert.equal(input.required, false);
  const auth = stepNamed(deploySteps, 'Authenticated database smoke');
  const resolve = stepNamed(deploySteps, 'Prepare configured demo credentials');
  for (const step of [auth, resolve]) {
    assert.equal(step.if, "github.ref == 'refs/heads/dev'");
  }
  assert.ok(deploySteps.indexOf(auth) > deploySteps.indexOf(stepNamed(deploySteps, 'Smoke test')));
  assert.ok(deploySteps.indexOf(resolve) < deploySteps.indexOf(stepNamed(deploySteps, 'Promote the verified image and start its deployment')));
  assert.ok(deploySteps.indexOf(auth) > deploySteps.indexOf(stepNamed(deploySteps, 'Verify exact deployment and healthy running web image')));
  assert.ok(deploySteps.indexOf(resolve) < deploySteps.indexOf(stepNamed(deploySteps, 'Resolve ECS cluster/service/URL + ECR repo')));
  assert.ok(deploySteps.indexOf(resolve) < deploySteps.indexOf(stepNamed(deploySteps, 'Clean restored terraform config off the runner')));
  assert.equal(resolve.env.TF_VAR_demo_password, '${{ secrets.TF_VAR_DEMO_PASSWORD }}');
  assert.equal(auth.env.SMOKE_CREDENTIAL_FILE, '${{ steps.demo.outputs.credential_file }}');
  assert.equal(resolve.id, 'demo');
  assert.equal(deploySteps.find(step => step.uses === 'hashicorp/setup-terraform@v3').with.terraform_version, '1.15.7');
  // The wrapper can publish Terraform stdout as step outputs; the credential
  // helper must capture the effective password through the unwrapped binary.
  assert.equal(deploySteps.find(step => step.uses === 'hashicorp/setup-terraform@v3').with.terraform_wrapper, false);
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(!JSON.stringify(job.env ?? {}).includes('TF_VAR_DEMO_PASSWORD'));
    for (const step of job.steps ?? []) {
      if (step !== resolve) assert.ok(!JSON.stringify(step).includes('TF_VAR_DEMO_PASSWORD'));
    }
  }
});

test('Deploy Web rejects unsupported verification refs before any build or deployment step', () => {
  const requestEnv = {
    GITHUB_REPOSITORY: 'aws-samples/sample-awsops', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_EVENT_NAME: 'workflow_dispatch', BUILD: 'true', IMAGE_SHA: '', PRODUCER_RUN: '',
    SCHEMA_ACK: 'false', GITHUB_OUTPUT: '/dev/null',
  };
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'image-proof') {
      assert.ok(job.needs.includes('guard'));
      assert.match(job.if, /needs\.guard\.result == 'success'/);
      continue;
    }
    if (!job.steps) {
      assert.equal(job.uses, './.github/workflows/deploy-migrations.yml');
      assert.ok(job.needs.includes('guard'));
      continue;
    }
    const guard = stepNamed(job.steps, name === 'guard'
      ? 'Validate release request before builds or migrations' : 'Validate database verification ref');
    assert.equal(job.steps.indexOf(guard), 0);
    assert.equal(guard.env.VERIFY_DATABASE, '${{ inputs.verify_database }}');
    for (const ref of ['refs/heads/main', 'refs/heads/atomoh', 'refs/heads/feature', 'refs/tags/dev']) {
      const rejected = spawnSync('bash', ['-euo', 'pipefail', '-c', guard.run], {
        encoding: 'utf8', env: { ...requestEnv, PATH: process.env.PATH, GITHUB_REF: ref, VERIFY_DATABASE: 'true' },
      });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stdout + rejected.stderr, /only supported.*dev/);
    }
    for (const [ref, verify] of [['refs/heads/dev', 'true'], ['refs/heads/main', 'false'], ['refs/heads/atomoh', '']]) {
      const allowed = spawnSync('bash', ['-euo', 'pipefail', '-c', guard.run], {
        encoding: 'utf8', env: { ...requestEnv, PATH: process.env.PATH, GITHUB_REF: ref, VERIFY_DATABASE: verify },
      });
      assert.equal(allowed.status, 0, allowed.stderr);
    }
  }
});

function cliFixture(t, { fail = false, preparedFile, killSmoke = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'authenticated-cli-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const temporary = preparedFile ? dirname(dirname(preparedFile)) : join(directory, 'private');
  mkdirSync(temporary, { mode: 0o700, recursive: true });
  const unmanaged = join(directory, 'unmanaged');
  mkdirSync(unmanaged, { mode: 0o700 });
  const commands = join(directory, 'commands.jsonl');
  writeFileSync(join(directory, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commands)}, JSON.stringify({args, env: process.env}) + '\\n');
const output = args[args.indexOf('--output') + 1];
const login = args.at(-1).endsWith('/api/auth/login');
if (login) {
  const jar = args[args.indexOf('--cookie-jar') + 1];
  const payload = JSON.parse(fs.readFileSync(args[args.indexOf('--data-binary') + 1].slice(1), 'utf8'));
  if (payload.email !== ${JSON.stringify(email)} || payload.password !== ${JSON.stringify(password)}) process.exit(90);
  // Emulate curl replacing the cookie file, including inherited umask.
  fs.writeFileSync(jar + '.tmp', ${JSON.stringify(cookie)});
  fs.renameSync(jar + '.tmp', jar);
  if ((fs.statSync(jar).mode & 0o777) !== 0o600) process.exit(91);
} else if (fs.readFileSync(args[args.indexOf('--cookie') + 1], 'utf8') !== ${JSON.stringify(cookie)}) {
  process.exit(92);
}
fs.writeFileSync(output, login ? '{"ok":true}' : '{"status":"ok","public_tables":42}');
if (${killSmoke}) {
  process.kill(process.ppid, 'SIGKILL');
  process.exit(0);
}
if (${fail}) {
  process.stdout.write(${JSON.stringify(password)});
  process.stderr.write(${JSON.stringify(token)});
  process.exit(7);
}
process.stdout.write('200');
`, { mode: 0o700 });
  const credentialFile = preparedFile || join(mkdtempSync(join(temporary, 'awsops-smoke-credentials-')), 'credentials.json');
  if (!preparedFile) writeFileSync(credentialFile, JSON.stringify({ email, password }), { mode: 0o600 });
  return {
    temporary, unmanaged, commands,
    credentialFile,
    env: {
      PATH: `${directory}:${process.env.PATH}`, TMPDIR: unmanaged, RUNNER_TEMP: temporary,
      PUBLIC_URL: configuration.publicUrl, CLOUDFRONT_DOMAIN: configuration.cloudfrontDomain,
      SMOKE_CREDENTIAL_FILE: credentialFile,
    },
  };
}

for (const fail of [false, true]) {
  test(`authenticated smoke CLI ${fail ? 'suppresses curl error output' : 'completes login and DB verification'}`, t => {
    const fixture = cliFixture(t, { fail });
    const result = spawnSync(process.execPath, [join(root, 'scripts/v2/authenticated-smoke.mjs')], {
      encoding: 'utf8', env: fixture.env,
    });
    assert.equal(result.status, fail ? 1 : 0);
    assert.match(result.stdout + result.stderr, fail ? /Authenticated smoke:/ : /Authenticated database smoke passed/);
    for (const secret of [email, password, token]) assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.deepEqual(readdirSync(fixture.temporary), []);
    assert.deepEqual(readdirSync(fixture.unmanaged), []);
    assert.ok(existsSync(fixture.commands), 'CLI must actually invoke curl');
    const calls = readFileSync(fixture.commands, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, fail ? 1 : 2);
    for (const call of calls) {
      assert.equal(dirname(dirname(call.args[call.args.indexOf('--output') + 1])), dirname(fixture.credentialFile));
      for (const secret of [email, password, token]) assert.ok(!JSON.stringify(call).includes(secret));
    }
  });
}

test('always cleanup removes killed-smoke scratch only beneath this run credential directory', t => {
  const fixture = cliFixture(t, { killSmoke: true });
  const runtimeFile = join(dirname(fixture.credentialFile), 'runtime.json');
  writeFileSync(runtimeFile, JSON.stringify({
    schemaVersion: 1, mode: 'prepare', expectedAccountId: '123456789012',
  }), { mode: 0o600 });
  fixture.env.SMOKE_RUNTIME_CONFIG_FILE = runtimeFile;
  const other = join(fixture.temporary, 'awsops-smoke-credentials-otherJob');
  mkdirSync(other, { mode: 0o700 });
  writeFileSync(join(other, 'credentials.json'), 'other-job-sentinel', { mode: 0o600 });
  const killed = spawnSync(process.execPath, [join(root, 'scripts/v2/authenticated-smoke.mjs')], {
    encoding: 'utf8', env: fixture.env, timeout: 5000,
  });
  assert.equal(killed.signal, 'SIGKILL');
  assert.ok(existsSync(fixture.credentialFile));
  assert.ok(existsSync(runtimeFile));
  const call = JSON.parse(readFileSync(fixture.commands, 'utf8').trim());
  const output = call.args[call.args.indexOf('--output') + 1];
  assert.ok(existsSync(join(dirname(output), 'login.json')));
  assert.ok(readFileSync(join(dirname(output), 'cookies.txt'), 'utf8').includes(token));
  const cleanup = stepNamed(deploySteps, 'Clean prepared demo credentials off the runner');
  assert.match(cleanup.if, /always\(\)/);
  const cleaned = spawnSync('bash', ['-euo', 'pipefail', '-c', cleanup.run], {
    cwd: root, env: fixture.env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.ok(!existsSync(runtimeFile));
  assert.ok(!existsSync(dirname(output)), 'always cleanup must own the killed smoke scratch');
  assert.deepEqual(readdirSync(fixture.unmanaged), []);
  assert.equal(readFileSync(join(other, 'credentials.json'), 'utf8'), 'other-job-sentinel');
  assert.deepEqual(readdirSync(fixture.temporary), ['awsops-smoke-credentials-otherJob']);
});

test('authenticated smoke CLI rejects missing credentials and unexpected arguments without curl', t => {
  for (const [contents, overrides, args, message] of [
    ['{}', {}, [], /configured demo username/],
    [JSON.stringify({ email, password: '' }), {}, [], /credential/],
    [password + token, {}, [], /credential/],
    [null, { PUBLIC_URL: token }, [], /HTTPS service URL/],
    [null, {}, [password], /configuration/],
  ]) {
    const fixture = cliFixture(t);
    if (contents !== null) writeFileSync(fixture.credentialFile, contents);
    const result = spawnSync(process.execPath, [join(root, 'scripts/v2/authenticated-smoke.mjs'), ...args], {
      encoding: 'utf8', env: { ...fixture.env, ...overrides },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    for (const secret of [email, password, token]) assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.deepEqual(readdirSync(fixture.temporary), []);
    assert.ok(!existsSync(fixture.commands));
  }
});

test('authenticated smoke CLI rejects absent or nonprivate files without exposing their contents', t => {
  for (const kind of ['absent', 'public-file', 'public-directory']) {
    const fixture = cliFixture(t);
    if (kind === 'absent') rmSync(fixture.credentialFile);
    else execFileSync('chmod', [kind === 'public-file' ? '0644' : '0755',
      kind === 'public-file' ? fixture.credentialFile : dirname(fixture.credentialFile)]);
    const result = spawnSync(process.execPath, [join(root, 'scripts/v2/authenticated-smoke.mjs')], {
      encoding: 'utf8', env: fixture.env,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not read private credentials/);
    for (const secret of [email, password, token]) assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.ok(!existsSync(fixture.commands));
    assert.deepEqual(readdirSync(fixture.temporary), []);
  }
});

test('Deploy Web authenticated smoke shell step reads a private credential file without a secret environment', t => {
  const step = stepNamed(deploySteps, 'Authenticated database smoke');
  const fixture = cliFixture(t);
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
    encoding: 'utf8', cwd: root, env: fixture.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Authenticated database smoke passed/);
  assert.deepEqual(readdirSync(fixture.temporary), []);
  assert.equal(readFileSync(fixture.commands, 'utf8').trim().split('\n').length, 2);
});

// Use the actual Terraform evaluator in a variable-only directory. init/output
// are the substituted boundary: no provider, remote backend or AWS is contacted.
function preparationFixture(t, {
  shared = '', override, applied = JSON.stringify(email), extra = '', failAt = '',
  cancelAt = '', consoleOutput, malformed = false, demoEnabled = true,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'prepare-smoke-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const foundation = join(directory, 'terraform/foundation');
  const temporary = join(directory, 'private');
  mkdirSync(foundation, { recursive: true });
  mkdirSync(temporary, { mode: 0o700 });
  mkdirSync(join(directory, 'bin'));
  symlinkSync(process.execPath, join(directory, 'bin/node'));
  mkdirSync(join(directory, 'scripts/v2'), { recursive: true });
  mkdirSync(join(directory, 'scripts/v2/ci'));
  copyFileSync(join(root, 'scripts/v2/ci/run-migration.mjs'), join(directory, 'scripts/v2/ci/run-migration.mjs'));
  for (const name of ['prepare-smoke-credentials.mjs', 'authenticated-smoke.mjs', 'deployment-smoke.mjs', 'migration-errors.mjs']) {
    if (existsSync(join(root, 'scripts/v2', name))) copyFileSync(join(root, 'scripts/v2', name), join(directory, 'scripts/v2', name));
  }
  writeFileSync(join(foundation, 'main.tf'), `
terraform { required_version = "= 1.15.7" }
variable "create_demo_user" {
  type = bool
  default = false
}
variable "demo_email" {
  type = string
  default = "${email}"
}
variable "demo_password" {
  type = string
  sensitive = true
  default = ""
}
`);
  writeFileSync(join(foundation, 'backend.hcl'), '');
  // JSON string literals are valid HCL expressions; metacharacters are not
  // interpreted by a shell. Also exercise a real multiline HCL assignment.
  const tfvars = `create_demo_user = ${demoEnabled}\n${override === undefined ? '' : `demo_password = (\n${JSON.stringify(override)}\n)\n`}${extra}`;
  writeFileSync(join(foundation, 'terraform.tfvars'), malformed
    ? `create_demo_user = true\ndemo_password = "fixture-password-bearing-invalid-line\n` : tfvars, { mode: 0o600 });
  const realTerraform = execFileSync('which', ['terraform'], { encoding: 'utf8' }).trim();
  const commands = join(directory, 'commands.jsonl');
  writeFileSync(join(directory, 'bin/terraform'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args) + '\\n');
if (Object.keys(process.env).some(key => /^TF_LOG|^TF_CLI_ARGS/.test(key))) process.exit(93);
process.stderr.write(${JSON.stringify(password + token)});
if (args[0] === ${JSON.stringify(cancelAt)}) {
  process.kill(process.ppid, 'SIGTERM');
  setInterval(() => {}, 1000);
} else if (args[0] === ${JSON.stringify(failAt)}) {
  process.stdout.write(${JSON.stringify(password)});
  process.exit(7);
} else if (args[0] === 'init') {
  process.stdout.write(${JSON.stringify(password)});
} else if (JSON.stringify(args) === JSON.stringify(['output', '-json', 'demo_username'])) {
  process.stdout.write(${JSON.stringify(applied)});
} else if (args[0] === 'console') {
  const input = fs.readFileSync(0, 'utf8');
  ${consoleOutput === undefined ? `
  const result = spawnSync(${JSON.stringify(realTerraform)}, args, {
    encoding: 'utf8', input, env: process.env,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);` : `process.stdout.write(${JSON.stringify(consoleOutput)});`}
} else {
  process.exit(94);
}
`, { mode: 0o700 });
  const output = join(directory, 'github-output');
  writeFileSync(output, '');
  const env = {
    PATH: `${join(directory, 'bin')}:${process.env.PATH}`, HOME: directory,
    TMPDIR: temporary, RUNNER_TEMP: temporary, CHECKPOINT_DISABLE: '1',
    GITHUB_OUTPUT: output, TF_VAR_demo_password: shared,
    TF_LOG: 'TRACE', TF_LOG_CORE: 'TRACE', TF_LOG_PROVIDER: 'TRACE',
    TF_LOG_PATH: join(directory, 'unsafe-trace.log'),
    TF_CLI_ARGS: '-input=false', TF_CLI_ARGS_console: '-plan',
    TF_CLI_ARGS_init: '-backend-config=foreign.hcl',
    TF_CLI_ARGS_output: '-state=foreign.tfstate',
  };
  const run = step => spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
    cwd: step['working-directory'] ? join(directory, step['working-directory']) : directory,
    encoding: 'utf8', env, timeout: 10_000,
  });
  const safe = result => {
    for (const secret of [email, password, token, shared, 'fixture-password-bearing-invalid-line'].filter(Boolean)) {
      assert.ok(!(result.stdout + result.stderr).includes(secret), 'public output must not contain credentials or Terraform diagnostics');
      assert.ok(!readFileSync(output, 'utf8').includes(secret), 'step output must carry only a path');
    }
    assert.ok(!existsSync(env.TF_LOG_PATH), 'Terraform must not write inherited trace logs');
  };
  return { directory, foundation, temporary, output, commands, env, realTerraform, run, safe };
}

for (const [name, shared, override] of [
  ['differing shared and protected per-stack override', 'shared-default-Password9', password],
  ['override-only', '', password],
  ['shared default', password, undefined],
]) {
  test(`credential preparation uses Terraform precedence for ${name}`, t => {
    const fixture = preparationFixture(t, { shared, override });
    const result = fixture.run(stepNamed(deploySteps, 'Prepare configured demo credentials'));
    fixture.safe(result);
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(fixture.output, 'utf8');
    assert.match(output, /^credential_file=.+\/credentials\.json\n$/);
    const file = output.trim().slice('credential_file='.length);
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { email, password });
    const calls = readFileSync(fixture.commands, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(args => args[0]), ['init', 'output', 'console']);
    assert.ok(!calls.some(args => args[0] === 'console' && args.some(arg => ['-input=false', '-lock=false', '-plan'].includes(arg))));

    // A real console normally hides this value; the production expression must
    // explicitly unwrap sensitivity and correctly decode Terraform's JSON string.
    const sensitive = spawnSync(fixture.realTerraform, ['console', '-no-color'], {
      cwd: fixture.foundation, encoding: 'utf8', input: 'var.demo_password\n',
      env: { PATH: process.env.PATH, HOME: fixture.directory, CHECKPOINT_DISABLE: '1', TF_VAR_demo_password: shared },
    });
    assert.equal(sensitive.status, 0);
    assert.equal(sensitive.stdout.trim(), '(sensitive value)');

    // Always-cleanup also handles a rollout failure before the smoke is reached.
    const cleanup = stepNamed(deploySteps, 'Clean prepared demo credentials off the runner');
    assert.match(cleanup.if, /always\(\)/);
    fixture.env.SMOKE_CREDENTIAL_FILE = file;
    const cleaned = fixture.run(cleanup);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.deepEqual(readdirSync(fixture.temporary), []);
    assert.equal(fixture.run(cleanup).status, 0, 'cleanup is idempotent after smoke consumption');
  });
}

for (const [name, options] of [
  ['missing both passwords', {}],
  ['empty override shadows a usable shared default', { shared: password, override: '' }],
  ['null password', { override: null }],
  ['overlong password', { override: 'x'.repeat(257) }],
  ['disabled demo', { demoEnabled: false }],
  ['identity mismatch', { extra: 'demo_email = "other@example.org"\n' }],
  ['blank configured identity', { extra: 'demo_email = " "\n', applied: '" "' }],
  ['newline configured identity', { extra: 'demo_email = "bad\\nname"\n', applied: '"bad\\nname"' }],
  ['malformed password-bearing HCL', { malformed: true }],
  ['missing applied output', { failAt: 'output' }],
  ['empty applied username', { applied: '""' }],
  ['null applied username', { applied: 'null' }],
  ['malformed applied output', { applied: password + token }],
  ['init failure', { failAt: 'init' }],
  ['console failure', { failAt: 'console' }],
  ['console sensitive placeholder', { consoleOutput: '(sensitive value)\n' }],
  ['console malformed JSON', { consoleOutput: password + token }],
  ['cancellation during init', { cancelAt: 'init' }],
  ['cancellation during console', { cancelAt: 'console' }],
]) {
  test(`credential preparation fails safely before rollout for ${name}`, t => {
    const fixture = preparationFixture(t, { shared: name === 'missing both passwords' ? '' : password, ...options });
    const result = fixture.run(stepNamed(deploySteps, 'Prepare configured demo credentials'));
    fixture.safe(result);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /credential preparation:/i);
    assert.equal(readFileSync(fixture.output, 'utf8'), '');
    assert.deepEqual(readdirSync(fixture.temporary), []);
  });
}

test('credential preparation removes the file if path publication fails', t => {
  const fixture = preparationFixture(t, { shared: password });
  fixture.env.GITHUB_OUTPUT = fixture.directory;
  const result = fixture.run(stepNamed(deploySteps, 'Prepare configured demo credentials'));
  fixture.safe(result);
  assert.equal(result.status, 1);
  assert.deepEqual(readdirSync(fixture.temporary), []);
});

test('private Terraform init has a ten-minute budget while output and console retain two minutes', t => {
  const fixture = preparationFixture(t, { shared: password });
  const capture = join(fixture.directory, 'child-options.jsonl');
  const hook = join(fixture.directory, 'capture-child-options.mjs');
  writeFileSync(hook, `
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.execFile;
childProcess.execFile = function(file, args, options, callback) {
  if (file === 'terraform') appendFileSync(${JSON.stringify(capture)},
    JSON.stringify({ command: args[0], timeout: options.timeout, ignoredStdio: 'stdio' in options }) + '\\n');
  return original.call(this, file, args, options, callback);
};
syncBuiltinESMExports();
`);
  fixture.env.NODE_OPTIONS = `--import=${hook}`;
  const result = fixture.run(stepNamed(deploySteps, 'Prepare configured demo credentials'));
  fixture.safe(result);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [
    { command: 'init', timeout: 600000, ignoredStdio: false },
    { command: 'output', timeout: 120000, ignoredStdio: false },
    { command: 'console', timeout: 120000, ignoredStdio: false },
  ]);
});

for (const fail of [false, true]) {
  test(`prepared override survives tfvars cleanup and is consumed privately on ${fail ? 'login failure' : 'successful login/DB check'}`, t => {
    const fixture = preparationFixture(t, { shared: 'different-shared-Password9', override: password });
    const prepared = fixture.run(stepNamed(deploySteps, 'Prepare configured demo credentials'));
    assert.equal(prepared.status, 0, prepared.stderr);
    const file = readFileSync(fixture.output, 'utf8').trim().slice('credential_file='.length);
    assert.equal(fixture.run(stepNamed(deploySteps, 'Clean restored terraform config off the runner')).status, 0);
    assert.ok(!existsSync(join(fixture.foundation, 'terraform.tfvars')));
    assert.ok(!existsSync(join(fixture.foundation, 'backend.hcl')));
    const cli = cliFixture(t, { fail, preparedFile: file });
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', stepNamed(deploySteps, 'Authenticated database smoke').run], {
      encoding: 'utf8', cwd: root, env: cli.env,
    });
    fixture.safe(result);
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    assert.deepEqual(readdirSync(fixture.temporary), []);
    const calls = readFileSync(cli.commands, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, fail ? 1 : 2);
    for (const secret of [email, password, token]) assert.ok(!JSON.stringify(calls).includes(secret));
  });
}

test('non-dev init stays local while every dev release defers init to private credential preparation', t => {
  const fixture = preparationFixture(t);
  const restore = stepNamed(deploySteps, 'Restore terraform.foundation backend');
  for (const branch of ['main', 'dev']) {
    rmSync(fixture.commands, { force: true });
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', restore.run], {
      cwd: fixture.foundation, encoding: 'utf8', env: {
        PATH: fixture.env.PATH, GITHUB_OUTPUT: fixture.output, BRANCH: branch, VERIFY_DATABASE: 'false',
        MAIN_BACKEND_B64: Buffer.from('\n').toString('base64'),
        MAIN_TFVARS_B64: Buffer.from('create_demo_user = true\n').toString('base64'),
        DEV_BACKEND_B64: Buffer.from('\n').toString('base64'),
        DEV_TFVARS_B64: Buffer.from('create_demo_user = true\n').toString('base64'),
      },
    });
    assert.equal(result.status, 0);
    assert.equal(existsSync(fixture.commands), branch === 'main');
    if (branch === 'main') assert.deepEqual(JSON.parse(readFileSync(fixture.commands, 'utf8')),
      ['init', '-backend-config=backend.hcl', '-input=false']);
  }
});

test('restore recreates only its owned files privately without following leftover symlinks', t => {
  const fixture = preparationFixture(t);
  const restore = stepNamed(deploySteps, 'Restore terraform.foundation backend');
  const foreign = join(fixture.foundation, 'another-job.txt');
  writeFileSync(foreign, 'other-job-sentinel', { mode: 0o644 });
  for (const kind of ['public-file', 'symlink']) {
    for (const name of ['backend.hcl', 'terraform.tfvars']) {
      const file = join(fixture.foundation, name);
      rmSync(file, { force: true });
      if (kind === 'symlink') symlinkSync(foreign, file);
      else { writeFileSync(file, 'stale config'); chmodSync(file, 0o644); }
    }
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', restore.run], {
      cwd: fixture.foundation, encoding: 'utf8', env: {
        PATH: fixture.env.PATH, GITHUB_OUTPUT: fixture.output, BRANCH: 'dev', VERIFY_DATABASE: 'true',
        DEV_BACKEND_B64: Buffer.from('bucket="fixture"\n').toString('base64'),
        DEV_TFVARS_B64: Buffer.from('create_demo_user=true\n').toString('base64'),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['backend.hcl', 'terraform.tfvars']) {
      const info = lstatSync(join(fixture.foundation, name));
      assert.ok(info.isFile());
      assert.equal(info.mode & 0o777, 0o600);
    }
    assert.equal(readFileSync(foreign, 'utf8'), 'other-job-sentinel');
  }
});
