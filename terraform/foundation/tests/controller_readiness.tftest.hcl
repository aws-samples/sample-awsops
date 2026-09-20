# Offline only: no backend, live credentials, provider calls or provisioner execution.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_regions" {
    defaults = { names = ["ap-northeast-2", "eu-west-1"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_vpc" {
    defaults = { cidr_block = "10.20.0.0/16" }
  }
  mock_data "aws_security_groups" {
    defaults = { ids = ["sg-0123456789abcdef0"] }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/fixture" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-fixture-web" }
  }
  mock_resource "aws_cognito_user_pool" {
    defaults = { id = "ap-northeast-2_fixture" }
  }
  mock_resource "aws_cognito_user_pool_client" {
    defaults = { id = "fixture-client" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { url = "https://sqs.ap-northeast-2.amazonaws.com/123456789012/awsops-fixture-jobs" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:ap-northeast-2:123456789012:key/11111111-1111-1111-1111-111111111111" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:fixture" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:ap-northeast-2:123456789012:cluster/awsops-fixture" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:ap-northeast-2:123456789012:function:fixture" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn    = "arn:aws:s3:::awsops-fixture-artifacts"
      bucket = "awsops-fixture-artifacts"
    }
  }
  mock_resource "aws_rds_cluster" {
    defaults = {
      arn                 = "arn:aws:rds:ap-northeast-2:123456789012:cluster:fixture"
      cluster_resource_id = "cluster-EXAMPLE"
      endpoint            = "fixture.cluster.example.test"
      master_user_secret = [{
        kms_key_id    = "mock-key"
        secret_arn    = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:mock"
        secret_status = "active"
      }]
    }
  }
}
mock_provider "aws" {
  alias           = "use1"
  override_during = plan
}
mock_provider "archive" {
  override_during = plan
}
mock_provider "random" {
  override_during = plan
}

override_resource {
  target          = aws_ecr_repository.agentcore[0]
  override_during = plan
  values = {
    arn            = "arn:aws:ecr:ap-northeast-2:123456789012:repository/awsops-fixture-agentcore"
    repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-fixture-agentcore"
  }
}
override_resource {
  target          = aws_ecr_repository.steampipe[0]
  override_during = plan
  values = {
    arn            = "arn:aws:ecr:ap-northeast-2:123456789012:repository/awsops-fixture-steampipe"
    repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-fixture-steampipe"
  }
}
override_resource {
  target          = aws_ecr_repository.worker[0]
  override_during = plan
  values = {
    arn            = "arn:aws:ecr:ap-northeast-2:123456789012:repository/awsops-fixture-worker"
    repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-fixture-worker"
  }
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

run "readiness_default_off" {
  command = plan
  variables { agentcore_enabled = true }
  assert {
    condition     = output.agentcore.deployment_readiness_enabled == false && length(aws_cognito_user_group.deployment_verifiers) == 0 && length(aws_cognito_user_in_group.demo_readiness) == 0
    error_message = "Readiness must default off with no verifier grant."
  }
}

run "readiness_enabled_output_and_verifier" {
  command = plan
  variables {
    agentcore_enabled    = true
    ci_readiness_enabled = true
    create_demo_user     = true
    demo_password        = "fixture-only-Password123!"
  }
  assert {
    condition     = [for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment : e.value if e.name == "SSM_RUNTIME_ARN_PARAM"] == ["/ops/${var.project}/agentcore/runtime_arn"]
    error_message = "Enabled AgentCore must advertise this web deployment's runtime parameter."
  }
  assert {
    condition     = output.agentcore.deployment_readiness_enabled == true && aws_cognito_user_group.deployment_verifiers[0].name == "deployment-verifiers" && aws_cognito_user_group.deployment_verifiers[0].role_arn == null
    error_message = "The applied flag must enable the runtime and only the application verifier group, without IAM role."
  }
  assert {
    condition     = aws_cognito_user_in_group.demo_readiness[0].group_name == "deployment-verifiers" && aws_cognito_user_in_group.demo_readiness[0].username == aws_cognito_user.demo[0].username
    error_message = "Only the managed demo identity is bound to the verifier group."
  }
}

run "disabled_agentcore_never_grants_verifier_access" {
  command = plan
  variables {
    agentcore_enabled    = false
    ci_readiness_enabled = true
  }
  assert {
    condition     = length(aws_cognito_user_group.deployment_verifiers) == 0 && length(aws_cognito_user_in_group.demo_readiness) == 0
    error_message = "A disabled AgentCore deployment must not create verifier membership."
  }
}

run "readiness_without_managed_demo" {
  command = plan
  variables {
    agentcore_enabled    = true
    ci_readiness_enabled = true
    create_demo_user     = false
  }
  assert {
    condition     = output.agentcore.deployment_readiness_enabled == true && length(aws_cognito_user_group.deployment_verifiers) == 1 && length(aws_cognito_user_in_group.demo_readiness) == 0
    error_message = "An absent managed demo must not create membership or change another user's identity."
  }
}

run "disabled_agent_has_no_provisioning_output" {
  command = plan
  assert {
    condition     = output.agentcore == null
    error_message = "Disabled AgentCore must not fabricate provisioning inputs."
  }
}
