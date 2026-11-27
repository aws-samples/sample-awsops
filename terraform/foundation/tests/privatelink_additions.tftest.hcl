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
  mock_resource "aws_vpc_endpoint" {
    defaults = { dns_entry = [{ dns_name = "vpce-fixture.example.test", hosted_zone_id = "ZFIXTURE" }] }
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
  project                          = "awsops-fixture"
  region                           = "ap-northeast-2"
  domain_name                      = "dev.example.com"
  hosted_zone_name                 = "example.com"
  publish_service_dns              = false
  existing_cf_certificate_arn      = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  existing_alb_certificate_arn     = "arn:aws:acm:ap-northeast-2:123456789012:certificate/22222222-2222-2222-2222-222222222222"
  create_network                   = false
  existing_vpc_id                  = "vpc-0123456789abcdef0"
  existing_private_subnet_ids      = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
  agentcore_enabled                = true
  integrations_enabled             = true
  clickhouse_vpc_enabled           = true
  privatelink_zone_name            = "obs.fixture.internal"
  privatelink_zone_records_enabled = true
}

run "new_pending_endpoint_preserves_existing_dns" {
  command = plan
  variables {
    privatelink_endpoints = {
      existing = {
        kind         = "clickhouse"
        service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0"
        ports        = [8123]
      }
      extra = {
        kind         = "clickhouse"
        service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef1"
        ports        = [8123]
        publish_dns  = false
      }
    }
  }
  assert {
    condition     = toset(keys(aws_vpc_endpoint.privatelink)) == toset(["existing", "extra"])
    error_message = "Both endpoint connections must remain in the plan."
  }
  assert {
    condition     = toset(keys(aws_route53_record.privatelink)) == toset(["existing"])
    error_message = "The pending endpoint must not remove existing DNS or create its own record."
  }
  assert {
    condition     = toset(keys(output.privatelink_datasource_hosts)) == toset(["existing"])
    error_message = "Do not advertise a friendly hostname for the deferred record."
  }
  assert {
    condition     = toset(keys(aws_security_group.privatelink_clients)) == toset(["clickhouse"])
    error_message = "A second ClickHouse endpoint must reuse only the ClickHouse connector group."
  }
}

run "accepted_endpoint_can_publish_its_dns" {
  command = plan
  variables {
    privatelink_endpoints = {
      existing = {
        kind         = "clickhouse"
        service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef0"
        ports        = [8123]
      }
      extra = {
        kind         = "clickhouse"
        service_name = "com.amazonaws.vpce.ap-northeast-2.vpce-svc-0123456789abcdef1"
        ports        = [8123]
        publish_dns  = true
      }
    }
  }
  assert {
    condition     = toset(keys(aws_route53_record.privatelink)) == toset(["existing", "extra"])
    error_message = "Explicit DNS enablement must add the accepted endpoint without replacing the existing record."
  }
}
