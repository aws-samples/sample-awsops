# Defaults preserve the ordinary all-at-once deployment. The dev CI controller
# chooses a monotonic stage from state and rejects any delete/replacement plan.
variable "defer_edge_until_dns" {
  type        = bool
  default     = false
  description = "Defer certificate validation waits, HTTPS listener and CloudFront for NEW pre-DNS stacks only. Existing stacks keep the edge."
}
variable "defer_dns_validation_records" {
  type        = bool
  default     = false
  description = "Defer ACM validation record management for manual DNS registration. Default preserves ordinary managed DNS."
}
variable "defer_dns_alias_records" {
  type        = bool
  default     = false
  description = "Defer public alias management for manual DNS registration. Default preserves ordinary managed DNS; never manages parent delegation."
}
variable "ci_deployment_enabled" {
  type        = bool
  default     = false
  description = "Provision the private one-off migration task and enforce immutable build tags."
}
variable "web_desired_count" {
  type    = number
  default = 1
  validation {
    condition     = var.web_desired_count >= 0 && floor(var.web_desired_count) == var.web_desired_count
    error_message = "web_desired_count must be a non-negative integer."
  }
}
variable "web_task_definition_arn" {
  type        = string
  default     = ""
  description = "CI-pinned web revision. Empty preserves Terraform's ordinary task definition behavior."
  validation {
    condition     = var.web_task_definition_arn == "" || can(regex("^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/${var.project}-web:[0-9]+$", var.web_task_definition_arn))
    error_message = "Expected this stack's web task-definition ARN."
  }
}

moved {
  from = aws_acm_certificate_validation.cf
  to   = aws_acm_certificate_validation.cf[0]
}
moved {
  from = aws_acm_certificate_validation.alb
  to   = aws_acm_certificate_validation.alb[0]
}
moved {
  from = aws_lb_listener.https
  to   = aws_lb_listener.https[0]
}
moved {
  from = aws_cloudfront_vpc_origin.alb
  to   = aws_cloudfront_vpc_origin.alb[0]
}
moved {
  from = aws_cloudfront_distribution.main
  to   = aws_cloudfront_distribution.main[0]
}

resource "aws_iam_role" "migration" {
  count              = var.ci_deployment_enabled ? 1 : 0
  name               = "${var.project}-migration"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy" "migration" {
  count = var.ci_deployment_enabled ? 1 : 0
  role  = aws_iam_role.migration[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = concat([aws_rds_cluster.aurora.master_user_secret[0].secret_arn],
        var.agentcore_enabled ? [aws_secretsmanager_secret.agent_sql_reader[0].arn] : [])
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.aurora.arn
        Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" }
        }
      }
    ]
  })
}
resource "aws_cloudwatch_log_group" "migration" {
  count             = var.ci_deployment_enabled ? 1 : 0
  name              = "/ecs/${var.project}-migration"
  retention_in_days = 30
}
resource "aws_ecs_task_definition" "migration" {
  count                    = var.ci_deployment_enabled ? 1 : 0
  family                   = "${var.project}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.migration[0].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  # CI clones this template with a built immutable digest before run-task. No
  # service or scheduler runs it; the DB master secret is read only at runtime.
  container_definitions = jsonencode([{
    name      = "migration"
    image     = "${aws_ecr_repository.web.repository_url}:migration-unbuilt"
    essential = true
    environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "AURORA_ENDPOINT", value = aws_rds_cluster.aurora.endpoint },
      { name = "AURORA_DATABASE", value = aws_rds_cluster.aurora.database_name },
      { name = "AURORA_SECRET_ARN", value = aws_rds_cluster.aurora.master_user_secret[0].secret_arn },
      { name = "SQL_READER_SECRET_ARN", value = var.agentcore_enabled ? aws_secretsmanager_secret.agent_sql_reader[0].arn : "" },
      { name = "INITIALIZE_EMPTY_DB", value = "1" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.migration[0].name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "migration"
      }
    }
  }])
}

output "deployment_config" {
  description = "CI coordination only; never publish wholesale to job summaries."
  value = {
    project                   = var.project
    smoke_email               = var.create_demo_user ? var.demo_email : null
    region                    = var.region
    edge_enabled              = !var.defer_edge_until_dns
    desired_count             = var.web_desired_count
    task_definition           = aws_ecs_service.web.task_definition
    web_template              = aws_ecs_task_definition.web.arn
    migration_task_definition = try(aws_ecs_task_definition.migration[0].arn, null)
    network = {
      awsvpcConfiguration = {
        subnets        = local.private_subnet_ids
        securityGroups = [aws_security_group.service.id]
        assignPublicIp = "DISABLED"
      }
    }
    certificates = [
      { arn = aws_acm_certificate.cf.arn, region = "us-east-1" },
      { arn = aws_acm_certificate.alb.arn, region = var.region }
    ]
    dns = {
      zone        = var.hosted_zone_name
      zone_id     = data.aws_route53_zone.main.zone_id
      nameservers = data.aws_route53_zone.main.name_servers
      validation = concat(
        [for dvo in aws_acm_certificate.cf.domain_validation_options : { name = dvo.resource_record_name, type = dvo.resource_record_type, value = dvo.resource_record_value }],
        [for dvo in aws_acm_certificate.alb.domain_validation_options : { name = dvo.resource_record_name, type = dvo.resource_record_type, value = dvo.resource_record_value }]
      )
      aliases     = concat([var.domain_name], var.extra_domain_aliases)
      target      = try(aws_cloudfront_distribution.main[0].domain_name, null)
      target_zone = try(aws_cloudfront_distribution.main[0].hosted_zone_id, null)
    }
  }
}

output "deployment_stage" {
  description = "Infrastructure stage only; CI reports deployed only after digest/health and authenticated HTTPS smoke checks."
  value       = !var.defer_edge_until_dns ? "awaiting_verification" : "awaiting_dns"
}
