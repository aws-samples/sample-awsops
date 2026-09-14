import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deployAgent, parseAgentArguments } from '../agentcore.mjs';
import { TIMEOUTS } from './runtime-build.mjs';

const account = '123456789012', sha = 'a'.repeat(40), project = 'awsops-dev';
const env = {
  TARGET: 'dev', GITHUB_REPOSITORY: 'aws-samples/sample-awsops', GITHUB_REF: 'refs/heads/dev',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: sha, AWS_ACCOUNT_ID_DEV: account,
  AWS_REGION: 'ap-northeast-2', RUNTIME_ROLE_ARN: `arn:aws:iam::${account}:role/DeployRole`,
  AGENT_IMAGE_TAG: `agent-${sha}`, DOCKER: 'docker',
};
const ac = { project, region: env.AWS_REGION, role_arn: `arn:aws:iam::${account}:role/RuntimeRole`,
  ecr_uri: `${account}.dkr.ecr.${env.AWS_REGION}.amazonaws.com/${project}-agentcore` };
const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { digest: `sha256:${'c'.repeat(64)}` }, layers: [] });
const digest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
const receipt = { ...env, AGENT_IMAGE_DIGEST: digest, AGENT_IMAGE_PROJECT: project };
const summary = JSON.stringify({ event: 'agentcore_provision_summary', stage: 'complete',
  counts: { ERR: 0 }, dropped: 0 });

function fixture(changes = {}) {
  const calls = [];
  const run = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === 'terraform') return JSON.stringify(changes.ac || ac);
    if (args[0] === 'sts') return JSON.stringify(changes.caller || {
      Account: account, Arn: `arn:aws:sts::${account}:assumed-role/DeployRole/FreshSession`,
    });
    if (args[0] === 'ecr') return JSON.stringify(changes.image || { images: [{
      registryId: account, repositoryName: `${project}-agentcore`,
      imageId: { imageTag: env.AGENT_IMAGE_TAG, imageDigest: digest }, imageManifest: manifest,
    }], failures: [] });
    if (cmd === 'python3') return summary;
    throw new Error('unexpected tool');
  };
  return { calls, run };
}

test('dev build-only returns the verified handoff without provisioning', () => {
  const f = fixture();
  let builds = 0;
  const value = deployAgent({ env, phase: 'build', run: f.run, build: args => {
    builds++; assert.equal(args.project, project);
    return { project, digest, architecture: 'arm64' };
  } });
  assert.deepEqual(value, { project, digest, architecture: 'arm64' });
  assert.equal(builds, 1);
  assert.ok(!f.calls.some(c => c.cmd === 'python3'));
});

test('provision-only rechecks the fresh caller and same commit digest, without a rebuild', () => {
  const f = fixture();
  const value = deployAgent({ env: receipt, phase: 'provision', run: f.run,
    report: () => {}, build: () => assert.fail('must not rebuild') });
  assert.equal(value.digest, digest);
  assert.equal(f.calls.filter(c => c.cmd === 'python3').length, 1);
  const python = f.calls.find(c => c.cmd === 'python3');
  assert.equal(python.options.env.AGENT_IMAGE_DIGEST, digest);
  assert.equal(python.options.timeout, TIMEOUTS.provision);
  const ecr = f.calls.find(c => c.args[0] === 'ecr');
  assert.ok(ecr.args.includes(`imageTag=agent-${sha}`));
  assert.ok(f.calls.findIndex(c => c.args[0] === 'sts') < f.calls.indexOf(ecr));
  assert.ok(f.calls.indexOf(ecr) < f.calls.indexOf(python));
});

test('missing/malformed handoff, changed project, wrong caller, tag or digest prevents provision', () => {
  const wrongImage = { images: [{
    registryId: account, repositoryName: `${project}-agentcore`,
    imageId: { imageTag: `agent-${'d'.repeat(40)}`, imageDigest: digest }, imageManifest: manifest,
  }], failures: [] };
  for (const [override, changes] of [
    [{ AGENT_IMAGE_DIGEST: '' }, {}], [{ AGENT_IMAGE_PROJECT: '' }, {}],
    [{ AGENT_IMAGE_DIGEST: `sha256:${'f'.repeat(64)}` }, {}],
    [{ AGENT_IMAGE_PROJECT: 'other-project' }, {}],
    [{}, { caller: { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/OtherRole/FreshSession` } }],
    [{}, { image: wrongImage }],
  ]) {
    const f = fixture(changes);
    assert.throws(() => deployAgent({ env: { ...receipt, ...override }, phase: 'provision',
      run: f.run, report: () => {}, build: () => assert.fail('must not rebuild') }));
    assert.ok(!f.calls.some(c => c.cmd === 'python3'));
  }
});

test('read time consumes the provision phase budget before the child is started', () => {
  let elapsed = 0;
  const f = fixture();
  assert.throws(() => deployAgent({ env: receipt, phase: 'provision', now: () => elapsed,
    run: (cmd, args, options) => {
      const result = f.run(cmd, args, options);
      if (args[0] === 'ecr') elapsed = TIMEOUTS.provisionPhase + 1;
      return result;
    }, report: () => {}, build: () => assert.fail('must not rebuild'),
  }), /provision_phase_timeout/);
  assert.ok(!f.calls.some(c => c.cmd === 'python3'));
});

test('dev refuses the old combined path; non-dev retains the default CLI contract', () => {
  assert.throws(() => deployAgent({ env, run: () => assert.fail('no tools before phase guard') }),
    /dev_phase_required/);
  assert.deepEqual(parseAgentArguments([]), { phase: undefined, smoke: false });
  assert.deepEqual(parseAgentArguments(['--smoke']), { phase: undefined, smoke: true });
  assert.deepEqual(parseAgentArguments(['--build-only']), { phase: 'build', smoke: false });
  assert.deepEqual(parseAgentArguments(['--provision-only', '--smoke']), { phase: 'provision', smoke: true });
  for (const args of [['--build-only', '--provision-only'], ['--build-only', '--smoke'], ['--unknown']]) {
    assert.throws(() => parseAgentArguments(args));
  }
});
