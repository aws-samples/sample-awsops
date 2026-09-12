import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./plan-artifact.mjs', import.meta.url));
test('encrypted saved plan carries generated Lambda ZIPs across a clean checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'awsops-plan-'));
  try {
    mkdirSync(join(root, 'terraform/foundation/.build'), { recursive: true });
    const cwd = join(root, 'terraform/foundation');
    for (const [file, value] of Object.entries({
      'backend.hcl': 'backend', 'terraform.tfvars': 'config', '.terraform.lock.hcl': 'providers',
      tfplan: 'binary plan with secret', '.build/cognito_edge.zip': 'generated Lambda with secret',
    })) writeFileSync(join(cwd, file), value);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const bin = join(root, 'bin'); mkdirSync(bin);
    const run = { id: 123, event: 'push', status: 'completed', conclusion: 'success', head_sha: sha,
      head_branch: 'dev', path: '.github/workflows/terraform.yml', repository: { full_name: 'owner/repo' } };
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(run)}'\n`, { mode: 0o700 });
    writeFileSync(join(bin, 'terraform'), '#!/bin/sh\nprintf \'{"resource_changes":[],"variables":{"remediation_enabled":{"value":false}}}\'\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo',
      TARGET: 'dev', GITHUB_REF: 'refs/heads/dev', GITHUB_SHA: sha, GITHUB_RUN_ID: '123',
      TF_PLAN_ENC_KEY: 'test-key-only-not-an-actual-credential' };
    const invoke = phase => spawnSync(process.execPath, [script, phase], { cwd, env, encoding: 'utf8' });
    const sealed = invoke('seal'); assert.equal(sealed.status, 0, sealed.stderr);
    assert.ok(!readFileSync(join(cwd, 'tfplan.enc')).includes(Buffer.from('secret')));
    rmSync(join(cwd, '.build'), { recursive: true }); rmSync(join(cwd, 'tfplan'));
    env.PLAN_RUN_ID = '123';
    const opened = invoke('open'); assert.equal(opened.status, 0, opened.stderr);
    assert.equal(readFileSync(join(cwd, 'tfplan'), 'utf8'), 'binary plan with secret');
    assert.equal(readFileSync(join(cwd, '.build/cognito_edge.zip'), 'utf8'), 'generated Lambda with secret');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
