// Pure fail-closed checks shared by CI and its offline tests. Never print plan values.
export function guardPlan(plan, { reviewedDeletes = false, manualDns = true, bootstrapOrigin = false, enforceFrozenFlags = false } = {}) {
  if (enforceFrozenFlags && plan.variables?.remediation_enabled?.value !== false) {
    throw new Error('Frozen remediation_enabled must be explicitly false in the saved plan');
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
    if (actions.includes('delete') && !reviewedDeletes) throw new Error(`Explicit saved-plan review required: ${resource.address}`);
  }
}

export function assertDeploymentAccount(actual, expected) {
  if (!/^\d{12}$/.test(expected ?? '') || actual !== expected) {
    throw new Error('Deployment account mismatch or missing protected AWS_DEV_ACCOUNT_ID');
  }
}

export function selectStage(addresses, certificatesIssued) {
  return certificatesIssued || addresses.some(a => /^aws_(cloudfront_(distribution|vpc_origin)|lb_listener|acm_certificate_validation)\./.test(a)) ? 'edge' : 'core';
}

export function stageVariables(resources) {
  const service = resources.find(r => r.type === 'aws_ecs_service' && r.name === 'web');
  if (service && service.values.name !== 'awsops-dev-web') throw new Error('Backend belongs to a different stack');
  return {
    ci_deployment_enabled: true,
    defer_edge_until_dns: selectStage(resources.map(r => r.address), false) !== 'edge',
    defer_dns_validation_records: !resources.some(r => r.type === 'aws_route53_record' && r.name === 'cf_validation'),
    defer_dns_alias_records: !resources.some(r => r.type === 'aws_route53_record' && r.name === 'alias'),
    web_desired_count: service?.values.desired_count ?? 0,
    web_task_definition_arn: service?.values.task_definition ?? '',
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
