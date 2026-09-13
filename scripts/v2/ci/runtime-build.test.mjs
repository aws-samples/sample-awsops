import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRole, verifyCaller, imagePlan, verifyManifest, buildImage, TIMEOUTS,
} from './runtime-build.mjs';

const account = '123456789012';
const role = `arn:aws:iam::${account}:role/platform/BuildRole`;
const env = {
  GITHUB_REPOSITORY: 'aws-samples/sample-awsops', GITHUB_REF: 'refs/heads/dev',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40),
  AWS_ACCOUNT_ID_DEV: account, AWS_REGION: 'ap-northeast-2', RUNTIME_ROLE_ARN: role,
};
const caller = { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/BuildRole/GitHubActions` };
const configDigest = `sha256:${'b'.repeat(64)}`;
const manifest = JSON.stringify({
  schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { digest: configDigest }, layers: [],
});
const digest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
const plan = () => imagePlan(env, 'awsops-dev', 'steampipe');
function remote(p = plan()) {
  return { images: [{
    registryId: account, repositoryName: p.repository,
    imageId: { imageTag: p.tag, imageDigest: digest }, imageManifest: manifest,
  }], failures: [] };
}

test('dev context and independently configured account fail before any AWS or Docker command', () => {
  for (const invalid of [
    { AWS_ACCOUNT_ID_DEV: '' }, { AWS_ACCOUNT_ID_DEV: '999999999999' },
    { RUNTIME_ROLE_ARN: '' }, { RUNTIME_ROLE_ARN: role.replace(':role/', ':user/') },
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'workflow_call' }, { GITHUB_REPOSITORY: 'other/repo' },
    { GITHUB_SHA: 'bad' }, { AWS_REGION: 'us-east-1' },
  ]) {
    const calls = [];
    assert.throws(() => buildImage({ env: { ...env, ...invalid }, project: 'awsops-dev',
      component: 'steampipe', run: (...args) => { calls.push(args); return ''; } }));
    assert.deepEqual(calls, []);
  }
  assert.equal(checkRole(env).account, account);
});

test('STS requires the configured role and independent account, including path-bearing role ARNs', () => {
  assert.doesNotThrow(() => verifyCaller(env, caller));
  for (const value of [
    {}, { ...caller, Account: '999999999999' },
    { ...caller, Arn: caller.Arn.replace('BuildRole', 'OtherRole') },
    { ...caller, Arn: role }, { ...caller, Arn: `${caller.Arn}/extra` },
  ]) assert.throws(() => verifyCaller(env, value));
});

test('only exact project repositories and commit tags are selected', () => {
  for (const component of ['steampipe', 'worker', 'agent']) {
    const p = imagePlan(env, 'awsops-dev', component);
    assert.equal(p.repository, `awsops-dev-${component === 'agent' ? 'agentcore' : component}`);
    assert.equal(p.tag, `${component}-${env.GITHUB_SHA}`);
    assert.ok(p.uri.startsWith(`${account}.dkr.ecr.ap-northeast-2.amazonaws.com/`));
  }
  for (const [project, component] of [['awsops-dev/other', 'worker'], ['awsops-dev', 'web']]) {
    assert.throws(() => imagePlan(env, project, component));
  }
});

test('uploaded single manifest must bind exact repository, commit tag and verified ARM64 config', () => {
  assert.equal(verifyManifest(plan(), remote(), configDigest), digest);
  const variants = [
    r => { r.failures = [{ failureCode: 'ImageNotFound' }]; },
    r => { r.images.push(r.images[0]); },
    r => { r.images[0].registryId = '999999999999'; },
    r => { r.images[0].repositoryName = 'other-repository'; },
    r => { r.images[0].imageId.imageTag = 'latest'; },
    r => { r.images[0].imageId.imageDigest = configDigest; },
    r => { r.images[0].imageManifest = JSON.stringify({ schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }); },
  ];
  for (const change of variants) {
    const r = remote(); change(r);
    assert.throws(() => verifyManifest(plan(), r, configDigest));
  }
  assert.throws(() => verifyManifest(plan(), remote(), `sha256:${'c'.repeat(64)}`));
});

function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-build-test-'));
  mkdirSync(join(dir, 'scripts/v2/workers'), { recursive: true });
  mkdirSync(join(dir, 'scripts/v2/remediation'), { recursive: true });
  writeFileSync(join(dir, 'scripts/v2/workers/Dockerfile'), 'FROM fixture\n');
  for (const name of ['action_catalog.py', 'remediation_executor.py', 'remediation_executor_cli.py']) {
    writeFileSync(join(dir, 'scripts/v2/remediation', name), '# fixture\n');
  }
  const calls = [];
  const p = imagePlan(env, 'awsops-dev', 'worker');
  const run = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args[0] === 'sts') return JSON.stringify(overrides.caller || caller);
    if (args[1] === 'batch-get-image' && !args.includes('--accepted-media-types')) {
      return JSON.stringify({ images: [], failures: [{
        imageId: { imageTag: p.tag }, failureCode: 'ImageNotFound',
      }] });
    }
    if (args[1] === 'get-login-password') return 'SECRET_PASSWORD';
    if (args[0] === 'image' && args[1] === 'inspect') {
      return JSON.stringify([{ Id: configDigest, Architecture: overrides.arch || 'arm64', Os: 'linux' }]);
    }
    if (args[1] === 'batch-get-image') return JSON.stringify(remote(p));
    if (args[0] === 'buildx') {
      for (const name of ['action_catalog.py', 'remediation_executor.py', 'remediation_executor_cli.py']) {
        assert.ok(existsSync(join(args.at(-1), name)));
      }
    }
    if (overrides.failBuild && args[0] === 'buildx') throw new Error('SECRET remote stderr');
    return '';
  };
  return { dir, calls, p, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('worker build stages required modules and verifies image before returning digest-only handoff', () => {
  const f = fixture();
  try {
    const result = buildImage({ env: { ...env, RUNNER_TEMP: f.dir }, project: 'awsops-dev',
      component: 'worker', root: f.dir, run: f.run });
    assert.deepEqual(result, { project: 'awsops-dev', digest, architecture: 'arm64' });
    const build = f.calls.find(c => c.args[0] === 'buildx');
    assert.ok(build.args.includes('--load'));
    assert.ok(build.args.includes('--provenance=false'));
    assert.ok(build.args.includes('--sbom=false'));
    assert.ok(build.args.includes('linux/arm64'));
    assert.ok(build.options.timeout > 20 * 60_000);
    assert.ok(build.args.at(-1).startsWith(f.dir));
    assert.ok(!f.calls.some(c => c.args.some(a => /describe-repositories|create-repository|put-role|:latest$/.test(a))));
    assert.deepEqual(f.calls.find(c => c.args[0] === 'push').args, ['push', `${f.p.uri}:${f.p.tag}`]);
    assert.equal(f.calls.find(c => c.args[0] === 'login').options.input, 'SECRET_PASSWORD');
    assert.ok(!existsSync(build.args.at(-1)));
    assert.ok(!existsSync(build.options.env.DOCKER_CONFIG));
  } finally { f.cleanup(); }
});

test('wrong STS identity or architecture prevents pushes and public errors omit tool output', () => {
  for (const overrides of [
    { caller: { ...caller, Account: '999999999999' } }, { arch: 'amd64' }, { failBuild: true },
  ]) {
    const f = fixture(overrides);
    try {
      assert.throws(() => buildImage({ env: { ...env, RUNNER_TEMP: f.dir }, project: 'awsops-dev',
        component: 'worker', root: f.dir, run: f.run }), e => !e.message.includes('SECRET'));
      assert.ok(!f.calls.some(c => c.args[0] === 'push'));
      if (overrides.caller) assert.equal(f.calls.length, 1);
    } finally { f.cleanup(); }
  }
});

test('the aggregate build budget stops further AWS access before the session can expire', () => {
  const f = fixture();
  let elapsed = 0;
  try {
    assert.throws(() => buildImage({
      env: { ...env, RUNNER_TEMP: f.dir }, project: 'awsops-dev', component: 'worker', root: f.dir,
      now: () => elapsed, run: (cmd, args, options) => {
        const value = f.run(cmd, args, options);
        if (args[1] === 'batch-get-image') elapsed = TIMEOUTS.buildPhase + 1;
        return value;
      },
    }), e => e.message === 'build_phase_timeout' && e.exitCode === 124);
    assert.ok(!f.calls.some(c => c.args[0] === 'push' || c.args[1] === 'get-login-password'));
  } finally { f.cleanup(); }
});
