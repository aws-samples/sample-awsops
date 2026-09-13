import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const digest = `sha256:${'b'.repeat(64)}`;

test('dev refuses missing expected account, mutable tag, foreign output or Docker override before build', () => {
  for (const [change, output] of [
    [{ AWS_ACCOUNT_ID_DEV: '' }, ac], [{ AGENT_IMAGE_TAG: 'agent-latest' }, ac],
    [{ DOCKER: 'sudo docker' }, ac], [{}, { ...ac, ecr_uri: `${ac.ecr_uri}-other` }],
    [{}, { ...ac, role_arn: ac.role_arn.replace(account, '999999999999') }],
    [{}, { ...ac, region: 'us-east-1' }],
  ]) {
    const calls = [];
    assert.throws(() => deployAgent({ env: { ...env, ...change },
      run: (cmd, args) => { calls.push([cmd, args]); return JSON.stringify(output); },
      build: () => { calls.push(['build']); return { digest }; } }));
    assert.ok(!calls.some(([cmd]) => ['build', 'aws', 'docker', 'python3'].includes(cmd)));
  }
});

test('dev binds the verified digest into provisioner environment and captures its output', () => {
  const calls = [];
  const result = deployAgent({ env,
    build: options => { assert.equal(options.component, 'agent'); return { digest, architecture: 'arm64' }; },
    run: (cmd, args, options) => {
      calls.push({ cmd, args, options });
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
