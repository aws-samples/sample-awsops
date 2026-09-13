import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command, TIMEOUTS, RuntimeBuildError, verifyRepository } from './runtime-build.mjs';
import { deployAgent, emitProvisionReport } from '../agentcore.mjs';

const account = '123456789012';
const plan = { account, repository: 'fixture-worker', tag: `worker-${'a'.repeat(40)}` };

test('repository preflight uses the existing BatchGetImage result, not DescribeRepositories', () => {
  assert.doesNotThrow(() => verifyRepository(plan, { images: [], failures: [{
    imageId: { imageTag: plan.tag }, failureCode: 'ImageNotFound', failureReason: 'PRIVATE',
  }] }));
  for (const value of [
    {}, { images: [], failures: [] },
    { images: [], failures: [{ imageId: { imageTag: 'other' }, failureCode: 'ImageNotFound' }] },
    { images: [], failures: [{ imageId: { imageTag: plan.tag }, failureCode: 'AccessDenied' }] },
  ]) assert.throws(() => verifyRepository(plan, value));
});

test('read/build/provision budgets differ and timeout/failure exit status is retained without stderr', () => {
  assert.equal(TIMEOUTS.read, 120_000);
  assert.ok(TIMEOUTS.build > 20 * 60_000);
  assert.ok(TIMEOUTS.provision > TIMEOUTS.build);
  let options;
  command('aws', ['sts', 'get-caller-identity'], {
    spawn: (_cmd, _args, value) => { options = value; return { status: 0, stdout: '{}' }; },
  });
  assert.equal(options.timeout, TIMEOUTS.read);
  assert.throws(() => command('aws', [], {
    spawn: () => ({ status: 254, stdout: '', stderr: 'An error occurred (AccessDeniedException): PRIVATE' }),
  }), e => e instanceof RuntimeBuildError && e.message === 'aws_access_denied' && e.exitCode === 254);
  assert.throws(() => command('docker', ['buildx'], {
    timeout: TIMEOUTS.build, spawn: () => ({ error: { code: 'ETIMEDOUT' }, stdout: 'SAFE' }),
  }), e => e.message === 'tool_timeout' && e.exitCode === 124 && e.output === 'SAFE');
});

const summary = { event: 'agentcore_provision_summary', stage: 'complete',
  counts: { SKIP: 1, ERR: 0 }, dropped: 0 };
const record = { event: 'agentcore_provision_result', stage: 'mcp_targets', kind: 'target',
  key: 'datadog-mcp-server-target', status: 'SKIP', code: 'runtime_allowlist_unconfirmed' };

test('only bounded structured provision events are relayed, including attributable skips and counts', () => {
  const lines = [];
  emitProvisionReport(['PRIVATE arbitrary stdout', JSON.stringify(record), JSON.stringify(summary)].join('\n'),
    { write: value => lines.push(value) });
  assert.equal(lines.length, 2);
  assert.ok(lines.some(line => line.includes('datadog-mcp-server-target')));
  assert.ok(!lines.join('').includes('PRIVATE'));
  assert.throws(() => emitProvisionReport('PRIVATE', { write: () => {} }), /provision_report_missing/);
});

test('main smoke still reaches provisioning without development runtime metadata', () => {
  const calls = [];
  deployAgent({
    env: { TARGET: 'main', AWS_REGION: 'us-east-1' }, smoke: true,
    run: () => JSON.stringify({ region: 'us-east-1', project: 'fixture',
      ecr_uri: `${account}.dkr.ecr.us-east-1.amazonaws.com/fixture-agentcore` }),
    legacyRun: cmd => calls.push(cmd),
  });
  assert.equal(calls.length, 3);
  assert.match(calls[2], /provision.py --smoke/);
});

test('dev emits the failed provision stage and propagates child exit code instead of discarding stdout', () => {
  const env = {
    TARGET: 'dev', GITHUB_REPOSITORY: 'aws-samples/sample-awsops', GITHUB_REF: 'refs/heads/dev',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40),
    AWS_ACCOUNT_ID_DEV: account, AWS_REGION: 'ap-northeast-2',
    RUNTIME_ROLE_ARN: `arn:aws:iam::${account}:role/DeployRole`,
    DOCKER: 'docker', AGENT_IMAGE_TAG: `agent-${'a'.repeat(40)}`,
  };
  const lines = [];
  const output = JSON.stringify({ ...record, status: 'ERR', code: 'aws_access_denied' }) + '\n' +
    JSON.stringify({ ...summary, counts: { ERR: 1 } });
  assert.throws(() => deployAgent({ env,
    build: () => ({ architecture: 'arm64', digest: `sha256:${'b'.repeat(64)}` }),
    report: text => emitProvisionReport(text, { write: value => lines.push(value), required: false }),
    run: (cmd, _args, options) => {
      if (cmd === 'terraform') return JSON.stringify({ project: 'fixture', region: env.AWS_REGION,
        role_arn: `arn:aws:iam::${account}:role/RuntimeRole`,
        ecr_uri: `${account}.dkr.ecr.ap-northeast-2.amazonaws.com/fixture-agentcore` });
      assert.equal(options.timeout, TIMEOUTS.provision);
      throw new RuntimeBuildError('tool_execution_failed', { exitCode: 7, output });
    },
  }), e => e.exitCode === 7);
  assert.ok(lines.join('\n').includes('aws_access_denied'));
});
