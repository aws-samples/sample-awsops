import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deployAgent } from '../agentcore.mjs';

const account = '123456789012';
const env = {
  TARGET: 'dev', GITHUB_REPOSITORY: 'aws-samples/sample-awsops', GITHUB_REF: 'refs/heads/dev',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40),
  AWS_ACCOUNT_ID_DEV: account, AWS_REGION: 'ap-northeast-2',
  RUNTIME_ROLE_ARN: `arn:aws:iam::${account}:role/DeployRole`,
  AGENT_IMAGE_TAG: `agent-${'a'.repeat(40)}`, DOCKER: 'docker',
};
const ac = {
  project: 'awsops-dev', region: 'ap-northeast-2',
  role_arn: `arn:aws:iam::${account}:role/RuntimeRole`,
  ecr_uri: `${account}.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-dev-agentcore`,
};
const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { digest: `sha256:${'b'.repeat(64)}` }, layers: [] });
const digest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;

test('dev refuses missing expected account, mutable tag, foreign output or Docker override before build', () => {
  for (const [change, output] of [
    [{ AWS_ACCOUNT_ID_DEV: '' }, ac], [{ AGENT_IMAGE_TAG: 'agent-latest' }, ac],
    [{ DOCKER: 'sudo docker' }, ac], [{}, { ...ac, ecr_uri: `${ac.ecr_uri}-other` }],
    [{}, { ...ac, role_arn: ac.role_arn.replace(account, '999999999999') }],
    [{}, { ...ac, region: 'us-east-1' }],
  ]) {
    const calls = [];
    assert.throws(() => deployAgent({ env: { ...env, ...change }, phase: 'build',
      run: (cmd, args) => { calls.push([cmd, args]); return JSON.stringify(output); },
      build: () => { calls.push(['build']); return { digest }; } }));
    assert.ok(!calls.some(([cmd]) => ['build', 'aws', 'docker', 'python3'].includes(cmd)));
  }
});

test('dev binds the verified digest into provisioner environment and captures its output', () => {
  const calls = [];
  const result = deployAgent({ env: { ...env, AGENT_IMAGE_PROJECT: ac.project, AGENT_IMAGE_DIGEST: digest },
    phase: 'provision', build: () => assert.fail('must not rebuild'),
    run: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (args[0] === 'sts') return JSON.stringify({
        Account: account, Arn: `arn:aws:sts::${account}:assumed-role/DeployRole/FreshSession`,
      });
      if (args[0] === 'ecr') return JSON.stringify({ failures: [], images: [{
        registryId: account, repositoryName: `${ac.project}-agentcore`,
        imageId: { imageTag: env.AGENT_IMAGE_TAG, imageDigest: digest }, imageManifest: manifest,
      }] });
      return cmd === 'terraform' ? JSON.stringify(ac) : JSON.stringify({
        event: 'agentcore_provision_summary', stage: 'complete', counts: { ERR: 0 }, dropped: 0,
      });
    } });
  assert.equal(result.digest, digest);
  const provision = calls.find(c => c.cmd === 'python3');
  assert.equal(provision.options.env.AGENT_IMAGE_DIGEST, digest);
  assert.deepEqual(provision.args, ['scripts/v2/agentcore/provision.py']);
  assert.deepEqual(provision.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(calls.filter(c => c.cmd === 'terraform').length, 1);
  assert.deepEqual(calls[0].args.slice(-3), ['output', '-json', 'agentcore']);
});
