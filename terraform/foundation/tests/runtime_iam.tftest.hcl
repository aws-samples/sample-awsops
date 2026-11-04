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
      for p in [aws_iam_role_policy.agentcore[0].policy, aws_iam_role_policy.worker_diagnosis[0].policy,
      aws_iam_role_policy.worker_lambda_diagnosis[0].policy] :
      alltrue([for s in jsondecode(p).Statement : toset(s.Resource) == toset([
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
        "arn:aws:bedrock:*:123456789012:inference-profile/*anthropic.claude-*"])
      if contains(s.Action, "bedrock:InvokeModel")])
    ])
    error_message = "Model invocation must use the curated model/profile resources."
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
  variables {
    agentcore_enabled      = true
    integrations_enabled   = true
    clickhouse_vpc_enabled = true
    privatelink_endpoints = {
      clickhouse = { kind = "clickhouse", service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0", ports = [8123] }
    }
  }
  assert {
    condition = (
      length(aws_security_group.privatelink) == 1 &&
      length(aws_vpc_security_group_ingress_rule.privatelink) == 1 &&
      aws_vpc_security_group_ingress_rule.privatelink["clickhouse-8123"].from_port == 8123 &&
      aws_vpc_security_group_ingress_rule.privatelink["clickhouse-8123"].to_port == 8123 &&
      aws_vpc_security_group_ingress_rule.privatelink["clickhouse-8123"].cidr_ipv4 == null &&
      aws_vpc_security_group_ingress_rule.privatelink["clickhouse-8123"].cidr_ipv6 == null
    )
    error_message = "The endpoint SG must admit only the connector SG on the listed ports, with no CIDR rules."
  }
  assert {
    condition = (
      aws_vpc_endpoint.privatelink["clickhouse"].vpc_endpoint_type == "Interface" &&
      aws_vpc_endpoint.privatelink["clickhouse"].private_dns_enabled == false &&
      aws_vpc_endpoint.privatelink["clickhouse"].subnet_ids == toset(var.existing_private_subnet_ids) &&
      aws_vpc_endpoint.privatelink["clickhouse"].vpc_id == var.existing_vpc_id &&
      length(aws_lambda_function.agent["clickhouse-mcp"].vpc_config) == 1 &&
      length(aws_lambda_function.agent["prometheus-mcp"].vpc_config) == 0
    )
    error_message = "The endpoint must be a private-DNS-off interface endpoint in the existing private subnets and only the selected connector joins the VPC."
  }
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
    agentcore_enabled      = true
    integrations_enabled   = true
    clickhouse_vpc_enabled = true
    prometheus_vpc_enabled = true
    privatelink_zone_name  = "obs.awsops.internal"
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
