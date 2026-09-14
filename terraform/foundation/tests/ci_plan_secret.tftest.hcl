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

run "plan_secret_grant_default_off" {
  command = plan
  variables { steampipe_enabled = true }
  assert {
    condition     = length(aws_iam_role_policy.ci_plan_steampipe_read) == 0
    error_message = "The plan-role secret grant must be explicitly configured."
  }
}

run "plan_secret_grant_scoped_to_owned_secret" {
  command = plan
  variables {
    steampipe_enabled           = true
    ci_terraform_plan_role_name = "sample-awsops-ci-terraform-plan"
  }
  assert {
    condition = (
      aws_iam_role_policy.ci_plan_steampipe_read[0].role == var.ci_terraform_plan_role_name &&
      aws_iam_role_policy.ci_plan_steampipe_read[0].name == "${var.project}-ci-plan-steampipe-read" &&
      jsondecode(aws_iam_role_policy.ci_plan_steampipe_read[0].policy).Statement[0].Action == ["secretsmanager:GetSecretValue"] &&
      jsondecode(aws_iam_role_policy.ci_plan_steampipe_read[0].policy).Statement[0].Resource == [aws_secretsmanager_secret.steampipe[0].arn]
    )
    error_message = "The CI plan role may read only the owned Steampipe secret, without mutation or wildcard grants."
  }
}

run "disabled_inventory_has_no_plan_secret_grant" {
  command = plan
  variables { ci_terraform_plan_role_name = "sample-awsops-ci-terraform-plan" }
  assert {
    condition     = length(aws_iam_role_policy.ci_plan_steampipe_read) == 0
    error_message = "An inactive inventory stack must not grant secret access."
  }
}
