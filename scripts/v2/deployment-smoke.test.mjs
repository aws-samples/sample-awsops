import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeArgs } from './deployment-smoke.mjs';

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
  jar = cookie, failureAt, interruptAt,
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
    if (calls.length === 1 && jar !== undefined) writeFileSync(jarPath, jar);
    writeFileSync(output, calls.length === 1 ? loginBody : dbBody);
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
    return { stdout: calls.length === 1 ? loginStatus : dbStatus };
  };
  let result;
  let error;
  try {
    result = await authenticatedSmoke({ ...configuration, ...config }, { runCurl, tempRoot });
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
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
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

test('Deploy Web database verification is dispatch opt-in and follows regular health verification', () => {
  const input = (workflow.on ?? workflow.true).workflow_dispatch.inputs.verify_database;
  assert.ok(input, 'missing opt-in database verification input');
  assert.equal(input.type, 'boolean');
  assert.equal(input.default, false);
  assert.equal(input.required, false);
  const auth = stepNamed(deploySteps, 'Authenticated database smoke');
  const resolve = stepNamed(deploySteps, 'Prepare configured demo credentials');
  for (const step of [auth, resolve]) {
    assert.equal(enabled(step, 'workflow_dispatch', true), true);
    assert.equal(enabled(step, 'workflow_dispatch', false), false);
    assert.equal(enabled(step, 'push', true), false);
  }
  assert.ok(deploySteps.indexOf(auth) > deploySteps.indexOf(stepNamed(deploySteps, 'Smoke test')));
  assert.ok(deploySteps.indexOf(resolve) < deploySteps.indexOf(stepNamed(deploySteps, 'Pin web-latest to the approved image')));
  assert.ok(deploySteps.indexOf(resolve) < deploySteps.indexOf(stepNamed(deploySteps, 'Resolve ECS cluster/service/URL + ECR repo')));
  assert.ok(deploySteps.indexOf(resolve) < deploySteps.indexOf(stepNamed(deploySteps, 'Clean restored terraform config off the runner')));
  assert.equal(resolve.env.TF_VAR_demo_password, '${{ secrets.TF_VAR_DEMO_PASSWORD }}');
  assert.equal(auth.env.SMOKE_CREDENTIAL_FILE, '${{ steps.demo.outputs.credential_file }}');
  assert.equal(resolve.id, 'demo');
  assert.equal(deploySteps.find(step => step.uses === 'hashicorp/setup-terraform@v3').with.terraform_version, '1.15.7');
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(!JSON.stringify(job.env ?? {}).includes('TF_VAR_DEMO_PASSWORD'));
    for (const step of job.steps) {
      if (step !== resolve) assert.ok(!JSON.stringify(step).includes('TF_VAR_DEMO_PASSWORD'));
    }
  }
});

test('Deploy Web rejects unsupported verification refs before any build or deployment step', () => {
  for (const job of Object.values(workflow.jobs)) {
    const guard = stepNamed(job.steps, 'Validate database verification ref');
    assert.equal(job.steps.indexOf(guard), 0);
    assert.equal(guard.env.VERIFY_DATABASE, '${{ inputs.verify_database }}');
    for (const ref of ['refs/heads/main', 'refs/heads/atomoh', 'refs/heads/feature', 'refs/tags/dev']) {
      const rejected = spawnSync('bash', ['-euo', 'pipefail', '-c', guard.run], {
        encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_REF: ref, VERIFY_DATABASE: 'true' },
      });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stdout + rejected.stderr, /only supported.*dev/);
    }
    for (const [ref, verify] of [['refs/heads/dev', 'true'], ['refs/heads/main', 'false'], ['refs/heads/atomoh', '']]) {
      const allowed = spawnSync('bash', ['-euo', 'pipefail', '-c', guard.run], {
        encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_REF: ref, VERIFY_DATABASE: verify },
      });
      assert.equal(allowed.status, 0, allowed.stderr);
    }
  }
});

function cliFixture(t, { fail = false, preparedFile } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'authenticated-cli-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const temporary = preparedFile ? dirname(dirname(preparedFile)) : join(directory, 'private');
  mkdirSync(temporary, { mode: 0o700, recursive: true });
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
    temporary, commands,
    credentialFile,
    env: {
      PATH: `${directory}:${process.env.PATH}`, TMPDIR: temporary,
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
    assert.ok(existsSync(fixture.commands), 'CLI must actually invoke curl');
    const calls = readFileSync(fixture.commands, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, fail ? 1 : 2);
    for (const call of calls) {
      for (const secret of [email, password, token]) assert.ok(!JSON.stringify(call).includes(secret));
    }
  });
}

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
  mkdirSync(join(directory, 'scripts/v2'), { recursive: true });
  for (const name of ['prepare-smoke-credentials.mjs', 'authenticated-smoke.mjs', 'deployment-smoke.mjs']) {
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

test('normal Deploy Web still initializes normally; opt-in defers init to the private preparation helper', t => {
  const fixture = preparationFixture(t);
  const restore = stepNamed(deploySteps, 'Restore terraform.foundation backend');
  for (const verify of ['false', 'true']) {
    rmSync(fixture.commands, { force: true });
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', restore.run], {
      cwd: fixture.foundation, encoding: 'utf8', env: {
        PATH: fixture.env.PATH, BRANCH: 'dev', VERIFY_DATABASE: verify,
        DEV_BACKEND_B64: Buffer.from('\n').toString('base64'),
        DEV_TFVARS_B64: Buffer.from('create_demo_user = true\n').toString('base64'),
      },
    });
    assert.equal(result.status, 0);
    assert.equal(existsSync(fixture.commands), verify === 'false');
    if (verify === 'false') assert.deepEqual(JSON.parse(readFileSync(fixture.commands, 'utf8')),
      ['init', '-backend-config=backend.hcl', '-input=false']);
  }
});
