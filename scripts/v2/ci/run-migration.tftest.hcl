mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_resource "aws_rds_cluster" {
    defaults = {
      endpoint = "example.cluster-abc.ap-northeast-2.rds.amazonaws.com"
      master_user_secret = [{
        kms_key_id    = "mock-key"
        secret_arn    = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-ABC123"
        secret_status = "active"
      }]
    }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:ap-northeast-2:123456789012:key/11111111-1111-1111-1111-111111111111" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-v2-dev-web" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ops/awsops-v2-dev/agent/sql-reader-ABC123" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:ap-northeast-2:123456789012:cluster/awsops-v2-dev" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/awsops-v2-dev-migration:1" }
  }
}

override_resource {
  target          = aws_iam_role.execution
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/awsops-v2-dev-task-execution" }
}
override_resource {
  target          = aws_iam_role.ci_migration
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/awsops-v2-dev-migration-task" }
}

run "default_off" {
  command = plan
  assert {
    condition = (
      length(aws_iam_role.ci_migration) == 0 &&
      length(aws_iam_role_policy.ci_migration) == 0 &&
      length(aws_cloudwatch_log_group.ci_migration) == 0 &&
      length(aws_ecs_task_definition.ci_migration) == 0 && output.migration_job == null
    )
    error_message = "Default-off migrations must add no resources or migration configuration."
  }
}

run "enabled" {
  command = plan
  variables { ci_migrations_enabled = true }
  assert {
    condition = (
      aws_ecs_task_definition.ci_migration[0].family == "awsops-v2-dev-migration" &&
      aws_ecs_task_definition.ci_migration[0].network_mode == "awsvpc" &&
      one(aws_ecs_task_definition.ci_migration[0].runtime_platform).cpu_architecture == "ARM64" &&
      aws_ecs_task_definition.ci_migration[0].requires_compatibilities == toset(["FARGATE"]) &&
      aws_ecs_task_definition.ci_migration[0].execution_role_arn == aws_iam_role.execution.arn &&
      output.migration_job.subnets == local.private_subnet_ids &&
      output.migration_job.security_groups == [aws_security_group.service.id]
    )
    error_message = "Migration must use ARM64 Fargate and the existing execution role/private service network."
  }
  assert {
    condition = (
      length(jsondecode(aws_ecs_task_definition.ci_migration[0].container_definitions)) == 1 &&
      one(jsondecode(aws_ecs_task_definition.ci_migration[0].container_definitions)).image == "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-v2-dev-web:migration-unbuilt" &&
      !can(one(jsondecode(aws_ecs_task_definition.ci_migration[0].container_definitions)).secrets) &&
      !can(one(jsondecode(aws_ecs_task_definition.ci_migration[0].container_definitions)).command) &&
      !can(one(jsondecode(aws_ecs_task_definition.ci_migration[0].container_definitions)).entryPoint) &&
      one(jsondecode(aws_ecs_task_definition.ci_migration[0].container_definitions)).readonlyRootFilesystem &&
      one(jsondecode(aws_ecs_task_definition.ci_migration[0].container_definitions)).user == "1000:1000"
    )
    error_message = "The non-launchable template must defer to the image CMD and keep secrets out of ECS injection."
  }
  assert {
    condition = (
      { for v in one(jsondecode(aws_ecs_task_definition.ci_migration[0].container_definitions)).environment : v.name => v.value } == {
        AWS_REGION            = "ap-northeast-2"
        AURORA_ENDPOINT       = "example.cluster-abc.ap-northeast-2.rds.amazonaws.com"
        AURORA_DATABASE       = "awsops"
        AURORA_SECRET_ARN     = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-ABC123"
        SQL_READER_SECRET_ARN = ""
        SQL_READER_SYNC_MODE  = "disabled"
        INITIALIZE_EMPTY_DB   = "1"
      }
    )
    error_message = "The container receives exactly the runtime nonsecret interface."
  }
  assert {
    condition = (
      jsondecode(aws_iam_role_policy.ci_migration[0].policy).Statement[0].Action == ["secretsmanager:GetSecretValue"] &&
      jsondecode(aws_iam_role_policy.ci_migration[0].policy).Statement[0].Resource == [
        "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-ABC123"
      ] &&
      jsondecode(aws_iam_role_policy.ci_migration[0].policy).Statement[1].Action == ["kms:Decrypt"] &&
      jsondecode(aws_iam_role_policy.ci_migration[0].policy).Statement[1].Resource == [
        "arn:aws:kms:ap-northeast-2:123456789012:key/11111111-1111-1111-1111-111111111111"
      ] &&
      jsondecode(aws_iam_role_policy.ci_migration[0].policy).Statement[1].Condition.StringEquals["kms:ViaService"] == "secretsmanager.ap-northeast-2.amazonaws.com" &&
      jsondecode(aws_iam_role_policy.ci_migration[0].policy).Statement[1].Condition.StringEquals["kms:EncryptionContext:SecretARN"] == "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-ABC123"
    )
    error_message = "Runtime IAM must read only its own master secret and decrypt only via Secrets Manager."
  }
  assert {
    condition = (
      jsondecode(aws_iam_role.ci_migration[0].assume_role_policy).Statement[0].Principal.Service == "ecs-tasks.amazonaws.com" &&
      jsondecode(aws_iam_role.ci_migration[0].assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012"
    )
    error_message = "Migration task trust must be service- and account-scoped."
  }
}

run "agent_reader_enabled" {
  command = plan
  variables {
    ci_migrations_enabled = true
    agentcore_enabled     = true
  }
  assert {
    condition = (
      jsondecode(aws_iam_role_policy.ci_migration[0].policy).Statement[0].Resource == [
        "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-example-ABC123",
        "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ops/awsops-v2-dev/agent/sql-reader-ABC123"
      ] &&
      { for v in one(jsondecode(aws_ecs_task_definition.ci_migration[0].container_definitions)).environment : v.name => v.value }["SQL_READER_SYNC_MODE"] == "secret" &&
      { for v in one(jsondecode(aws_ecs_task_definition.ci_migration[0].container_definitions)).environment : v.name => v.value }["SQL_READER_SECRET_ARN"] == "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:ops/awsops-v2-dev/agent/sql-reader-ABC123"
    )
    error_message = "Only AgentCore-enabled migrations may read and sync the project's SQL reader secret."
  }
}
