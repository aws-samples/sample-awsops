import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readFile, copyFile, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../../..', import.meta.url));
function workflow(file) {
  // PyYAML is already a required CI test dependency; no package/network install.
  return JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,yaml; d=yaml.safe_load(open(sys.argv[1])); d["on"]=d.pop(True,d.get("on")); print(json.dumps(d))',
    join(root, '.github/workflows', file)], { encoding: 'utf8' }));
}
function step(file, job, name) {
  return workflow(file).jobs[job].steps.find(v => v.name === name);
}
async function shell(script, env = {}, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'migration-workflow-'));
  try {
    for (const folder of ['bin', 'terraform/foundation', 'scripts/v2/ci', 'temp']) {
      await mkdir(join(dir, folder), { recursive: true });
    }
    await copyFile(new URL('./run-migration.mjs', import.meta.url), join(dir, 'scripts/v2/ci/run-migration.mjs'));
    await writeFile(join(dir, 'bin/terraform'), `#!/usr/bin/env python3
import json,os,sys
with open(os.environ["CALLS"],"a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")
assert "DEV_TFVARS_B64" not in os.environ and "DEV_BACKEND_B64" not in os.environ
if os.environ.get("TF_FAIL") == "1":
 print("SECRET contents intentionally malicious",file=sys.stderr)
 sys.exit(1)
if "output" in sys.argv: print("null")
`, { mode: 0o755 });
    for (const [path, text] of Object.entries(files)) await writeFile(join(dir, path), text);
    const environment = {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      RUNNER_TEMP: join(dir, 'temp'), TF_DATA_DIR: join(dir, 'temp/tf'),
      GITHUB_OUTPUT: join(dir, 'output'), GITHUB_ENV: join(dir, 'env'),
      GITHUB_REPOSITORY: 'aws-samples/sample-awsops',
      GITHUB_REF: 'refs/heads/dev', GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
      CALLS: join(dir, 'calls'), ...env,
    };
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: dir, env: environment, encoding: 'utf8', timeout: 15_000,
    });
    return {
      ...result,
      output: await readFile(join(dir, 'output'), 'utf8').catch(() => ''),
      calls: (await readFile(join(dir, 'calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse),
      remaining: await readdir(join(dir, 'terraform/foundation')),
    };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('migration workflow is manual-only and rejects non-dev/non-samples runs before privileged jobs', async () => {
  const w = workflow('deploy-migrations.yml');
  assert.deepEqual(Object.keys(w.on), ['workflow_dispatch']);
  for (const invalid of [{ GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REF: 'refs/tags/dev' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REPOSITORY: 'other/repository' }]) {
    const result = await shell(w.jobs.guard.steps[0].run, invalid);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  }
  assert.equal((await shell(w.jobs.guard.steps[0].run)).status, 0);
  assert.deepEqual(w.jobs.build.needs, ['guard']);
  assert.deepEqual(w.jobs.migrate.needs, ['guard', 'build']);
  assert.equal(w.jobs.migrate.environment, 'development');
  assert.equal(w.concurrency['cancel-in-progress'], false);
});

test('build and execution use fixed development credentials and the ARM64 build output digest', () => {
  const w = workflow('deploy-migrations.yml');
  const build = w.jobs.build.steps;
  const migrate = w.jobs.migrate.steps;
  assert.equal(build.find(s => s.uses?.startsWith('aws-actions/configure-aws-credentials')).with['role-to-assume'],
    '${{ secrets.AWS_CI_BUILD_DEV_ROLE_ARN }}');
  assert.equal(migrate.find(s => s.uses?.startsWith('aws-actions/configure-aws-credentials')).with['role-to-assume'],
    '${{ secrets.AWS_CI_DEPLOYER_DEV_ROLE_ARN }}');
  const image = build.find(s => s.uses?.startsWith('docker/build-push-action'));
  assert.equal(image.with.platforms, 'linux/arm64');
  assert.equal(image.with.context, '.');
  assert.equal(image.with.file, 'scripts/v2/ci/Dockerfile.migration');
  assert.match(image.with.tags, /:migration-\$\{\{ github.sha \}\}$/);
  assert.equal(w.jobs.build.outputs.digest, '${{ steps.image.outputs.digest }}');
  // Account IDs are masked by OIDC: an image URI job output would be suppressed
  // by GitHub's secret-output filter. The digest is the only image handoff.
  assert.deepEqual(Object.keys(w.jobs.build.outputs).sort(), ['digest', 'project']);
  assert.equal(w.jobs.migrate.env.MIGRATION_DIGEST, '${{ needs.build.outputs.digest }}');
  assert.equal(migrate.find(s => s.uses?.startsWith('hashicorp/setup-terraform')).with.terraform_version, '1.15.7');
  assert.equal(migrate.find(s => s.name === 'Clean migration run files').if, 'always()');
  assert.equal(build.find(s => s.name === 'Clean development project config').if, 'always()');
  assert.match(migrate.find(s => s.name === 'Stop only this run task if necessary').if, /always\(\)/);
});

test('role validation fails before OIDC for missing or arbitrary build/deployer roles', async () => {
  for (const [job, envName, roleName] of [
    ['build', 'BUILD_ROLE', 'sample-awsops-dev-ci-build'],
    ['migrate', 'MIGRATION_DEPLOY_ROLE_ARN', 'sample-awsops-dev-ci-deployer'],
  ]) {
    const w = workflow('deploy-migrations.yml');
    const steps = w.jobs[job].steps;
    const guard = steps.findIndex(s => s.name === 'Validate development role');
    assert.ok(guard >= 0 && guard < steps.findIndex(s => s.uses?.startsWith('aws-actions/configure-aws-credentials')));
    for (const role of ['', 'arn:aws:iam::123456789012:role/Admin', `arn:aws:iam::123456789012:role/${roleName}`]) {
      const result = await shell(steps[guard].run, { [envName]: role });
      assert.equal(result.status === 0, role.endsWith(roleName));
      assert.deepEqual(result.calls, []);
    }
  }
});

test('build project selection reads only dev tfvars and erases config after success and rejection', async () => {
  const script = step('deploy-migrations.yml', 'build', 'Resolve development project').run;
  for (const text of ['project = "awsops-v2-dev"\ndemo_password = "SECRET"\n',
    'project = "../injected"\ndemo_password = "SECRET"\n', '']) {
    const result = await shell(script, { DEV_TFVARS_B64: Buffer.from(text).toString('base64') });
    assert.equal(result.status === 0, text.includes('"awsops-v2-dev"'));
    if (result.status === 0) assert.equal(result.output, 'project=awsops-v2-dev\n');
    assert.ok(!`${result.stdout}${result.stderr}${result.output}`.includes('SECRET'));
    assert.deepEqual(result.remaining, []);
  }
});

test('migration setup validates the same project, reads only the named output and cleans config on every failure', async () => {
  const script = step('deploy-migrations.yml', 'migrate', 'Read migration output and run').run;
  for (const changes of [{}, { TF_FAIL: '1' }, { MIGRATION_PROJECT: 'another-project' }]) {
    const result = await shell(script, {
      DEV_TFVARS_B64: Buffer.from('project="awsops-v2-dev"\ndemo_password="SECRET"\n').toString('base64'),
      DEV_BACKEND_B64: Buffer.from('bucket="fixture"\n').toString('base64'),
      MIGRATION_PROJECT: 'awsops-v2-dev', ...changes,
    });
    // The stub output is null: even a valid setup must fail closed without launching.
    assert.notEqual(result.status, 0);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('SECRET'));
    assert.deepEqual(result.remaining, []);
    assert.ok(!result.calls.flat().some(v => ['apply', 'plan', 'show', 'console'].includes(v)));
    if (!Object.keys(changes).length) {
      assert.ok(result.calls.some(v => v.slice(-3).join(' ') === 'output -json migration_job'));
    }
  }
});

test('Terraform plan takes the nonsecret flag from dev target (including PR base), defaults other stacks off', async () => {
  const w = workflow('terraform.yml');
  assert.equal(w.jobs.plan.env.TF_VAR_ci_migrations_enabled,
    "${{ (github.base_ref || github.ref_name) == 'dev' && vars.CI_MIGRATIONS_ENABLED_DEV || 'false' }}");
  const script = step('terraform.yml', 'plan', 'terraform plan').run;
  for (const [target, value] of [
    ['dev', 'true'], ['dev', 'false'], ['dev', 'invalid'], ['main', 'false'],
  ]) {
    const result = await shell(script, {
      TF_VAR_ci_migrations_enabled: value, DISPATCH: 'false', TARGET: target,
    }, { 'ci-deployment.tfvars.json': '{"ci_migrations_enabled":false}' });
    assert.equal(result.status === 0, value !== 'invalid', result.stderr);
    if (result.status === 0) {
      assert.equal(result.calls[0].at(-1), `-var=ci_migrations_enabled=${value}`);
      assert.equal(result.calls[0].includes('-var-file=ci-deployment.tfvars.json'), target === 'dev');
    } else assert.deepEqual(result.calls, []);
  }
  const apply = step('terraform.yml', 'apply', 'terraform apply (exact saved plan — never re-planned)').run;
  assert.match(apply, /terraform apply -input=false tfplan/);
  assert.doesNotMatch(apply, /ci_migrations_enabled/);
});
