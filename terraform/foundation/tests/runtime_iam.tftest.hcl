# Offline only: no backend, live credentials, provider calls or provisioner execution.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_regions" { defaults = { names = ["ap-northeast-2", "eu-west-1"] } }
  mock_data "aws_iam_policy_document" { defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" } }
  mock_data "aws_vpc" { defaults = { cidr_block = "10.20.0.0/16" } }
  mock_data "aws_security_groups" { defaults = { ids = ["sg-0123456789abcdef0"] } }
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
    condition     = output.runtime_deployment.inventory.sync_code_sha256 == null
    error_message = "Disabled inventory must not publish a collector fingerprint."
  }
  assert {
    condition     = (length(aws_iam_role_policy.agentcore) == 0 && length(aws_iam_role_policy.official_mcp_credentials) == 0 && length(aws_iam_role_policy.steampipe_task) == 0 && length(aws_iam_role_policy.worker_lambda) == 0 && !var.inventory_host_only && var.steampipe_image_digest == null && var.worker_image_digest == null && !var.remediation_enabled && !var.diagnosis_notify_enabled && !var.integrations_write_enabled)
    error_message = "Core runtime and host/image overrides must remain opt-in."
  }
}

run "inventory_fingerprint_uses_the_deployed_archive" {
  command = plan
  variables {
    steampipe_enabled = true
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
    agentcore_enabled      = true
    workers_enabled        = true
    steampipe_enabled      = true
    inventory_host_only    = true
    steampipe_image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    worker_image_digest    = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
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
