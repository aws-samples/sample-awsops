// Authenticate through the deployed BFF/edge, retaining service Host/SNI/TLS
// while service DNS is deferred. curl receives private filenames, never secrets.
import { execFile } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { smokeConnectionArgs } from './deployment-smoke.mjs';
import { cleanupSmokeCredentials, readSmokeCredentials } from './prepare-smoke-credentials.mjs';
import { readRuntimeSmokeConfig, verifyRuntimeSmoke, RuntimeSmokeError } from './runtime-smoke.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_INVENTORY_RESPONSE_BYTES = 2 * 1024 * 1024;
class SmokeError extends Error {}

function readPrivateResponse(file, limit = MAX_RESPONSE_BYTES) {
  const fd = openSync(file, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new Error();
    // Bound the read itself as well, including a file that grows after fstat.
    const contents = Buffer.alloc(limit + 1);
    let length = 0, count;
    while (length < contents.length
        && (count = readSync(fd, contents, length, contents.length - length, null)) > 0) length += count;
    if (length > limit) throw new Error();
    return contents.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function hasSessionCookie(contents, hostname) {
  return contents.split(/\r?\n/).some(line => {
    // web/lib/login.ts issues a host-only, Path=/, Secure + HttpOnly cookie.
    // curl represents HttpOnly using this Netscape jar prefix.
    if (!line.startsWith('#HttpOnly_')) return false;
    line = line.slice('#HttpOnly_'.length);
    const [domain, subdomains, path, secure, expires, name, value, extra] = line.split('\t');
    const expiry = Number(expires);
    return domain === hostname && subdomains === 'FALSE' && path === '/'
      && secure === 'TRUE' && /^\d+$/.test(expires) && Number.isSafeInteger(expiry)
      && (expiry === 0 || expiry > Date.now() / 1000)
      && name === 'awsops_token' && Boolean(value) && extra === undefined;
  });
}

export async function authenticatedSmoke(
  { publicUrl, cloudfrontDomain, email, password, runtimeConfig },
  { runCurl = execute, tempRoot = resolve(process.env.RUNNER_TEMP || tmpdir()) } = {},
) {
  let directory;
  let previousUmask;
  let failure = 'requires an HTTPS service URL and a CloudFront distribution domain';
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  try {
    const connectionArgs = smokeConnectionArgs(publicUrl, cloudfrontDomain);
    const url = new URL(publicUrl);
    failure = 'requires a configured demo username';
    if (typeof email !== 'string' || !email.trim() || email.length > 254 || /[\r\n]/.test(email)) {
      throw new Error();
    }
    failure = 'requires an effective demo_password credential (1-256 characters)';
    if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
      throw new Error();
    }

    failure = 'could not prepare private request files';
    signals.forEach(signal => process.on(signal, cancel));
    // Also cover files curl may recreate while saving its cookie jar.
    previousUmask = process.umask(0o077);
    directory = mkdtempSync(join(tempRoot, 'awsops-authenticated-smoke-'));
    chmodSync(directory, 0o700);
    const payload = join(directory, 'login.json');
    const jar = join(directory, 'cookies.txt');
    for (const [file, contents] of [
      [payload, JSON.stringify({ email, password })], [jar, ''],
    ]) {
      writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
    }
    const commonArgs = [
      '-q', '-sS', ...connectionArgs, '--proto', '=https', '--max-redirs', '0',
      '--write-out', '%{http_code}',
    ];
    const options = {
      encoding: 'utf8', timeout: 35_000,
      maxBuffer: 64 * 1024, signal: controller.signal,
      // Do not pass the step's password or other deployment secrets to curl.
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' },
    };
    const recordStatus = stdout => {
      if (typeof stdout === 'string' && /^[1-5][0-9]{2}$/.test(stdout)) failure += `; HTTP status ${stdout}`;
    };
    let requestCounter = 0;
    const request = async (args, path, status = '200', timeout = 35_000,
      maxResponseBytes = MAX_RESPONSE_BYTES, withStatus = false) => {
      if (maxResponseBytes !== MAX_RESPONSE_BYTES
          && !(path.startsWith('/api/inventory/cloudfront?') && maxResponseBytes === MAX_INVENTORY_RESPONSE_BYTES)) {
        throw new Error();
      }
      const response = join(directory, `response-${++requestCounter}.json`);
      writeFileSync(response, '', { mode: 0o600, flag: 'wx' });
      let stdout;
      try {
        ({ stdout } = await runCurl('curl', [
          ...commonArgs, ...(timeout > 35_000 ? ['--max-time', String((timeout - 5000) / 1000)] : []),
          '--max-filesize', String(maxResponseBytes), '--output', response, ...args, `${url.origin}${path}`,
        ], { ...options, timeout }));
      } catch (error) {
        recordStatus(error?.stdout);
        throw new Error();
      }
      recordStatus(stdout);
      if (controller.signal.aborted || !(Array.isArray(status) ? status.includes(stdout) : stdout === status)) throw new Error();
      const body = JSON.parse(readPrivateResponse(response, maxResponseBytes));
      return withStatus ? { httpStatus: Number(stdout), body } : body;
    };
    failure = 'login failed (expected HTTP 200 and ok=true)';
    const login = await request([
      '--request', 'POST', '--header', 'Content-Type: application/json',
      '--data-binary', `@${payload}`, '--cookie-jar', jar,
    ], '/api/auth/login');
    if (login?.ok !== true) throw new Error();
    failure = 'login did not set a usable session cookie';
    if (!hasSessionCookie(readPrivateResponse(jar), url.hostname)) throw new Error();

    failure = 'database verification failed (expected HTTP 200, status=ok and positive safe-integer public_tables)';
    const database = await request(['--request', 'GET', '--cookie', jar], '/api/db');
    if (database?.status !== 'ok' || !Number.isSafeInteger(database.public_tables)
        || database.public_tables <= 0) throw new Error();
    if (runtimeConfig !== undefined) {
      failure = 'runtime verification failed';
      const runtimeResult = await verifyRuntimeSmoke(runtimeConfig, async (path, {
        method = 'GET', body, status = '200', timeout = 35_000, maxResponseBytes, withStatus,
      } = {}) => {
        // Paths and request bodies are generated exclusively by the fixed internal probe.
        failure = path === '/api/accounts' ? 'host_registry_http'
          : path.startsWith('/api/inventory') ? 'inventory_http'
            : path.startsWith('/api/jobs') ? 'worker_http' : 'runtime_http';
        const args = ['--request', method, '--cookie', jar];
        if (body !== undefined) {
          const bodyFile = join(directory, `request-${requestCounter + 1}.json`);
          writeFileSync(bodyFile, JSON.stringify(body), { mode: 0o600, flag: 'wx' });
          args.push('--header', 'Content-Type: application/json', '--data-binary', `@${bodyFile}`);
        }
        return request(args, path, status, timeout, maxResponseBytes, withStatus);
      }, { wait: ms => delay(ms, undefined, { signal: controller.signal }) });
      return { ...runtimeResult, public_tables: database.public_tables };
    }
    return { status: 'ok', public_tables: database.public_tables };
  } catch (error) {
    // Never expose curl exceptions, response bodies, credentials or cookies.
    if (error instanceof RuntimeSmokeError) throw new SmokeError(error.message);
    throw new SmokeError(`Authenticated smoke: ${failure}`);
  } finally {
    signals.forEach(signal => process.removeListener(signal, cancel));
    if (previousUmask !== undefined) process.umask(previousUmask);
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        throw new SmokeError('Authenticated smoke: could not remove private request files');
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.env.SMOKE_CREDENTIAL_FILE;
  let completedMode;
  try {
    if (process.argv.length !== 2) {
      throw new SmokeError('Authenticated smoke: configuration requires a private credential file and URL environment variables');
    }
    let credentials;
    try {
      credentials = readSmokeCredentials(file);
    } catch {
      throw new SmokeError('Authenticated smoke: could not read private credentials');
    }
    const completed = await authenticatedSmoke({
      publicUrl: process.env.PUBLIC_URL,
      cloudfrontDomain: process.env.CLOUDFRONT_DOMAIN,
      email: credentials?.email,
      password: credentials?.password,
      runtimeConfig: process.env.SMOKE_RUNTIME_CONFIG_FILE === undefined ? undefined
        : readRuntimeSmokeConfig(process.env.SMOKE_RUNTIME_CONFIG_FILE, file),
    }, {
      // The existing always() credential cleanup also owns scratch after SIGKILL.
      tempRoot: dirname(file),
    });
    completedMode = completed.mode;
  } catch (error) {
    console.error(error instanceof SmokeError || error instanceof RuntimeSmokeError ? error.message : 'Authenticated smoke: failed');
    process.exitCode = 1;
  } finally {
    try {
      cleanupSmokeCredentials(file);
    } catch {
      console.error('Authenticated smoke: could not remove private credentials');
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log(completedMode === 'verify' ? 'Authenticated full runtime smoke passed.'
    : completedMode === 'prepare' ? 'Authenticated host registry preparation passed.' : 'Authenticated database smoke passed.');
}
