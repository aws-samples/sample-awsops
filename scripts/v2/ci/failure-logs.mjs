#!/usr/bin/env node
// Persist only known diagnostics outside checkout/RUNNER_TEMP cleanup; upload ciphertext only.
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, chmodSync, rmSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { sealPlan, openPlan } from './plan-artifact.mjs';
process.umask(0o077);
const names = ['tfplan.log', 'last-error.log'];
const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};
try {
  if (process.argv[2] === 'open') {
    const logs = JSON.parse(openPlan(readFileSync(process.argv[3]), { kind: 'failure-diagnostics' }, process.env.TF_PLAN_ENC_KEY));
    const destination = resolve(process.argv[4]);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    chmodSync(destination, 0o700);
    for (const [name, text] of Object.entries(logs)) {
      if (!names.includes(name) || typeof text !== 'string') throw new Error('Invalid diagnostic entry');
      writeFileSync(join(destination, name), text, { mode: 0o600 });
    }
    console.log('Diagnostics decrypted into the requested private directory.');
  } else {
    const paths = ['terraform/foundation/tfplan.log', 'terraform/foundation/.build/ci/last-error.log'];
    const logs = Object.fromEntries(paths.flatMap((path, i) => existsSync(path) ? [[names[i], readFileSync(path, 'utf8')]] : []));
    output('encrypted', 'false');
    if (Object.keys(logs).length) {
      const parent = process.env.RUNNER_TEMP
        ? resolve(process.env.RUNNER_TEMP, '..', '.awsops-private-diagnostics')
        : join(homedir(), '.cache', 'awsops-private-diagnostics');
      mkdirSync(parent, { recursive: true, mode: 0o700 }); chmodSync(parent, 0o700);
      const retained = mkdtempSync(join(parent, 'failure-'));
      output('retained_dir', retained);
      // Retain raw evidence even if the key is missing or encryption fails.
      for (const [name, text] of Object.entries(logs)) writeFileSync(join(retained, name), text, { mode: 0o600 });
      const metadata = { kind: 'failure-diagnostics', repository: process.env.GITHUB_REPOSITORY,
        sha: process.env.PLAN_SOURCE_SHA || process.env.GITHUB_SHA, ref: process.env.GITHUB_REF,
        runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB };
      writeFileSync(join(retained, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
      if (!process.env.TF_PLAN_ENC_KEY) throw new Error(`Missing TF_PLAN_ENC_KEY; diagnostics retained privately at ${retained}`);
      const path = join(retained, 'diagnostics.enc');
      writeFileSync(path, sealPlan(Buffer.from(JSON.stringify(logs)), metadata, process.env.TF_PLAN_ENC_KEY), { mode: 0o600 });
      for (const name of Object.keys(logs)) rmSync(join(retained, name));
      output('path', path); output('encrypted', 'true');
      console.log(`Encrypted failure diagnostics retained at ${retained}; upload them before checkout cleanup.`);
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
