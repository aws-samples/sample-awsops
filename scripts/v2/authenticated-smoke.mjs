// Authenticate through the deployed BFF/edge, retaining service Host/SNI/TLS
// while service DNS is deferred. curl receives private filenames, never secrets.
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { smokeArgs } from './deployment-smoke.mjs';
import { cleanupSmokeCredentials, readSmokeCredentials } from './prepare-smoke-credentials.mjs';

const execute = promisify(execFile);
class SmokeError extends Error {}

function hasSessionCookie(contents, hostname) {
  return contents.split(/\r?\n/).some(line => {
    // curl retains HttpOnly cookies as specially prefixed Netscape jar rows.
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#')) return false;
    const [domain, subdomains, path, secure, expires, name, value, extra] = line.split('\t');
    const expiry = Number(expires);
    return domain === hostname && subdomains === 'FALSE' && path === '/'
      && secure === 'TRUE' && /^\d+$/.test(expires) && Number.isSafeInteger(expiry)
      && (expiry === 0 || expiry > Date.now() / 1000)
      && name === 'awsops_token' && Boolean(value) && extra === undefined;
  });
}

export async function authenticatedSmoke(
  { publicUrl, cloudfrontDomain, email, password },
  { runCurl = execute, tempRoot = tmpdir() } = {},
) {
  let directory;
  let previousUmask;
  let failure = 'requires an HTTPS service URL and a CloudFront distribution domain';
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  try {
    const healthArgs = smokeArgs(publicUrl, cloudfrontDomain);
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
    const response = join(directory, 'response.json');
    for (const [file, contents] of [
      [payload, JSON.stringify({ email, password })], [jar, ''], [response, ''],
    ]) {
      writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
    }
    const commonArgs = [
      '-q', ...healthArgs.slice(0, -1), '--proto', '=https', '--max-redirs', '0',
      '--output', response, '--write-out', '%{http_code}',
    ];
    const options = {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 35_000,
      maxBuffer: 64 * 1024, signal: controller.signal,
      // Do not pass the step's password or other deployment secrets to curl.
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' },
    };
    const request = async (args, path) => {
      const { stdout } = await runCurl('curl', [...commonArgs, ...args, `${url.origin}${path}`], options);
      if (controller.signal.aborted || stdout !== '200') throw new Error();
      return JSON.parse(readFileSync(response, 'utf8'));
    };
    failure = 'login failed (expected HTTP 200 and ok=true)';
    const login = await request([
      '--request', 'POST', '--header', 'Content-Type: application/json',
      '--data-binary', `@${payload}`, '--cookie-jar', jar,
    ], '/api/auth/login');
    if (login?.ok !== true) throw new Error();
    failure = 'login did not set a usable session cookie';
    if (!hasSessionCookie(readFileSync(jar, 'utf8'), url.hostname)) throw new Error();

    failure = 'database verification failed (expected HTTP 200, status=ok and positive safe-integer public_tables)';
    const database = await request(['--request', 'GET', '--cookie', jar], '/api/db');
    if (database?.status !== 'ok' || !Number.isSafeInteger(database.public_tables)
        || database.public_tables <= 0) throw new Error();
    return { status: 'ok', public_tables: database.public_tables };
  } catch {
    // Never expose curl exceptions, response bodies, credentials or cookies.
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
    await authenticatedSmoke({
      publicUrl: process.env.PUBLIC_URL,
      cloudfrontDomain: process.env.CLOUDFRONT_DOMAIN,
      email: credentials?.email,
      password: credentials?.password,
    });
  } catch (error) {
    console.error(error instanceof SmokeError ? error.message : 'Authenticated smoke: failed');
    process.exitCode = 1;
  } finally {
    try {
      cleanupSmokeCredentials(file);
    } catch {
      console.error('Authenticated smoke: could not remove private credentials');
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log('Authenticated database smoke passed.');
}
