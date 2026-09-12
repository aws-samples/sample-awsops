// Pure fail-closed checks shared by CI and its offline tests. Never print plan values.
import { isDeepStrictEqual } from 'node:util';
export const DEPLOYMENT_OFF_FLAGS = {
  remediation_enabled: 'FROZEN AWS-resource mutation',
  integrations_write_enabled: 'GATED-off external-write policy',
};
const resourcesOf = module => [...(module?.resources ?? []), ...(module?.child_modules ?? []).flatMap(resourcesOf)];

function safeTaskRevision(resource, plan, scope) {
  if (!scope || resource.type !== 'aws_ecs_task_definition') return false;
  const family = resource.address === 'aws_ecs_task_definition.web' ? `${scope.project}-web`
    : resource.address === 'aws_ecs_task_definition.migration[0]' ? `${scope.project}-migration` : null;
  const { actions, before, after } = resource.change;
  if (!family || actions.length !== 2 || !actions.includes('create') || !actions.includes('delete')
      || before?.family !== family || after?.family !== family || after.skip_destroy !== true) return false;
  const prefix = `arn:aws:ecs:${scope.region}:${scope.account}:task-definition/${family}:`;
  if (!before.arn?.startsWith(prefix) || !/^\d+$/.test(before.arn.slice(prefix.length))) return false;
  if (family.endsWith('-migration') || before.skip_destroy === true) return true;
  // Do not deregister a legacy live web revision during its first transition to
  // skip_destroy. Bootstrap that state-only setting first if this template is live.
  const service = resourcesOf(plan.prior_state?.values?.root_module)
    .find(r => r.address === 'aws_ecs_service.web');
  return typeof service?.values?.task_definition === 'string'
    && service.values.task_definition !== before.arn;
}

export function guardPlan(plan, { reviewedDeletes = false, manualDns = true, bootstrapOrigin = false,
  enforceDeploymentPosture = false, taskRevisionScope } = {}) {
  if (enforceDeploymentPosture) {
    for (const [flag, policy] of Object.entries(DEPLOYMENT_OFF_FLAGS)) {
      if (plan.variables?.[flag]?.value !== false) throw new Error(`${policy}: ${flag} must be explicitly false in the saved plan`);
    }
  }
  if (plan.errored || plan.complete === false || plan.deferred_changes?.length) throw new Error('Incomplete plan refused');
  for (const check of plan.checks ?? []) {
    if (['fail', 'error'].includes(check.status) &&
        !(bootstrapOrigin && check.address?.to_display === 'check.cf_vpc_origin_sg_present')) {
      throw new Error('Failed Terraform check refused');
    }
  }
  for (const resource of plan.resource_changes ?? []) {
    if (resource.mode === 'data') continue;
    const actions = resource.change.actions;
    if (manualDns && resource.type.startsWith('aws_route53_') && actions.some(a => !['read', 'no-op'].includes(a))) {
      throw new Error(`Manual DNS required: ${resource.address}`);
    }
    if (actions.includes('delete') && !reviewedDeletes && !safeTaskRevision(resource, plan, taskRevisionScope)) {
      throw new Error(`Explicit saved-plan review required: ${resource.address}`);
    }
  }
}

export function assertDeploymentAccount(actual, expected) {
  if (!/^\d{12}$/.test(expected ?? '') || actual !== expected) {
    throw new Error('Deployment account mismatch or missing protected AWS_DEV_ACCOUNT_ID');
  }
}

/** Narrow one-time prerequisite plan; never permits an application/DB/edge update. */
export function guardBootstrapPlan(plan) {
  if (plan.variables?.project?.value !== 'awsops-dev' ||
      plan.variables?.region?.value !== 'ap-northeast-2' ||
      plan.variables?.ci_deployment_enabled?.value !== true) throw new Error('Bootstrap must target the pinned dev configuration');
  guardPlan(plan, { enforceDeploymentPosture: true });
  const creates = new Set([
    'aws_iam_role.migration[0]', 'aws_iam_role_policy.migration[0]',
    'aws_cloudwatch_log_group.migration[0]', 'aws_ecs_task_definition.migration[0]',
  ]);
  const without = (value, keys) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
  for (const resource of plan.resource_changes ?? []) {
    const { actions, before, after } = resource.change;
    if (resource.mode === 'data' || actions.every(action => ['read', 'no-op'].includes(action))) continue;
    if (actions.length === 1 && actions[0] === 'create' && creates.has(resource.address)) continue;
    const updateOnly = actions.length === 1 && actions[0] === 'update';
    if (resource.address === 'aws_ecs_task_definition.web' && updateOnly &&
        before?.family === 'awsops-dev-web' && after?.family === before.family && after.skip_destroy === true &&
        isDeepStrictEqual(without(before, ['skip_destroy']), without(after, ['skip_destroy']))) continue;
    if (resource.address === 'aws_ecr_repository.web' && updateOnly &&
        before?.name === 'awsops-dev-web' && after?.name === before.name && after.image_tag_mutability === 'IMMUTABLE' &&
        !(after.image_tag_mutability_exclusion_filter?.length) &&
        isDeepStrictEqual(without(before, ['image_tag_mutability', 'image_tag_mutability_exclusion_filter']),
          without(after, ['image_tag_mutability', 'image_tag_mutability_exclusion_filter']))) continue;
    throw new Error(`Bootstrap would change non-prerequisite resource: ${resource.address}`);
  }
}

export function selectStage(addresses, certificatesIssued) {
  return certificatesIssued || addresses.some(a => /^aws_(cloudfront_(distribution|vpc_origin)|lb_listener|acm_certificate_validation)\./.test(a)) ? 'edge' : 'core';
}

export function stageVariables(resources) {
  const service = resources.find(r => r.type === 'aws_ecs_service' && r.name === 'web');
  if (service && service.values.name !== 'awsops-dev-web') throw new Error('Backend belongs to a different stack');
  const template = resources.find(r => r.type === 'aws_ecs_task_definition' && r.name === 'web');
  let webImageDigest = '';
  if (template?.values?.container_definitions) {
    const image = JSON.parse(template.values.container_definitions).find(c => c.name === 'web')?.image ?? '';
    webImageDigest = image.match(/@(sha256:[a-f0-9]{64})$/)?.[1] ?? '';
  }
  return {
    ci_deployment_enabled: true,
    defer_edge_until_dns: selectStage(resources.map(r => r.address), false) !== 'edge',
    defer_dns_validation_records: !resources.some(r => r.type === 'aws_route53_record' && r.name === 'cf_validation'),
    defer_dns_alias_records: !resources.some(r => r.type === 'aws_route53_record' && r.name === 'alias'),
    web_desired_count: service?.values.desired_count ?? 0,
    web_task_definition_arn: service?.values.task_definition ?? '',
    web_image_digest: webImageDigest,
  };
}

export function verifyService(service, tasks, digest, taskDefinition) {
  const deployments = service?.deployments ?? [];
  if (!(service?.desiredCount > 0) || service.runningCount !== service.desiredCount || service.pendingCount !== 0 ||
      deployments.length !== 1 || deployments[0].status !== 'PRIMARY' || deployments[0].rolloutState !== 'COMPLETED' ||
      deployments[0].taskDefinition !== taskDefinition || tasks.length !== service.desiredCount) throw new Error('ECS rollout incomplete or rolled back');
  for (const task of tasks) {
    const container = task.containers?.find(c => c.name === 'web');
    if (task.lastStatus !== 'RUNNING' || task.taskDefinitionArn !== taskDefinition || container?.imageDigest !== digest || container?.healthStatus !== 'HEALTHY') {
      throw new Error('ECS task digest, revision or container health does not match the deployment');
    }
  }
}

export function verifyPlanRun(run, expected) {
  if (String(run.id) !== expected.runId || run.repository?.full_name !== expected.repository || run.event !== 'push' ||
      run.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== expected.sha ||
      run.head_branch !== expected.target || run.path !== '.github/workflows/terraform.yml') {
    throw new Error('Plan provenance mismatch: require successful terraform.yml push at this exact repository/ref/SHA');
  }
}

export function aliasesRegistered(dns, records) {
  const normalize = value => (value ?? '').replace(/\.$/, '').toLowerCase();
  if (!dns.target || !dns.target_zone || !dns.aliases?.length) return false;
  return dns.aliases.every(alias => records.some(record =>
    normalize(record.Name) === normalize(alias) && record.Type === 'A' &&
    normalize(record.AliasTarget?.DNSName) === normalize(dns.target) &&
    record.AliasTarget?.HostedZoneId === dns.target_zone));
}
