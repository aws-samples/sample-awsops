# Offline only: no backend, live credentials, provider calls or provisioner execution.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_regions" { defaults = { names = ["ap-northeast-2", "eu-west-1"] } }
  mock_data "aws_iam_policy_document" { defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" } }
  mock_data "aws_vpc" { defaults = { cidr_block = "10.20.0.0/16" } }
  mock_data "aws_security_groups" { defaults = { ids = ["sg-0123456789abcdef0"] } }
  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-fixture-web" }
  }
  mock_resource "aws_cognito_user_pool" { defaults = { id = "ap-northeast-2_fixture" } }
  mock_resource "aws_cognito_user_pool_client" { defaults = { id = "fixture-client" } }
  mock_resource "aws_sqs_queue" { defaults = { url = "https://sqs.ap-northeast-2.amazonaws.com/123456789012/awsops-fixture-jobs" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/fixture" } }
  mock_resource "aws_kms_key" { defaults = { arn = "arn:aws:kms:ap-northeast-2:123456789012:key/11111111-1111-1111-1111-111111111111" } }
  mock_resource "aws_secretsmanager_secret" { defaults = { arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:fixture" } }
  mock_resource "aws_ecs_cluster" { defaults = { arn = "arn:aws:ecs:ap-northeast-2:123456789012:cluster/awsops-fixture" } }
  mock_resource "aws_lambda_function" { defaults = { arn = "arn:aws:lambda:ap-northeast-2:123456789012:function:fixture", code_sha256 = "TYwIZpErPrCndYW8xYnWWh3mI1YW6yiPScDIEh+Q+o8=" } }
  mock_resource "aws_s3_bucket" { defaults = { arn = "arn:aws:s3:::awsops-fixture-artifacts", bucket = "awsops-fixture-artifacts" } }
  mock_resource "aws_rds_cluster" { defaults = { arn = "arn:aws:rds:ap-northeast-2:123456789012:cluster:fixture", cluster_resource_id = "cluster-EXAMPLE", endpoint = "fixture.cluster.example.test", master_user_secret = [{ kms_key_id = "mock-key", secret_arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:mock", secret_status = "active" }] } }
}
mock_provider "aws" {
  alias           = "use1"
  override_during = plan
}
mock_provider "archive" { override_during = plan }
mock_provider "random" { override_during = plan }

override_data {
  target          = data.archive_file.inv_sync_src[0]
  override_during = plan
  values          = { output_base64sha256 = "ilglk4b1XbT9KO4x3Ab6UOVhOCHcbDb++ZbFlkZfdOw=" }
}

override_resource {
  target          = aws_ecr_repository.agentcore[0]
  override_during = plan
  values          = { arn = "arn:aws:ecr:ap-northeast-2:123456789012:repository/awsops-fixture-agentcore", repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-fixture-agentcore" }
}
override_resource {
  target          = aws_ecr_repository.steampipe[0]
  override_during = plan
  values          = { arn = "arn:aws:ecr:ap-northeast-2:123456789012:repository/awsops-fixture-steampipe", repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-fixture-steampipe" }
}
override_resource {
  target          = aws_ecr_repository.worker[0]
  override_during = plan
  values          = { arn = "arn:aws:ecr:ap-northeast-2:123456789012:repository/awsops-fixture-worker", repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-fixture-worker" }
}

variables {
  project                      = "awsops-fixture"
  region                       = "ap-northeast-2"
  domain_name                  = "dev.example.com"
  hosted_zone_name             = "example.com"
  publish_service_dns          = false
  existing_cf_certificate_arn  = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  existing_alb_certificate_arn = "arn:aws:acm:ap-northeast-2:123456789012:certificate/22222222-2222-2222-2222-222222222222"
  create_network               = false
  existing_vpc_id              = "vpc-0123456789abcdef0"
  existing_private_subnet_ids  = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
}

run "diagnosis_evidence_defaults_remain_dark" {
  command = plan
  variables { workers_enabled = true }
  assert {
    condition     = !var.diagnosis_evidence_loop_enabled && length(aws_iam_role_policy.worker_diagnosis_evidence) == 0
    error_message = "The evidence loop must be default-off with no additional IAM."
  }
  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].environment : e if contains(["DIAGNOSIS_EVIDENCE_LOOP_ENABLED", "DIAGNOSIS_HOST_ACCOUNT_ID"], e.name)]) == 0 && !contains(keys(aws_lambda_function.worker[0].environment[0].variables), "DIAGNOSIS_EVIDENCE_LOOP_ENABLED")
    error_message = "Disabled discovery must leave both worker environments unchanged."
  }
}

run "diagnosis_evidence_gate_adds_only_scoped_provider_reads" {
  command = plan
  variables {
    workers_enabled                 = true
    diagnosis_evidence_loop_enabled = true
  }
  assert {
    condition     = keys(aws_iam_role_policy.worker_diagnosis_evidence) == ["task"] && length(aws_iam_role_policy.worker_finops_baseline) == 0
    error_message = "Diagnosis provider reads must be separately gated from FinOps on each worker role."
  }
  assert {
    condition = alltrue([for p in aws_iam_role_policy.worker_diagnosis_evidence :
      jsondecode(p.policy).Statement[0].Action == ["compute-optimizer:GetEC2InstanceRecommendations", "compute-optimizer:GetRDSDatabaseRecommendations"] &&
      jsondecode(p.policy).Statement[0].Effect == "Allow" &&
      jsondecode(p.policy).Statement[0].Resource == "*" &&
      jsondecode(p.policy).Statement[0].Condition.StringEquals["aws:RequestedRegion"] == ["ap-northeast-2", "eu-west-1", "us-east-1"]
    ])
    error_message = "Only the two provider reads in supported runtime regions may be added."
  }
  assert {
    condition = alltrue([for p in aws_iam_role_policy.worker_diagnosis_evidence :
      length(jsondecode(p.policy).Statement) == 2 &&
      jsondecode(p.policy).Statement[1].Action == ["cloudwatch:ListMetrics"] &&
      [for s in jsondecode(p.policy).Statement : s.Sid] == ["DiagnosisProviderSizingReadOnly", "DiagnosisMeasuredMemoryReadOnly"]
    ])
    error_message = "Without member roles the evidence policy is exactly the provider reads plus cloudwatch:ListMetrics; no AssumeRole."
  }
  assert {
    condition     = [for e in jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].environment : e.value if e.name == "DIAGNOSIS_HOST_ACCOUNT_ID"] == ["123456789012"] && length([for e in jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].environment : e if contains(["INVENTORY_STALE_AFTER_MINUTES", "GRAPH_REBUILD_INTERVAL_MINS"], e.name)]) == 2 && !contains(keys(aws_lambda_function.worker[0].environment[0].variables), "DIAGNOSIS_HOST_ACCOUNT_ID")
    error_message = "The Fargate report worker binds discovery to the applied host account; the Lambda runs no diagnosis."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.worker[0].environment[0].variables), "DIAGNOSIS_EVIDENCE_LOOP_ENABLED") && [for e in jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].environment : e.value if e.name == "DIAGNOSIS_EVIDENCE_LOOP_ENABLED"] == ["true"] && [for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment : e if e.name == "DIAGNOSIS_EVIDENCE_LOOP_ENABLED"] == []
    error_message = "The gate must enable worker discovery without adding a web/BFF execution path."
  }
  assert {
    condition     = !var.remediation_enabled && !var.integrations_write_enabled && !var.incident_lifecycle_enabled
    error_message = "Enabling read-only discovery must leave frozen and unrelated gates off."
  }
}

run "diagnosis_evidence_gate_requires_workers" {
  command = plan
  variables { diagnosis_evidence_loop_enabled = true }
  expect_failures = [var.diagnosis_evidence_loop_enabled]
}

run "diagnosis_network_defaults_remain_dark" {
  command = plan
  variables {
    workers_enabled                 = true
    diagnosis_evidence_loop_enabled = true
  }
  assert {
    condition     = !var.diagnosis_network_evidence_enabled && length(aws_iam_role_policy.worker_diagnosis_network) == 0
    error_message = "Network observations must require a separate default-off source gate."
  }
}

run "diagnosis_network_requires_evidence_loop" {
  command = plan
  variables {
    workers_enabled                    = true
    diagnosis_network_evidence_enabled = true
  }
  expect_failures = [var.diagnosis_network_evidence_enabled]
}

run "diagnosis_network_queries_are_host_scoped_and_allowlisted" {
  command = plan
  variables {
    workers_enabled                    = true
    diagnosis_evidence_loop_enabled    = true
    diagnosis_network_evidence_enabled = true
    diagnosis_dns_log_group_arns       = ["arn:aws:logs:ap-northeast-2:123456789012:log-group:/resolver/approved"]
    diagnosis_member_role_arns         = ["arn:aws:iam::999900001111:role/AWSopsReadOnlyRole"]
  }
  assert {
    condition = keys(aws_iam_role_policy.worker_diagnosis_network) == ["task"] && alltrue([for p in aws_iam_role_policy.worker_diagnosis_network :
      length(jsondecode(p.policy).Statement) == 4 &&
      jsondecode(p.policy).Statement[0].Action == ["route53resolver:ListResolverQueryLogConfigs", "route53resolver:ListResolverQueryLogConfigAssociations", "networkflowmonitor:ListMonitors", "rds:DescribeDBProxies", "rds:DescribeDBProxyTargets", "rds:DescribeDBClusters"] &&
      jsondecode(p.policy).Statement[1].Action == ["networkflowmonitor:StartQueryMonitorTopContributors", "networkflowmonitor:GetQueryStatusMonitorTopContributors", "networkflowmonitor:GetQueryResultsMonitorTopContributors", "networkflowmonitor:StopQueryMonitorTopContributors"] &&
      jsondecode(p.policy).Statement[2].Resource == ["arn:aws:logs:ap-northeast-2:123456789012:log-group:/resolver/approved:*"] &&
      jsondecode(p.policy).Statement[2].Action == ["logs:StartQuery"] &&
      jsondecode(p.policy).Statement[3].Action == ["logs:GetQueryResults", "logs:StopQuery"] &&
      jsondecode(p.policy).Statement[1].Resource == [for region in ["ap-northeast-2", "eu-west-1", "us-east-1"] : "arn:aws:networkflowmonitor:${region}:123456789012:monitor/*"] &&
      alltrue([for s in jsondecode(p.policy).Statement : can(s.Condition.StringEquals["aws:RequestedRegion"])])
    ])
    error_message = "Observation permissions must remain host/account/region scoped with explicit Resolver groups."
  }
  assert {
    condition = alltrue([for p in aws_iam_role_policy.worker_diagnosis_evidence :
      length(jsondecode(p.policy).Statement) == 3 &&
      [for s in jsondecode(p.policy).Statement : s.Action] == [["compute-optimizer:GetEC2InstanceRecommendations", "compute-optimizer:GetRDSDatabaseRecommendations"], ["cloudwatch:ListMetrics"], ["sts:AssumeRole"]] &&
      jsondecode(p.policy).Statement[2].Resource == ["arn:aws:iam::999900001111:role/AWSopsReadOnlyRole"] &&
      jsondecode(p.policy).Statement[2].Condition.StringLike["sts:ExternalId"] == "?*"
    ])
    error_message = "Member reads add exactly one sts:AssumeRole statement on the explicit role with an external ID."
  }
  assert {
    condition = (!contains(keys(aws_lambda_function.worker[0].environment[0].variables), "DIAGNOSIS_NETWORK_EVIDENCE_ENABLED") &&
      [for e in jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].environment : e.value if e.name == "DIAGNOSIS_NETWORK_EVIDENCE_ENABLED"] == ["true"] &&
    !var.remediation_enabled && !var.integrations_write_enabled)
    error_message = "Only the Fargate report worker receives the analysis gate, without enabling mutation."
  }
}

run "diagnosis_allowlists_reject_foreign_logs_and_host_roles" {
  command = plan
  variables {
    diagnosis_dns_log_group_arns = ["arn:aws:logs:ap-northeast-2:999900001111:log-group:/foreign"]
    diagnosis_member_role_arns   = ["arn:aws:iam::123456789012:role/AWSopsReadOnlyRole"]
  }
  expect_failures = [var.diagnosis_dns_log_group_arns, var.diagnosis_member_role_arns]
}

run "diagnosis_member_roles_pin_the_onboarding_role_name" {
  command = plan
  variables {
    diagnosis_member_role_arns = ["arn:aws:iam::999900001111:role/OrganizationAccountAccessRole"]
  }
  expect_failures = [var.diagnosis_member_role_arns]
}

run "diagnosis_allowlists_reject_malformed_arns" {
  command = plan
  variables {
    diagnosis_dns_log_group_arns = ["bad"]
    diagnosis_member_role_arns   = ["bad"]
  }
  expect_failures = [var.diagnosis_dns_log_group_arns, var.diagnosis_member_role_arns]
}

run "defaults_remain_dark" {
  command = plan
  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment : e if contains(["INVENTORY_TASK_ROLE_ARN", "INVENTORY_TARGET_ACCOUNT_IDS"], e.name)]) == 0
    error_message = "Disabled inventory must not advertise a role or target allowlist."
  }
  assert {
    condition     = [for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment : e.value if e.name == "SSM_RUNTIME_ARN_PARAM"] == [""]
    error_message = "Disabled AgentCore must not advertise an unavailable runtime parameter."
  }
  assert {
    condition     = output.runtime_deployment.inventory.sync_code_sha256 == null
    error_message = "Disabled inventory must not publish a collector fingerprint."
  }
  assert {
    condition     = (length(aws_iam_role_policy.agentcore) == 0 && length(aws_iam_role_policy.official_mcp_credentials) == 0 && length(aws_iam_role_policy.steampipe_task) == 0 && length(aws_iam_role_policy.worker_lambda) == 0 && !var.inventory_host_only && var.steampipe_image_digest == null && var.worker_image_digest == null && !var.remediation_enabled && !var.diagnosis_notify_enabled && !var.integrations_write_enabled)
    error_message = "Core runtime and host/image overrides must remain opt-in."
  }
  assert {
    condition     = !var.jaeger_vpc_enabled && !var.dynatrace_vpc_enabled && length(aws_iam_role_policy.agent_lambda_vpc_eni) == 0
    error_message = "Private external datasource networking must remain default-off."
  }
}

run "connector_target_sync_is_default_off" {
  command = plan
  variables {
    agentcore_enabled    = true
    integrations_enabled = true
    workers_enabled      = true
  }
  assert {
    condition = (length(aws_iam_role_policy.connector_target_sync) == 0 && length(aws_lambda_function.connector_target_sync) == 0 && length(aws_iam_role_policy.worker_lambda_invoke_connector_target_sync) == 0 &&
      !contains(keys(aws_lambda_function.worker[0].environment[0].variables), "CONNECTOR_TARGET_SYNC_ENABLED") &&
    length([for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment : e if e.name == "CONNECTOR_TARGET_SYNC_ENABLED"]) == 0)
    error_message = "Connector target sync must add no IAM or env until its flag is set."
  }
}

run "connector_target_sync_requires_its_prerequisites" {
  command = plan
  variables {
    connector_target_sync_enabled = true
  }
  expect_failures = [var.connector_target_sync_enabled]
}

run "connector_target_sync_writes_only_the_own_gateway_without_delete" {
  command = plan
  variables {
    agentcore_enabled             = true
    integrations_enabled          = true
    workers_enabled               = true
    connector_target_sync_enabled = true
  }
  assert {
    condition = (length(jsondecode(aws_iam_role_policy.connector_target_sync[0].policy).Statement) == 2 &&
      alltrue([
        for s in jsondecode(aws_iam_role_policy.connector_target_sync[0].policy).Statement :
        !anytrue([for a in s.Action : can(regex("Delete", a))]) &&
        (s.Sid == "ResolveOwnGateway" ? toset(s.Action) == toset(["bedrock-agentcore:ListGateways"]) :
          (s.Sid == "ManageOwnGatewayTargets" &&
            toset(s.Action) == toset(["bedrock-agentcore:GetGateway", "bedrock-agentcore:ListGatewayTargets", "bedrock-agentcore:GetGatewayTarget", "bedrock-agentcore:CreateGatewayTarget", "bedrock-agentcore:UpdateGatewayTarget"]) &&
        s.Resource == ["arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:gateway/awsops-v2-external-obs-gateway-*", "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:gateway/awsops-v2-monitoring-gateway-*"]))
    ]))
    error_message = "Target sync policy must have exactly two statements: ResolveOwnGateway (ListGateways only) and ManageOwnGatewayTargets (exactly GetGateway, ListGatewayTargets, GetGatewayTarget, CreateGatewayTarget, UpdateGatewayTarget) on the awsops external-obs/monitoring gateways, and never delete."
  }
  assert {
    condition     = aws_iam_role.connector_target_sync[0].name == "awsops-fixture-connector-target-sync"
    error_message = "The gateway-target grant must sit on the dedicated connector-target-sync role, not the shared worker role."
  }
  assert {
    condition = (length(jsondecode(aws_iam_role_policy.worker_lambda_invoke_connector_target_sync[0].policy).Statement) == 1 &&
    alltrue([for s in jsondecode(aws_iam_role_policy.worker_lambda_invoke_connector_target_sync[0].policy).Statement : toset(s.Action) == toset(["lambda:InvokeFunction"])]))
    error_message = "The shared worker role may only invoke the dedicated connector-target-sync function."
  }
  assert {
    condition = (aws_lambda_function.worker[0].environment[0].variables["CONNECTOR_TARGET_SYNC_ENABLED"] == "true" &&
      aws_lambda_function.worker[0].environment[0].variables["CONNECTOR_TARGET_SYNC_FUNCTION"] == "awsops-fixture-connector-target-sync" &&
      !contains(keys(aws_lambda_function.worker[0].environment[0].variables), "CONNECTOR_TARGET_LAMBDAS") &&
      !contains(keys(aws_lambda_function.worker[0].environment[0].variables), "CONNECTOR_TARGET_GATEWAY_ROLE_ARN") &&
      toset(keys(jsondecode(aws_lambda_function.connector_target_sync[0].environment[0].variables["CONNECTOR_TARGET_LAMBDAS"]))) == toset(["clickhouse-mcp", "prometheus-mcp", "loki-mcp", "tempo-mcp", "mimir-mcp"]) &&
    length([for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment : e if e.name == "CONNECTOR_TARGET_SYNC_ENABLED" && e.value == "true"]) == 1)
    error_message = "The worker receives only the enable flag and dedicated function name, the dedicated function only connector Lambda ARNs, and the web task the enqueue gate."
  }
}

run "private_datasource_flags_require_applied_prerequisites" {
  command = plan
  variables {
    jaeger_vpc_enabled    = true
    dynatrace_vpc_enabled = true
  }
  expect_failures = [var.jaeger_vpc_enabled, var.dynatrace_vpc_enabled]
}

run "private_jaeger_and_dynatrace_attach_only_the_selected_lambdas" {
  command = plan
  variables {
    agentcore_enabled     = true
    integrations_enabled  = true
    jaeger_vpc_enabled    = true
    dynatrace_vpc_enabled = true
  }
  assert {
    condition = (
      aws_lambda_function.agent["jaeger-mcp"].vpc_config[0].subnet_ids == toset(var.existing_private_subnet_ids) &&
      aws_lambda_function.agent["dynatrace-mcp"].vpc_config[0].subnet_ids == toset(var.existing_private_subnet_ids) &&
      length(aws_lambda_function.agent["datadog-mcp"].vpc_config) == 0 &&
      length(aws_lambda_function.agent["prometheus-mcp"].vpc_config) == 0 &&
      length(aws_iam_role_policy.agent_lambda_vpc_eni) == 1 &&
      !var.official_mcp_enabled && !var.remediation_enabled && !var.integrations_write_enabled
    )
    error_message = "Private datasource attachment must be selective and must not activate MCP/write gates."
  }
}

run "explicit_inventory_targets_pin_metadata_permissions_and_actual_principal" {
  command = plan
  variables {
    ci_runtime_profile_enabled = true
    steampipe_enabled          = true
    agentcore_enabled          = true
    workers_enabled            = true
    runtime_verification_targets = [
      { account_id = "999999999999", resource_type = "ec2", resource_id = "i-fixture" }
    ]
  }
  assert {
    condition     = output.runtime_deployment.inventory.verification_targets == var.runtime_verification_targets
    error_message = "Applied output must pin the exact target proof contract."
  }
  assert {
    condition = (
      [for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment : e.value if e.name == "INVENTORY_TASK_ROLE_ARN"] == [aws_iam_role.steampipe_task[0].arn] &&
      [for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment : e.value if e.name == "INVENTORY_TARGET_ACCOUNT_IDS"] == [jsonencode(["999999999999"])] &&
      [for e in jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].environment : e.value if e.name == "INVENTORY_TARGET_ACCOUNT_IDS"] == [jsonencode(["999999999999"])] &&
      [for e in jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].environment : e.value if e.name == "EXPECTED_HOST_ACCOUNT_ID"] == ["123456789012"]
    )
    error_message = "Web and collector must receive the same allowlist and actual inventory principal."
  }
  assert {
    condition     = [for s in jsondecode(aws_iam_role_policy.steampipe_task[0].policy).Statement : s.Resource if s.Action == ["sts:AssumeRole"]] == [["arn:aws:iam::999999999999:role/AWSopsReadOnlyRole"]]
    error_message = "Explicit targets must not retain the legacy wildcard AssumeRole resource."
  }
}

run "explicit_targets_cannot_disable_runtime_or_combine_with_host_only" {
  command = plan
  variables {
    inventory_host_only = true
    runtime_verification_targets = [
      { account_id = "999999999999", resource_type = "ec2", resource_id = "i-fixture" }
    ]
  }
  expect_failures = [var.runtime_verification_targets]
}

run "explicit_targets_reject_host_and_unsupported_proof_types" {
  command = plan
  variables {
    ci_runtime_profile_enabled = true
    steampipe_enabled          = true
    agentcore_enabled          = true
    workers_enabled            = true
    runtime_verification_targets = [
      { account_id = "123456789012", resource_type = "ec2_instance", resource_id = "i-fixture" }
    ]
  }
  expect_failures = [var.runtime_verification_targets]
}

run "inventory_fingerprint_uses_the_deployed_archive" {
  command = plan
  variables {
    steampipe_enabled = true
  }
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].healthCheck.command == ["CMD", "python3", "/app/healthcheck.py"] &&
      jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].healthCheck.timeout == 10 &&
      jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].healthCheck.interval == 30 &&
      jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].healthCheck.retries == 5
    )
    error_message = "Health checks must observe PostgreSQL without a Steampipe CLI auto-start that races the supervisor."
  }
  assert {
    condition = (
      output.runtime_deployment.inventory.sync_code_sha256 == data.archive_file.inv_sync_src[0].output_base64sha256 &&
      output.runtime_deployment.inventory.sync_code_sha256 == aws_lambda_function.inv_sync[0].source_code_hash &&
      output.runtime_deployment.inventory.sync_code_sha256 != aws_lambda_function.inv_sync[0].code_sha256
    )
    error_message = "Readiness must compare live code with the intended archive, not a stale or drifted provider observation."
  }
}

run "host_core_permissions_and_digest_binding" {
  command = plan
  variables {
    agentcore_enabled             = true
    workers_enabled               = true
    steampipe_enabled             = true
    inventory_host_only           = true
    steampipe_image_digest        = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    worker_image_digest           = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    inventory_stale_after_minutes = 7
  }
  assert {
    condition = (
      try(one([for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment :
      e.value if e.name == "INVENTORY_STALE_AFTER_MINUTES"]), null) == "7" &&
      aws_lambda_function.agent["inventory-read"].environment[0].variables["INVENTORY_STALE_AFTER_MINUTES"] == "7"
    )
    error_message = "Web graph evidence and inventory-read Lambda must share the configured source-age threshold."
  }
  assert {
    condition = toset(jsondecode(aws_iam_role_policy.task_agentcore_ssm[0].policy).Statement[0].Resource) == toset([
      "arn:aws:ssm:ap-northeast-2:123456789012:parameter/ops/awsops-fixture/agentcore/runtime_arn",
      "arn:aws:ssm:ap-northeast-2:123456789012:parameter/ops/awsops-fixture/agentcore/interpreter_id",
      "arn:aws:ssm:ap-northeast-2:123456789012:parameter/ops/awsops-fixture/agentcore/memory_id",
    ])
    error_message = "The web task may read exactly its three AgentCore parameters."
  }
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.agentcore[0].policy).Statement :
      [for a in s.Action : a if startswith(a, "bedrock-agentcore:")]
      ])) == toset([
      "bedrock-agentcore:ListGateways", "bedrock-agentcore:InvokeGateway",
      "bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
    ])
    error_message = "Runtime must not receive provisioner/control-plane or ForUserId authority."
  }
  assert {
    condition     = (toset(one([for s in jsondecode(aws_iam_role_policy.agentcore[0].policy).Statement : s.Resource if s.Sid == "RuntimeWorkloadToken"])) == toset(["arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:workload-identity-directory/default", "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:workload-identity-directory/default/workload-identity/awsops_v2_agent-*", ]) && one([for s in jsondecode(aws_iam_role_policy.agentcore[0].policy).Statement : s.Resource if s.Sid == "InvokeOwnGateways"]) == "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:gateway/*")
    error_message = "Runtime identity must retain the fixed product name and own account/region."
  }
  assert {
    condition = alltrue([
      for p in [aws_iam_role_policy.steampipe_task[0].policy] : !contains(flatten([for s in jsondecode(p).Statement : s.Action]), "sts:AssumeRole")
    ])
    error_message = "Host-only inventory must omit collector cross-account role assumption."
  }
  assert {
    condition = alltrue([
      for p in [
        aws_iam_role_policy.agentcore[0].policy, aws_iam_role_policy.agent_lambda_read[0].policy,
        aws_iam_role_policy.agent_lambda_reader_scoped[0].policy, aws_iam_role_policy.agent_lambda_opensearch[0].policy,
        aws_iam_role_policy.task_agentcore_status[0].policy, aws_iam_role_policy.task_cost[0].policy,
        aws_iam_role_policy.steampipe_task[0].policy, aws_iam_role_policy.inv_sync[0].policy,
        aws_iam_role_policy.worker_lambda[0].policy, aws_iam_role_policy.sfn[0].policy,
        aws_iam_role_policy.worker_diagnosis[0].policy, aws_iam_role_policy.worker_lambda_diagnosis[0].policy,
      ] : alltrue([for s in jsondecode(p).Statement : can(s.Condition.StringEquals["aws:RequestedRegion"]) if try(s.Resource == "*", false)])
    ])
    error_message = "Every newly activated bare-wildcard statement needs an applicable region condition."
  }
  assert {
    condition     = (data.aws_regions.runtime_read[0].all_regions && toset(local.runtime_read_regions) == toset(["ap-northeast-2", "eu-west-1", "us-east-1"]) && toset(jsondecode(aws_iam_role_policy.steampipe_task[0].policy).Statement[0].Condition.StringEquals["aws:RequestedRegion"]) == toset(local.runtime_read_regions) && contains(jsondecode(aws_iam_role_policy.steampipe_task[0].policy).Statement[0].Action, "iam:GenerateCredentialReport"))
    error_message = "Host reads retain known regions, including later opt-ins/global endpoints and the existing credential-report permission."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.sfn[0].policy).Statement :
      s.Resource == "arn:aws:ecs:ap-northeast-2:123456789012:task/awsops-fixture/*"
      if contains(["ControlTasks", "TagRunTasks"], s.Sid)
    ])
    error_message = "Step Functions task control/tagging must be confined to the own cluster."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.sfn[0].policy).Statement : s.Condition.ArnEquals["ecs:cluster"] if s.Sid == "RunWorkerTask"]) == aws_ecs_cluster.main.arn
    error_message = "Worker task definitions must only be launched in the own cluster."
  }
  assert {
    condition     = (jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].image == "${aws_ecr_repository.steampipe[0].repository_url}@${var.steampipe_image_digest}" && jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].image == "${aws_ecr_repository.worker[0].repository_url}@${var.worker_image_digest}" && { for e in jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].environment : e.name => e.value }["INVENTORY_HOST_ONLY"] == "true" && { for e in jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].environment : e.name => e.value }["EXPECTED_HOST_ACCOUNT_ID"] == "123456789012")
    error_message = "Runtime tasks must bind supplied digests and explicitly enable the verified host guard."
  }
  assert {
    condition = alltrue([
      for p in [aws_iam_role_policy.worker_diagnosis[0].policy, aws_iam_role_policy.worker_lambda_diagnosis[0].policy] :
      alltrue([for s in jsondecode(p).Statement : toset(s.Resource) == toset([
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
        "arn:aws:bedrock:*:123456789012:inference-profile/*anthropic.claude-*"])
      if contains(s.Action, "bedrock:InvokeModel")])
    ])
    error_message = "Worker model invocation must use the curated Claude model/profile resources."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.agentcore[0].policy).Statement : toset(s.Resource) == toset([
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
      "arn:aws:bedrock:*:123456789012:inference-profile/*anthropic.claude-*",
      "arn:aws:bedrock:*::foundation-model/openai.gpt-6-luna",
      "arn:aws:bedrock:*::foundation-model/openai.gpt-6-luna-*",
      "arn:aws:bedrock:*:123456789012:inference-profile/global.openai.gpt-6-luna",
      "arn:aws:bedrock:*:123456789012:inference-profile/global.openai.gpt-6-luna-*"])
    if contains(s.Action, "bedrock:InvokeModel")])
    error_message = "The chat runtime may invoke only curated Claude resources plus GPT-6 Luna."
  }
  assert {
    condition = toset(one(jsondecode(aws_iam_role_policy.task_web_models.policy).Statement).Resource) == toset([
      "arn:aws:bedrock:*::foundation-model/openai.gpt-6.1-terra",
      "arn:aws:bedrock:*::foundation-model/openai.gpt-6.1-terra-*",
      "arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/global.openai.gpt-6.1-terra",
      "arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/global.openai.gpt-6.1-terra-*",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5-*",
      "arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/global.anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/global.anthropic.claude-sonnet-5-5-*",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5-*",
      "arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/global.anthropic.claude-haiku-5-5",
    "arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/global.anthropic.claude-haiku-5-5-*"])
    error_message = "Web direct model calls are limited to query generation (Terra, Sonnet 5.5) and the assistant (Haiku 5.5)."
  }
}

run "legacy_tag_and_scope_behavior" {
  command = plan
  variables {
    agentcore_enabled    = true
    integrations_enabled = true
    official_mcp_enabled = true
    workers_enabled      = true
    steampipe_enabled    = true
  }
  assert {
    condition     = (jsondecode(aws_iam_role_policy.official_mcp_credentials[0].policy).Statement[0].Action == ["bedrock-agentcore:GetResourceApiKey"] && length(jsondecode(aws_iam_role_policy.official_mcp_credentials[0].policy).Statement[0].Resource) == 7 && contains(jsondecode(aws_iam_role_policy.official_mcp_credentials[0].policy).Statement[0].Resource, "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:token-vault/default/apikeycredentialprovider/awsops-v2-datadog-mcp"))
    error_message = "Official MCP must retain scoped API-key use without control-plane authority."
  }
  assert {
    condition = try(
      jsondecode(aws_iam_role_policy.official_mcp_credentials[0].policy).Statement[1].Action == ["bedrock-agentcore:GetWorkloadAccessToken"] &&
      toset(jsondecode(aws_iam_role_policy.official_mcp_credentials[0].policy).Statement[1].Resource) == toset([
        "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:workload-identity-directory/default",
        "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:workload-identity-directory/default/workload-identity/awsops-v2-external-obs-gateway-*"
      ]), false
    )
    error_message = "Official MCP needs only its own gateway workload-token identity, not runtime/global token authority."
  }
  assert {
    condition     = (jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].image == "${aws_ecr_repository.steampipe[0].repository_url}:${var.steampipe_image_tag}" && jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].image == "${aws_ecr_repository.worker[0].repository_url}:${var.worker_image_tag}" && !contains([for e in jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].environment : e.name], "INVENTORY_HOST_ONLY") && !contains([for e in jsondecode(aws_ecs_task_definition.steampipe[0].container_definitions)[0].environment : e.name], "EXPECTED_HOST_ACCOUNT_ID") && alltrue([for p in [aws_iam_role_policy.steampipe_task[0].policy, aws_iam_role_policy.agent_lambda_read[0].policy, aws_iam_role_policy.agent_lambda_reader_scoped[0].policy, ] : contains(flatten([for s in jsondecode(p).Statement : s.Action]), "sts:AssumeRole")]))
    error_message = "Null digests and host-only=false must preserve legacy behavior."
  }
}

run "privatelink_defaults_remain_dark" {
  command = plan
  assert {
    condition     = length(aws_security_group.privatelink) == 0 && length(aws_vpc_endpoint.privatelink) == 0 && length(aws_vpc_security_group_ingress_rule.privatelink) == 0
    error_message = "An empty privatelink_endpoints map must create no PrivateLink resources."
  }
}

run "privatelink_endpoint_creates_restricted_consumer_resources" {
  command = plan
  override_resource {
    target = aws_vpc_endpoint.privatelink["clickhouse"]
    values = { dns_entry = [{ dns_name = "vpce-0fixture-abc.vpce-svc-0123456789abcdef0.ap-northeast-2.vpce.amazonaws.com", hosted_zone_id = "ZFIXTURE" }] }
  }
  override_resource {
    target = aws_vpc_endpoint.privatelink["prometheus"]
    values = { dns_entry = [{ dns_name = "vpce-0fixture-def.vpce-svc-0123456789abcdef1.ap-northeast-2.vpce.amazonaws.com", hosted_zone_id = "ZFIXTURE" }] }
  }
  override_resource {
    target          = aws_security_group.service
    override_during = plan
    values          = { id = "sg-0fixtureservice" }
  }
  override_resource {
    target          = aws_security_group.privatelink_clients["clickhouse"]
    override_during = plan
    values          = { id = "sg-0fixtureclickhouse" }
  }
  override_resource {
    target          = aws_security_group.privatelink_clients["prometheus"]
    override_during = plan
    values          = { id = "sg-0fixtureprometheus" }
  }
  override_resource {
    target          = aws_security_group.privatelink["clickhouse"]
    override_during = plan
    values          = { id = "sg-0fixtureepclickhouse" }
  }
  override_resource {
    target          = aws_security_group.privatelink["prometheus"]
    override_during = plan
    values          = { id = "sg-0fixtureepprometheus" }
  }
  variables {
    agentcore_enabled      = true
    integrations_enabled   = true
    clickhouse_vpc_enabled = true
    prometheus_vpc_enabled = true
    privatelink_endpoints = {
      clickhouse = { kind = "clickhouse", service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0", ports = [8123] }
      prometheus = { kind = "prometheus", service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef1", ports = [9090] }
    }
  }
  assert {
    condition = (
      length(aws_security_group.privatelink) == 2 &&
      length(aws_security_group.privatelink_clients) == 2 &&
      length(aws_vpc_security_group_ingress_rule.privatelink) == 2 &&
      alltrue([for _, r in aws_vpc_security_group_ingress_rule.privatelink : r.cidr_ipv4 == null && r.cidr_ipv6 == null])
    )
    error_message = "One endpoint SG and one client SG per entry/kind, one rule per port, never a CIDR."
  }
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.privatelink["clickhouse-8123"].security_group_id == "sg-0fixtureepclickhouse" &&
      aws_vpc_security_group_ingress_rule.privatelink["clickhouse-8123"].referenced_security_group_id == "sg-0fixtureclickhouse" &&
      aws_vpc_security_group_ingress_rule.privatelink["clickhouse-8123"].from_port == 8123 &&
      aws_vpc_security_group_ingress_rule.privatelink["prometheus-9090"].security_group_id == "sg-0fixtureepprometheus" &&
      aws_vpc_security_group_ingress_rule.privatelink["prometheus-9090"].referenced_security_group_id == "sg-0fixtureprometheus" &&
      aws_vpc_security_group_ingress_rule.privatelink["prometheus-9090"].from_port == 9090
    )
    error_message = "Each endpoint SG must carry only its own entry's ports, admitted only from its own kind's client SG (no cross-entry port leakage)."
  }
  assert {
    condition = (
      aws_vpc_endpoint.privatelink["clickhouse"].vpc_endpoint_type == "Interface" &&
      aws_vpc_endpoint.privatelink["clickhouse"].private_dns_enabled == false &&
      aws_vpc_endpoint.privatelink["clickhouse"].subnet_ids == toset(var.existing_private_subnet_ids) &&
      aws_vpc_endpoint.privatelink["clickhouse"].vpc_id == var.existing_vpc_id &&
      aws_vpc_endpoint.privatelink["clickhouse"].security_group_ids == toset(["sg-0fixtureepclickhouse"]) &&
      aws_vpc_endpoint.privatelink["prometheus"].security_group_ids == toset(["sg-0fixtureepprometheus"])
    )
    error_message = "Each endpoint must be a private-DNS-off interface endpoint in the existing private subnets with its own SG."
  }
  assert {
    condition = (
      aws_lambda_function.agent["clickhouse-mcp"].vpc_config[0].security_group_ids == toset(["sg-0fixtureservice", "sg-0fixtureclickhouse"]) &&
      aws_lambda_function.agent["prometheus-mcp"].vpc_config[0].security_group_ids == toset(["sg-0fixtureservice", "sg-0fixtureprometheus"]) &&
      length(aws_lambda_function.agent["loki-mcp"].vpc_config) == 0
    )
    error_message = "A connector joins only its own kind's client SG; connectors without an endpoint stay outside it."
  }
}

run "privatelink_vpc_flagged_connector_without_endpoint_keeps_only_the_service_sg" {
  command = plan
  override_resource {
    target = aws_vpc_endpoint.privatelink["clickhouse"]
    values = { dns_entry = [{ dns_name = "vpce-0fixture-abc.vpce-svc-0123456789abcdef0.ap-northeast-2.vpce.amazonaws.com", hosted_zone_id = "ZFIXTURE" }] }
  }
  override_resource {
    target          = aws_security_group.service
    override_during = plan
    values          = { id = "sg-0fixtureservice" }
  }
  override_resource {
    target          = aws_security_group.privatelink_clients["clickhouse"]
    override_during = plan
    values          = { id = "sg-0fixtureclickhouse" }
  }
  variables {
    agentcore_enabled      = true
    integrations_enabled   = true
    clickhouse_vpc_enabled = true
    prometheus_vpc_enabled = true
    privatelink_endpoints = {
      clickhouse = { kind = "clickhouse", service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0", ports = [8123] }
    }
  }
  assert {
    condition = (
      aws_lambda_function.agent["prometheus-mcp"].vpc_config[0].security_group_ids == toset(["sg-0fixtureservice"]) &&
      length(aws_security_group.privatelink_clients) == 1
    )
    error_message = "A VPC-attached connector whose kind has no endpoint must not join any client SG."
  }
}

run "privatelink_rejects_duplicate_ports" {
  command = plan
  variables {
    agentcore_enabled      = true
    integrations_enabled   = true
    clickhouse_vpc_enabled = true
    privatelink_endpoints = {
      clickhouse = { kind = "clickhouse", service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0", ports = [8123, 8123] }
    }
  }
  expect_failures = [var.privatelink_endpoints]
}

run "privatelink_rejects_a_malformed_service_name" {
  command = plan
  variables {
    agentcore_enabled      = true
    integrations_enabled   = true
    clickhouse_vpc_enabled = true
    privatelink_endpoints = {
      clickhouse = { kind = "clickhouse", service_name = "com.amazonaws.vpce.ap-northeast-2.not-a-service", ports = [8123] }
    }
  }
  expect_failures = [var.privatelink_endpoints]
}

run "privatelink_requires_the_connector_vpc_flag" {
  command = plan
  variables {
    agentcore_enabled    = true
    integrations_enabled = true
    privatelink_endpoints = {
      prometheus = { kind = "prometheus", service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0", ports = [9090] }
    }
  }
  expect_failures = [var.privatelink_endpoints]
}

run "privatelink_zone_is_absent_by_default" {
  command = plan
  override_resource {
    target = aws_vpc_endpoint.privatelink["clickhouse"]
    values = { dns_entry = [{ dns_name = "vpce-0fixture-abc.vpce-svc-0123456789abcdef0.ap-northeast-2.vpce.amazonaws.com", hosted_zone_id = "ZFIXTURE" }] }
  }
  variables {
    agentcore_enabled      = true
    integrations_enabled   = true
    clickhouse_vpc_enabled = true
    privatelink_endpoints = {
      clickhouse = { kind = "clickhouse", service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0", ports = [8123] }
    }
  }
  assert {
    condition     = length(aws_route53_zone.privatelink) == 0 && length(aws_route53_record.privatelink) == 0 && length(output.privatelink_datasource_hosts) == 0
    error_message = "Without privatelink_zone_name no zone, record or friendly host may exist."
  }
}

run "privatelink_zone_adds_one_private_zone_and_a_cname_per_endpoint" {
  command = plan
  override_resource {
    target = aws_vpc_endpoint.privatelink["clickhouse"]
    values = { dns_entry = [{ dns_name = "vpce-0fixture-abc.vpce-svc-0123456789abcdef0.ap-northeast-2.vpce.amazonaws.com", hosted_zone_id = "ZFIXTURE" }] }
  }
  override_resource {
    target = aws_vpc_endpoint.privatelink["prometheus"]
    values = { dns_entry = [{ dns_name = "vpce-0fixture-def.vpce-svc-0fedcba9876543210.ap-northeast-2.vpce.amazonaws.com", hosted_zone_id = "ZFIXTURE" }] }
  }
  variables {
    agentcore_enabled                = true
    integrations_enabled             = true
    clickhouse_vpc_enabled           = true
    prometheus_vpc_enabled           = true
    privatelink_zone_records_enabled = true
    privatelink_zone_name            = "obs.awsops.internal"
    privatelink_endpoints = {
      clickhouse = { kind = "clickhouse", service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0", ports = [8123] }
      prometheus = { kind = "prometheus", service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0fedcba9876543210", ports = [9090] }
    }
  }
  assert {
    condition = (
      length(aws_route53_zone.privatelink) == 1 &&
      aws_route53_zone.privatelink[0].name == "obs.awsops.internal" &&
      length(aws_route53_zone.privatelink[0].vpc) == 1 &&
      one(aws_route53_zone.privatelink[0].vpc).vpc_id == var.existing_vpc_id &&
      length(aws_route53_record.privatelink) == 2 &&
      aws_route53_record.privatelink["clickhouse"].name == "clickhouse.obs.awsops.internal" &&
      aws_route53_record.privatelink["clickhouse"].type == "CNAME" &&
      aws_route53_record.privatelink["clickhouse"].ttl == 60 &&
      aws_route53_record.privatelink["prometheus"].name == "prometheus.obs.awsops.internal"
    )
    error_message = "A zone name must create one VPC-associated private zone and one 60s CNAME per endpoint key."
  }
  assert {
    condition     = output.privatelink_datasource_hosts == { clickhouse = "clickhouse.obs.awsops.internal", prometheus = "prometheus.obs.awsops.internal" }
    error_message = "The hosts output must list <key>.<zone> for every endpoint."
  }
  assert {
    condition     = alltrue([for _, ep in aws_vpc_endpoint.privatelink : ep.private_dns_enabled == false])
    error_message = "Endpoints keep private DNS off; names come from the optional zone only."
  }
}

run "privatelink_zone_without_endpoints_creates_nothing" {
  command = plan
  variables {
    privatelink_zone_name = "obs.awsops.internal"
  }
  assert {
    condition     = length(aws_route53_zone.privatelink) == 0 && length(aws_route53_record.privatelink) == 0
    error_message = "A zone name alone must not create a zone."
  }
}

run "privatelink_zone_rejects_a_trailing_dot" {
  command = plan
  variables {
    privatelink_zone_name = "obs.awsops.internal."
  }
  expect_failures = [var.privatelink_zone_name]
}

run "privatelink_zone_rejects_the_cloud_map_namespace_name" {
  command = plan
  variables {
    privatelink_zone_name = "awsops-fixture.internal"
  }
  expect_failures = [var.privatelink_zone_name]
}

run "privatelink_zone_without_the_records_flag_creates_the_zone_but_no_records" {
  command = plan
  variables {
    agentcore_enabled      = true
    integrations_enabled   = true
    clickhouse_vpc_enabled = true
    privatelink_zone_name  = "obs.awsops.internal"
    privatelink_endpoints = {
      clickhouse = { kind = "clickhouse", service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0", ports = [8123] }
    }
  }
  assert {
    condition     = length(aws_route53_zone.privatelink) == 1 && length(aws_route53_record.privatelink) == 0
    error_message = "Without privatelink_zone_records_enabled the zone exists but no CNAME is planned."
  }
}

run "privatelink_records_flag_requires_a_zone_name" {
  command = plan
  variables {
    privatelink_zone_records_enabled = true
  }
  expect_failures = [var.privatelink_zone_records_enabled]
}

run "privatelink_zone_rejects_the_public_domain_name" {
  command = plan
  variables {
    domain_name           = "v2.example.com"
    hosted_zone_name      = "example.com"
    privatelink_zone_name = "v2.example.com"
  }
  expect_failures = [var.privatelink_zone_name]
}

run "privatelink_zone_rejects_a_subdomain_of_the_hosted_zone" {
  command = plan
  variables {
    domain_name           = "v2.example.com"
    hosted_zone_name      = "example.com"
    privatelink_zone_name = "obs.example.com"
  }
  expect_failures = [var.privatelink_zone_name]
}

run "privatelink_zone_rejects_a_parent_of_the_hosted_zone" {
  command = plan
  variables {
    domain_name           = "v2.example.com"
    hosted_zone_name      = "example.com"
    privatelink_zone_name = "com"
  }
  expect_failures = [var.privatelink_zone_name]
}

run "privatelink_zone_rejects_amazonaws_com_names" {
  command = plan
  variables {
    privatelink_zone_name = "vpce.amazonaws.com"
  }
  expect_failures = [var.privatelink_zone_name]
}

run "privatelink_zone_accepts_an_unrelated_name" {
  command = plan
  variables {
    domain_name           = "v2.example.com"
    hosted_zone_name      = "example.com"
    privatelink_zone_name = "obs.awsops.internal"
  }
  assert {
    condition     = var.privatelink_zone_name == "obs.awsops.internal"
    error_message = "An internal zone name unrelated to the public domain must stay valid."
  }
}
