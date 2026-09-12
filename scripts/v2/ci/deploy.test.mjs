import test from 'node:test';
import assert from 'node:assert/strict';
import { guardPlan, guardBootstrapPlan, selectStage, verifyService, verifyPlanRun, aliasesRegistered } from './guards.mjs';
import { sealPlan, openPlan } from './plan-artifact.mjs';
const change = (type, actions) => ({ address: `${type}.test`, type, mode: 'managed', change: { actions } });

test('automatic deploy rejects replacement, deletion and every DNS write', () => {
  for (const actions of [['delete'], ['delete', 'create'], ['create', 'delete']]) {
    assert.throws(() => guardPlan({ resource_changes: [change('aws_ecs_service', actions)] }), /review/i);
  }
  for (const actions of [['create'], ['update'], ['delete']]) {
    assert.throws(() => guardPlan({ resource_changes: [change('aws_route53_record', actions)] }), /DNS/);
  }
  guardPlan({ resource_changes: [change('aws_ecs_service', ['update']), change('aws_route53_record', ['no-op'])] });
});

test('an existing edge can never fall back to the partial stage', () => {
  assert.equal(selectStage([], false), 'core');
  assert.equal(selectStage([], true), 'edge');
  assert.equal(selectStage(['aws_cloudfront_distribution.main[0]'], false), 'edge');
  assert.equal(selectStage(['aws_lb_listener.https'], false), 'edge');
  assert.equal(selectStage(['aws_acm_certificate_validation.alb[0]'], false), 'edge');
});

test('failed resource checks cannot pass an automatic plan', () => {
  assert.throws(() => guardPlan({ checks: [{ status: 'fail' }] }), /check/i);
});

test('reviewed origin bootstrap exempts only the named managed-SG check', () => {
  const bootstrap = { status: 'fail', address: { to_display: 'check.cf_vpc_origin_sg_present' } };
  assert.throws(() => guardPlan({ checks: [bootstrap] }), /check/i);
  guardPlan({ checks: [bootstrap] }, { bootstrapOrigin: true });
  assert.throws(() => guardPlan({ checks: [bootstrap, { status: 'fail', address: { to_display: 'check.unrelated' } }] },
    { bootstrapOrigin: true }), /check/i);
});

test('deployment plans enforce frozen mutation and separately GATED-off external write', () => {
  for (const value of [true, 'false', null, undefined]) {
    assert.throws(() => guardPlan({ variables: { remediation_enabled: { value }, integrations_write_enabled: { value: false } } },
      { enforceDeploymentPosture: true }), /frozen|remediation/i);
  }
  guardPlan({ variables: { remediation_enabled: { value: false }, integrations_write_enabled: { value: false } }, resource_changes: [] },
    { enforceDeploymentPosture: true });
  assert.throws(() => guardPlan({ variables: { remediation_enabled: { value: false }, integrations_write_enabled: { value: true } } },
    { enforceDeploymentPosture: true }), /GATED-off.*integrations_write_enabled/i);
});

test('safe owned task-definition revisions do not permit service or arbitrary resource replacement', () => {
  const account = '123456789012', region = 'ap-northeast-2';
  const revision = {
    address: 'aws_ecs_task_definition.web', type: 'aws_ecs_task_definition',
    change: { actions: ['create', 'delete'],
      before: { family: 'awsops-dev-web', arn: `arn:aws:ecs:${region}:${account}:task-definition/awsops-dev-web:1`, skip_destroy: true },
      after: { family: 'awsops-dev-web', skip_destroy: true } },
  };
  const options = { taskRevisionScope: { account, region, project: 'awsops-dev' } };
  guardPlan({ resource_changes: [revision] }, options);
  for (const bad of [
    { ...revision, address: 'aws_ecs_task_definition.unrelated' },
    { ...revision, type: 'aws_ecs_service' },
    { ...revision, change: { ...revision.change, actions: ['delete'] } },
    { ...revision, change: { ...revision.change, after: { ...revision.change.after, family: 'other-project' } } },
    { ...revision, change: { ...revision.change, before: { ...revision.change.before, arn: revision.change.before.arn.replace(account, '999999999999') } } },
    { ...revision, change: { ...revision.change, before: { ...revision.change.before, skip_destroy: false } } },
  ]) assert.throws(() => guardPlan({ resource_changes: [bad] }, options), /review/i);
});

test('bootstrap admits migration prerequisites and state-only web retention, never existing code changes', () => {
  const plan = { variables: { project: { value: 'awsops-dev' }, region: { value: 'ap-northeast-2' },
    ci_deployment_enabled: { value: true }, remediation_enabled: { value: false }, integrations_write_enabled: { value: false } },
  resource_changes: [
    { address: 'aws_ecs_task_definition.migration[0]', type: 'aws_ecs_task_definition', change: { actions: ['create'], after: {} } },
    { address: 'aws_ecs_task_definition.web', type: 'aws_ecs_task_definition', change: { actions: ['update'],
      before: { family: 'awsops-dev-web', skip_destroy: false, container_definitions: 'old code' },
      after: { family: 'awsops-dev-web', skip_destroy: true, container_definitions: 'old code' } } },
  ] };
  guardBootstrapPlan(plan);
  const changedCode = structuredClone(plan);
  changedCode.resource_changes[1].change.after.container_definitions = 'new code';
  assert.throws(() => guardBootstrapPlan(changedCode), /non-prerequisite/);
  assert.throws(() => guardBootstrapPlan({ ...plan, resource_changes: [
    { address: 'aws_lambda_function.inv_sync[0]', type: 'aws_lambda_function', change: { actions: ['update'] } },
  ] }), /non-prerequisite/);
});

test('stable ECS is insufficient: desired count, rollout, digest and container health must match', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const service = { desiredCount: 1, runningCount: 1, pendingCount: 0, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: 'expected' }] };
  const task = { lastStatus: 'RUNNING', taskDefinitionArn: 'expected', containers: [{ name: 'web', imageDigest: digest, healthStatus: 'HEALTHY' }] };
  verifyService(service, [task], digest, 'expected');
  for (const bad of [[], [{ ...task, taskDefinitionArn: 'rollback' }], [{ ...task, containers: [{ ...task.containers[0], imageDigest: 'old' }] }], [{ ...task, containers: [{ ...task.containers[0], healthStatus: 'UNKNOWN' }] }]]) {
    assert.throws(() => verifyService(service, bad, digest, 'expected'));
  }
  assert.throws(() => verifyService({ ...service, desiredCount: 0 }, [task], digest, 'expected'));
});

test('plan apply requires successful same-repository push run with exact SHA, branch and workflow', () => {
  const expected = { repository: 'owner/repo', sha: 'a'.repeat(40), target: 'dev', runId: '123' };
  const run = { id: 123, event: 'push', status: 'completed', conclusion: 'success', head_sha: expected.sha, head_branch: 'dev', path: '.github/workflows/terraform.yml', repository: { full_name: expected.repository } };
  verifyPlanRun(run, expected);
  for (const mutation of [{ head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { head_branch: 'main' }, { conclusion: 'failure' }, { path: '.github/workflows/other.yml' }, { id: 124 }, { repository: { full_name: 'fork/repo' } }]) {
    assert.throws(() => verifyPlanRun({ ...run, ...mutation }, expected));
  }
});

test('plan artifact authenticates bytes and metadata and binds backend/target/ref/run/SHA', () => {
  const metadata = { target: 'dev', sha: 'a'.repeat(40), ref: 'refs/heads/dev', runId: '123', repository: 'owner/repo', backend: 'backend-hash', tfvars: 'vars-hash' };
  const bytes = Buffer.from('secret saved binary plan');
  const key = 'test-secret-key-with-sufficient-entropy';
  const sealed = sealPlan(bytes, metadata, key);
  assert.deepEqual(openPlan(sealed, metadata, key), bytes);
  for (const field of Object.keys(metadata)) assert.throws(() => openPlan(sealed, { ...metadata, [field]: 'wrong' }, key));
  const corrupt = Buffer.from(sealed); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => openPlan(corrupt, metadata, key));
  assert.throws(() => openPlan(sealed, metadata, 'wrong-key'));
});

test('all manual aliases must point to this exact CloudFront distribution', () => {
  const dns = { aliases: ['app.example.invalid', 'other.example.invalid'], target: 'expected.cloudfront.net', target_zone: 'CF-ZONE' };
  const records = dns.aliases.map(Name => ({ Name: `${Name}.`, Type: 'A', AliasTarget: { DNSName: `${dns.target}.`, HostedZoneId: dns.target_zone } }));
  assert.equal(aliasesRegistered(dns, records), true);
  assert.equal(aliasesRegistered(dns, records.slice(0, 1)), false);
  assert.equal(aliasesRegistered(dns, records.map(r => ({ ...r, AliasTarget: { ...r.AliasTarget, DNSName: 'old.cloudfront.net' } }))), false);
  assert.equal(aliasesRegistered(dns, []), false);
});
