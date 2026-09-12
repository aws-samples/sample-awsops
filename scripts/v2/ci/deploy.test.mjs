import test from 'node:test';
import assert from 'node:assert/strict';
import { guardPlan, selectStage, verifyService, verifyPlanRun, aliasesRegistered } from './guards.mjs';
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

test('deployment plans must explicitly preserve the frozen remediation gate', () => {
  for (const value of [true, 'false', null, undefined]) {
    assert.throws(() => guardPlan({ variables: { remediation_enabled: { value } } },
      { enforceFrozenFlags: true }), /frozen|remediation/i);
  }
  guardPlan({ variables: { remediation_enabled: { value: false } }, resource_changes: [] },
    { enforceFrozenFlags: true });
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
