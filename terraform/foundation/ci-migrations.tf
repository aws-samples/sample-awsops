# One-off operator migration capability. Only the existing saved-plan Terraform
# workflow provisions this substrate; nothing schedules or starts the template.
variable "ci_migrations_enabled" {
  type        = bool
  default     = false
  nullable    = false
  description = "Provision the private CI migration template. Dev CI reads CI_MIGRATIONS_ENABLED_DEV; other stacks default off."
}

resource "aws_iam_role" "ci_migration" {
  count = var.ci_migrations_enabled ? 1 : 0
  name  = "${var.project}-migration-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        # ECS task trust does not support limiting SourceArn to one cluster.
        ArnLike = { "aws:SourceArn" = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "ci_migration" {
  count = var.ci_migrations_enabled ? 1 : 0
  name  = "${var.project}-migration-secrets"
  role  = aws_iam_role.ci_migration[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = concat(
          [aws_rds_cluster.aurora.master_user_secret[0].secret_arn],
          local.ac_count > 0 ? [aws_secretsmanager_secret.agent_sql_reader[0].arn] : []
        )
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.aurora.arn]
        Condition = {
          StringEquals = {
            "kms:ViaService"                  = "secretsmanager.${var.region}.amazonaws.com"
            "kms:EncryptionContext:SecretARN" = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
          }
        }
      }
    ]
  })
  # The optional SQL-reader secret uses aws/secretsmanager, not the Aurora CMK.
}

resource "aws_cloudwatch_log_group" "ci_migration" {
  count             = var.ci_migrations_enabled ? 1 : 0
  name              = "/ecs/${var.project}-migration"
  retention_in_days = 14
}

resource "aws_ecs_task_definition" "ci_migration" {
  count                    = var.ci_migrations_enabled ? 1 : 0
  family                   = "${var.project}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.ci_migration[0].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name                   = "migration"
    image                  = "${aws_ecr_repository.web.repository_url}:migration-unbuilt"
    essential              = true
    user                   = "1000:1000"
    readonlyRootFilesystem = true
    stopTimeout            = 30
    # Secret ARNs are identifiers; the task reads credentials into memory through
    # Secrets Manager. No ECS secrets injection, passwords, command or ENTRYPOINT.
    environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "AURORA_ENDPOINT", value = aws_rds_cluster.aurora.endpoint },
      { name = "AURORA_DATABASE", value = aws_rds_cluster.aurora.database_name },
      { name = "AURORA_SECRET_ARN", value = aws_rds_cluster.aurora.master_user_secret[0].secret_arn },
      { name = "SQL_READER_SECRET_ARN", value = local.ac_count > 0 ? aws_secretsmanager_secret.agent_sql_reader[0].arn : "" },
      { name = "SQL_READER_SYNC_MODE", value = local.ac_count > 0 ? "secret" : "disabled" },
      { name = "INITIALIZE_EMPTY_DB", value = "1" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.ci_migration[0].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "migration"
      }
    }
  }])
  depends_on = [aws_iam_role_policy.ci_migration]
}

output "migration_job" {
  description = "Nonsecret private migration configuration; null unless ci_migrations_enabled. The template is never launched directly."
  value = var.ci_migrations_enabled ? {
    project           = var.project
    region            = var.region
    cluster           = aws_ecs_cluster.main.arn
    task_template_arn = aws_ecs_task_definition.ci_migration[0].arn
    repository_url    = aws_ecr_repository.web.repository_url
    subnets           = local.private_subnet_ids
    security_groups   = [aws_security_group.service.id]
    log_group         = aws_cloudwatch_log_group.ci_migration[0].name
  } : null
}
