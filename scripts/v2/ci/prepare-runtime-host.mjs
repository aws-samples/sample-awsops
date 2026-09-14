// A configured host must be observable before a full runtime activation can plan.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { authenticatedSmoke } from '../authenticated-smoke.mjs';
import { readSmokeCredentials, cleanupSmokeCredentials } from '../prepare-smoke-credentials.mjs';

export async function prepareRuntimeHost(env, {
  authenticate = authenticatedSmoke, readCredentials = readSmokeCredentials,
  cleanup = cleanupSmokeCredentials,
  output = name => execFileSync('terraform', ['output', '-raw', name], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 65_536, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim(),
} = {}) {
  try {
    if (env.TARGET !== 'dev' || env.CI_READONLY_RUNTIME_DEV !== 'true' ||
        env.PLAN_SCOPE !== 'full' || !/^[0-9]{12}$/.test(env.AWS_ACCOUNT_ID_DEV || '')) {
      throw new Error('invalid_context');
    }
    const credentials = readCredentials(env.SMOKE_CREDENTIAL_FILE);
    const result = await authenticate({
      publicUrl: output('public_url'), cloudfrontDomain: output('cloudfront_domain'),
      email: credentials.email, password: credentials.password,
      runtimeConfig: { schemaVersion: 1, mode: 'prepare', hostOnly: true,
        expectedAccountId: env.AWS_ACCOUNT_ID_DEV },
    }, { tempRoot: dirname(env.SMOKE_CREDENTIAL_FILE) });
    if (result?.status !== 'ok' || result.mode !== 'prepare') throw new Error('proof_missing');
    return { host_registry: 'verified' };
  } catch {
    // The only output is a fixed code; no URLs, credential/HTTP bodies or Terraform errors.
    throw new Error('runtime_host_preparation_failed');
  } finally {
    cleanup(env.SMOKE_CREDENTIAL_FILE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error();
    console.log(JSON.stringify(await prepareRuntimeHost(process.env)));
  } catch {
    console.error('::error::runtime_host_preparation_failed');
    process.exitCode = 1;
  }
}
