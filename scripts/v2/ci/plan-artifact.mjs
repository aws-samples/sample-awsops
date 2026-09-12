// Authenticated encryption: artifacts and public Actions logs must never contain plan plaintext.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { guardPlan, verifyPlanRun } from './guards.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
function command(name, args) {
  try {
    return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 });
  } catch {
    throw new Error(`${name} ${args[0]} failed; output withheld because it may contain plan values`);
  }
}
export function sealPlan(plan, metadata, password, files = {}) {
  if (!password) throw new Error('TF_PLAN_ENC_KEY required');
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ metadata, plan: plan.toString('base64'), files })), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]);
}
export function openPlan(sealed, expected, password) {
  return openBundle(sealed, expected, password).plan;
}
export function openBundle(sealed, expected, password) {
  if (!password) throw new Error('TF_PLAN_ENC_KEY required');
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, sealed.subarray(0, 16), 32), sealed.subarray(16, 28));
  decipher.setAuthTag(sealed.subarray(28, 44));
  const payload = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(44)), decipher.final()]));
  for (const [key, value] of Object.entries(expected)) {
    if (!value || payload.metadata[key] !== value) throw new Error(`Saved-plan ${key} mismatch`);
  }
  for (const name of Object.keys(payload.files ?? {})) {
    if (!/^\.build\/[a-zA-Z0-9_-]+\.zip$/.test(name)) throw new Error('Invalid plan companion path');
  }
  return { plan: Buffer.from(payload.plan, 'base64'), files: payload.files ?? {} };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const metadata = {
      repository: process.env.GITHUB_REPOSITORY, target: process.env.TARGET,
      ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA,
      runId: process.env.PLAN_RUN_ID || process.env.GITHUB_RUN_ID,
      backend: hash(readFileSync('backend.hcl')), tfvars: hash(readFileSync('terraform.tfvars')),
      providers: hash(readFileSync('.terraform.lock.hcl')),
    };
    if (command('git', ['rev-parse', 'HEAD']).trim() !== metadata.sha) throw new Error('Checkout SHA mismatch');
    if (process.argv[2] === 'seal') {
      // archive_file outputs are local files, not embedded in Terraform's binary
      // plan. Restore those exact bytes on apply; do not regenerate/re-plan.
      const files = Object.fromEntries((existsSync('.build') ? readdirSync('.build', { withFileTypes: true }) : [])
        .filter(file => file.isFile() && /^[a-zA-Z0-9_-]+\.zip$/.test(file.name))
        .map(file => [`.build/${file.name}`, readFileSync(`.build/${file.name}`).toString('base64')]));
      writeFileSync('tfplan.enc', sealPlan(readFileSync('tfplan'), metadata, process.env.TF_PLAN_ENC_KEY, files), { mode: 0o600 });
    } else if (process.argv[2] === 'open') {
      if (!/^\d+$/.test(metadata.runId)) throw new Error('Invalid plan run ID');
      const run = JSON.parse(command('gh', ['api', `repos/${metadata.repository}/actions/runs/${metadata.runId}`]));
      verifyPlanRun(run, metadata);
      const { plan, files } = openBundle(readFileSync('tfplan.enc'), metadata, process.env.TF_PLAN_ENC_KEY);
      writeFileSync('tfplan', plan, { mode: 0o600 });
      const json = JSON.parse(command('terraform', ['show', '-json', 'tfplan']));
      guardPlan(json, { reviewedDeletes: process.env.REVIEWED_DELETES === 'true', manualDns: metadata.target === 'dev',
        bootstrapOrigin: process.env.REVIEWED_ORIGIN_BOOTSTRAP === 'true', enforceFrozenFlags: true });
      mkdirSync('.build', { recursive: true, mode: 0o700 });
      for (const [name, bytes] of Object.entries(files)) writeFileSync(name, Buffer.from(bytes, 'base64'), { mode: 0o600 });
    } else throw new Error('Expected seal or open');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
