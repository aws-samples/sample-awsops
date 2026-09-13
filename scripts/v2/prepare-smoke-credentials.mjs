// Resolve the restored stack's effective Terraform inputs before image pinning.
// Terraform diagnostics can include tfvars secrets: capture them, never relay them.
import { execFile } from 'node:child_process';
import { appendFileSync, chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

class CredentialError extends Error {}
const tempRoot = () => resolve(process.env.RUNNER_TEMP || tmpdir());
const validUsername = value => typeof value === 'string' && value.length > 0
  && value.length <= 254 && !/[\s\u0000-\u001f\u007f]/u.test(value);

function credentialDirectory(file) {
  if (typeof file !== 'string' || !isAbsolute(file) || basename(file) !== 'credentials.json'
      || dirname(dirname(file)) !== tempRoot()
      || !/^awsops-smoke-credentials-[a-zA-Z0-9]+$/.test(basename(dirname(file)))) {
    throw new CredentialError('Demo credential preparation: invalid private credential path');
  }
  return dirname(file);
}

export function readSmokeCredentials(file) {
  const directory = credentialDirectory(file);
  const dir = lstatSync(directory);
  const info = lstatSync(file);
  if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700
      || !info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024) {
    throw new CredentialError('Demo credential preparation: credential file must be private');
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function cleanupSmokeCredentials(file) {
  if (!file) return; // Preparation failed before publishing a path.
  const directory = credentialDirectory(file);
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    throw new CredentialError('Demo credential preparation: could not remove private credentials');
  }
}

async function prepareCredentials() {
  let directory;
  let ready = false;
  let failure = 'could not prepare private credential storage';
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  signals.forEach(signal => process.on(signal, cancel));
  try {
    directory = mkdtempSync(join(tempRoot(), 'awsops-smoke-credentials-'));
    chmodSync(directory, 0o700);
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith('TF_LOG') && !key.startsWith('TF_CLI_ARGS')));
    const terraform = (args, input = '') => new Promise((accept, reject) => {
      const child = execFile('terraform', args, {
        env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
        signal: controller.signal, stdio: ['pipe', 'pipe', 'pipe'],
      }, (error, stdout) => {
        if (error || controller.signal.aborted) reject(new Error());
        else accept(stdout);
      });
      // The expression is fixed and contains no credential literals. EOF also
      // prevents missing variables from turning the console into a CI prompt.
      child.stdin.on('error', () => {}); // Early Terraform exit is handled above.
      child.stdin.end(input);
    });
    failure = 'could not initialize the restored Terraform configuration';
    await terraform(['init', '-backend-config=backend.hcl', '-input=false', '-no-color']);
    failure = 'requires the applied demo_username Terraform output';
    const username = JSON.parse(await terraform(['output', '-json', 'demo_username']));
    if (!validUsername(username)) throw new Error();

    failure = 'could not evaluate the restored demo configuration';
    // The shared default is TF_VAR_demo_password; Terraform itself applies
    // tfvars precedence. console has no -input=false or -lock=false flags.
    const encoded = await terraform(['console', '-no-color'],
      'nonsensitive(jsonencode({enabled=var.create_demo_user,email=var.demo_email,password=var.demo_password}))\n');
    const configured = JSON.parse(JSON.parse(encoded));
    failure = 'requires an enabled demo identity matching applied demo_username';
    if (configured?.enabled !== true || !validUsername(configured.email)
        || configured.email !== username) throw new Error();
    failure = 'requires an effective demo_password credential (1-256 characters)';
    if (typeof configured.password !== 'string' || configured.password.length === 0
        || configured.password.length > 256) throw new Error();

    failure = 'could not write private credentials';
    const file = join(directory, 'credentials.json');
    writeFileSync(file, JSON.stringify({ email: username, password: configured.password }), {
      mode: 0o600, flag: 'wx',
    });
    failure = 'could not publish the private credential path';
    appendFileSync(process.env.GITHUB_OUTPUT, `credential_file=${file}\n`);
    ready = true;
  } catch {
    throw new CredentialError(`Demo credential preparation: ${failure}`);
  } finally {
    signals.forEach(signal => process.removeListener(signal, cancel));
    if (directory && !ready) cleanupSmokeCredentials(join(directory, 'credentials.json'));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--cleanup') {
      cleanupSmokeCredentials(process.env.SMOKE_CREDENTIAL_FILE);
    } else if (process.argv.length === 2) {
      await prepareCredentials();
    } else {
      throw new CredentialError('Demo credential preparation: invalid arguments');
    }
  } catch (error) {
    console.error(error instanceof CredentialError ? error.message : 'Demo credential preparation: failed');
    process.exitCode = 1;
  }
}
