# D1 inventory data layer — warm Steampipe Fargate (stateless FDW) + sync Lambda -> Aurora.
# All gated by var.steampipe_enabled (count=local.sp → 0 resources/cost when off).
locals { sp = var.steampipe_enabled ? 1 : 0 }

# ---- Steampipe DB password (network listener auth) ----
resource "random_password" "steampipe" {
  count   = local.sp
  length  = 24
  special = false
}
resource "aws_secretsmanager_secret" "steampipe" {
  count = local.sp
  name  = "${var.project}-steampipe-db"
}
resource "aws_secretsmanager_secret_version" "steampipe" {
  count         = local.sp
  secret_id     = aws_secretsmanager_secret.steampipe[0].id
  secret_string = random_password.steampipe[0].result
}

# ECS resolves the task def `secrets`/valueFrom with the EXECUTION role (not the task role).
# No task uses the Aurora master secret via valueFrom anymore (web + steampipe both authenticate
# via IAM DB auth instead — see the M1 note below), so this grants ONLY the Steampipe network-
# listener's own DB password secret, or the Steampipe task fails ResourceInitializationError on
# start. Gated so it stays plan-clean when disabled. No kms grant needed — the secret uses the
# default aws/secretsmanager key.
#
# NOTE (M1): this grants ONLY the Steampipe network-listener's own DB password secret — NOT the
# Aurora master secret. The boot-time aws.spc generator authenticates to Aurora via IAM database
# auth (rds-db:connect, granted on the TASK role below) as the dedicated least-privilege
# `steampipe_reader` role, so the master secret is never exposed to this task at all.
resource "aws_iam_role_policy" "execution_steampipe_secret" {
  count = local.sp
  name  = "${var.project}-exec-steampipe-secret"
  role  = aws_iam_role.execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.steampipe[0].arn] }]
  })
}

# ---- ECR + log groups ----
resource "aws_ecr_repository" "steampipe" {
  count                = local.sp
  name                 = "${var.project}-steampipe"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
  force_delete = true
}
resource "aws_cloudwatch_log_group" "steampipe" {
  count             = local.sp
  name              = "/ecs/${var.project}-steampipe"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_group" "inv_sync" {
  count             = local.sp
  name              = "/aws/lambda/${var.project}-inv-sync"
  retention_in_days = 30
}

# ---- Steampipe SG: ingress 9193 from the web service SG only ----
resource "aws_security_group" "steampipe" {
  count       = local.sp
  name        = "${var.project}-steampipe-sg"
  description = "Steampipe FDW - reachable from web/lambda service SG on 9193"
  vpc_id      = local.vpc_id
  ingress {
    description     = "Postgres FDW from service SG"
    from_port       = 9193
    to_port         = 9193
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---- Cloud Map service discovery so the sync Lambda finds Steampipe by DNS ----
resource "aws_service_discovery_private_dns_namespace" "main" {
  count = local.sp
  name  = "${var.project}.internal"
  vpc   = local.vpc_id
}
resource "aws_service_discovery_service" "steampipe" {
  count = local.sp
  name  = "steampipe"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main[0].id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config { failure_threshold = 1 }
}

# ---- Steampipe task role: ec2:Describe* + sts only (D1; expand per wave) ----
resource "aws_iam_role" "steampipe_task" {
  count              = local.sp
  name               = "${var.project}-steampipe-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy" "steampipe_task" {
  count = local.sp
  name  = "${var.project}-steampipe-read"
  role  = aws_iam_role.steampipe_task[0].id
  # ec2:Describe* covers ec2/vpc/subnet/security_group/ebs. Curated read-only metadata
  # actions per D2 wave (no object data, secrets, or KMS). Resource="*" — these list/describe
  # APIs don't support resource-level scoping. Far narrower than ReadOnlyAccess.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ec2:Describe*", "sts:GetCallerIdentity",
        "s3:ListAllMyBuckets", "s3:GetBucket*", "s3:GetAccountPublicAccessBlock", "s3:GetEncryptionConfiguration",
        "lambda:List*", "lambda:GetFunction*", "lambda:GetPolicy",
        "rds:Describe*", "rds:ListTagsForResource",
        "dynamodb:List*", "dynamodb:Describe*",
        "ecs:List*", "ecs:Describe*",
        "ecr:Describe*", "ecr:List*", "ecr:GetLifecyclePolicy", "ecr:GetRepositoryPolicy",
        "iam:List*", "iam:Get*", "iam:GenerateCredentialReport",
        # D3 wave
        "cloudfront:List*", "cloudfront:Get*",
        # L7 origin resolution: API Gateway v1/v2 read (single apigateway:GET action covers GetApis/
        # GetIntegrations) — Steampipe aws_api_gatewayv2_api/_integration tables.
        "apigateway:GET",
        "elasticloadbalancing:Describe*",
        "elasticache:Describe*", "elasticache:ListTagsForResource",
        "es:Describe*", "es:List*",
        "kafka:Describe*", "kafka:List*",
        "eks:Describe*", "eks:List*", # aws-data/eks-optimize 콜렉터: aws_eks_cluster 등 EKS 테이블
        "wafv2:List*", "wafv2:Get*",
        "cloudwatch:Describe*",
        "cloudtrail:Describe*", "cloudtrail:List*", "cloudtrail:GetTrailStatus", "cloudtrail:GetEventSelectors", "cloudtrail:GetInsightSelectors",
        "route53:List*", "route53:Get*"
      ]
      Resource = "*"
      },
      # Cross-account read-only fan-out: the aws.spc connections assume each target account's
      # AWSopsReadOnlyRole (1st-party: no ExternalId; 3rd-party: trust enforces it). Scoped to the
      # role NAME (route.ts hard-pins it) — never an arbitrary role.
      {
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = "arn:aws:iam::*:role/AWSopsReadOnlyRole"
      },
      # M1: IAM database auth — generate a short-lived signed token to connect to Aurora as the
      # dedicated least-privilege `steampipe_reader` role (SELECT-only on accounts/account_regions;
      # see the steampipe_reader migration). Scoped to this cluster's resource id + that exact
      # dbuser — the master secret is never granted to this task.
      {
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = "arn:aws:rds-db:${var.region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_rds_cluster.aurora.cluster_resource_id}/steampipe_reader"
    }]
  })
}

# ---- Steampipe Fargate service (warm, FARGATE_SPOT) ----
resource "aws_ecs_task_definition" "steampipe" {
  count                    = local.sp
  family                   = "${var.project}-steampipe"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.steampipe_task[0].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name         = "steampipe"
    image        = "${aws_ecr_repository.steampipe[0].repository_url}:${var.steampipe_image_tag}"
    essential    = true
    portMappings = [{ containerPort = 9193, protocol = "tcp" }]
    environment = [
      { name = "AWS_REGION", value = var.region },
      # boot-time aws.spc generator reaches Aurora to read accounts ⋈ account_regions via IAM
      # database auth (M1): AURORA_USER is a dedicated least-privilege role name — not a secret —
      # the entrypoint calls rds:generate-db-auth-token (task role, rds-db:connect above) for a
      # short-lived signed password. No Aurora secret of any kind is granted to this task.
      { name = "AURORA_ENDPOINT", value = aws_rds_cluster.aurora.endpoint },
      { name = "AURORA_DATABASE", value = aws_rds_cluster.aurora.database_name },
      { name = "AURORA_USER", value = "steampipe_reader" },
      { name = "STEAMPIPE_AWS_MAX_CONCURRENCY", value = tostring(var.steampipe_aws_max_concurrency) },
      { name = "STEAMPIPE_AWS_BUCKET_SIZE", value = tostring(var.steampipe_aws_bucket_size) },
      { name = "STEAMPIPE_AWS_FILL_RATE", value = tostring(var.steampipe_aws_fill_rate) },
    ]
    secrets = [
      { name = "STEAMPIPE_DATABASE_PASSWORD", valueFrom = aws_secretsmanager_secret.steampipe[0].arn },
    ]
    healthCheck = {
      command  = ["CMD-SHELL", "steampipe query \"select 1\" >/dev/null 2>&1 || exit 1"]
      interval = 30
      timeout  = 10
      # retries=5 (150s consecutive-failure tolerance) — NOT just the initial startup case.
      # startPeriod (below) only covers the FIRST health-check window after task launch; it does
      # NOT apply to a mid-life restart triggered by the scope watchdog (account/region change) or
      # a crash-recovery restart (gen_spc_entrypoint.py's supervisor loop). Such a restart's
      # worst-case downtime is terminate-wait(<=30s) + service-stop --force(<=30s) + Steampipe
      # embedded-PG reinit (~10-30s) - up to ~90s - which the prior retries=3 (90s) window left with
      # no margin, risking ECS treating the task as UNHEALTHY mid-restart and cycling it (the
      # "circuit breaker loop" CLAUDE.md warns about) (M-B fix).
      retries     = 5
      startPeriod = 120
    }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.steampipe[0].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "steampipe" }
    }
  }])
}
resource "aws_ecs_service" "steampipe" {
  count           = local.sp
  name            = "${var.project}-steampipe"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.steampipe[0].arn
  desired_count   = 1
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.steampipe[0].id]
    assign_public_ip = false
  }
  service_registries { registry_arn = aws_service_discovery_service.steampipe[0].arn }
  # Same cluster cost-attribution tagging as the web service — see workload.tf.
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
}
resource "aws_cloudwatch_metric_alarm" "steampipe_down" {
  count = local.sp
  # RunningTaskCount is a Container Insights metric (namespace ECS/ContainerInsights),
  # NOT AWS/ECS — AWS/ECS only carries CPU/MemoryUtilization. Referencing AWS/ECS left
  # the alarm permanently in INSUFFICIENT_DATA (zero data points). treat_missing_data =
  # "breaching" makes a missing metric (service scaled to 0 / deleted) count as down,
  # which is the point of a down-detector; when steampipe_enabled flips off the whole
  # alarm is destroyed (count=0), so this can't false-fire on intentional disable.
  alarm_name          = "${var.project}-steampipe-down"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.steampipe[0].name }
  statistic           = "Average"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 3
  treat_missing_data  = "breaching"
}

# ---- sync Lambda (VPC, pg8000 layer; queries Steampipe + writes Aurora) ----
resource "terraform_data" "inv_pg8000_build" {
  count            = local.sp
  triggers_replace = filemd5("${path.module}/../../../scripts/v2/steampipe/requirements.txt")
  provisioner "local-exec" {
    command = <<-EOT
      set -e
      rm -rf ${path.module}/.build/inv_layer
      mkdir -p ${path.module}/.build/inv_layer/python
      python3 -m pip install pg8000==1.31.2 --target ${path.module}/.build/inv_layer/python
    EOT
  }
}
data "archive_file" "inv_layer" {
  count       = local.sp
  type        = "zip"
  source_dir  = "${path.module}/.build/inv_layer"
  output_path = "${path.module}/.build/inv_layer.zip"
  depends_on  = [terraform_data.inv_pg8000_build]
}
resource "aws_lambda_layer_version" "inv_pg8000" {
  count                    = local.sp
  layer_name               = "${var.project}-inv-pg8000"
  filename                 = data.archive_file.inv_layer[0].output_path
  source_code_hash         = data.archive_file.inv_layer[0].output_base64sha256
  compatible_runtimes      = ["python3.12"]
  compatible_architectures = ["arm64"]
}
data "archive_file" "inv_sync_src" {
  count       = local.sp
  type        = "zip"
  output_path = "${path.module}/.build/inv_sync.zip"
  source {
    content  = file("${path.module}/../../../scripts/v2/steampipe/sync_lambda.py")
    filename = "sync_lambda.py"
  }
}
resource "aws_iam_role" "inv_sync" {
  count              = local.sp
  name               = "${var.project}-inv-sync"
  assume_role_policy = data.aws_iam_policy_document.worker_lambda_assume.json
}
resource "aws_iam_role_policy_attachment" "inv_sync_vpc" {
  count      = local.sp
  role       = aws_iam_role.inv_sync[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
resource "aws_iam_role_policy" "inv_sync" {
  count = local.sp
  name  = "${var.project}-inv-sync"
  role  = aws_iam_role.inv_sync[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*" },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.steampipe[0].arn, aws_rds_cluster.aurora.master_user_secret[0].secret_arn] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.aurora.arn },
      # self-invoke for type=all fan-out (async InvocationType=Event per type)
      { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = aws_lambda_function.inv_sync[0].arn },
      # SDK-sourced cloudfront_vpc_origin sync (Steampipe omits VpcOriginConfig): read-only CloudFront
      # list/get for VPC origins + per-distribution config. Read-only; no mutation.
      { Effect = "Allow", Action = ["cloudfront:ListVpcOrigins", "cloudfront:GetVpcOrigin", "cloudfront:ListDistributions", "cloudfront:GetDistributionConfig"], Resource = "*" },
      # SDK-sourced s3_public_access sync (Steampipe aws_s3_bucket public-access columns fail the whole
      # query on one denied bucket): read-only per-bucket public-access flags. Read-only; no mutation.
      { Effect = "Allow", Action = ["s3:ListAllMyBuckets", "s3:GetBucketLocation", "s3:GetBucketPolicyStatus", "s3:GetBucketPublicAccessBlock", "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration", "s3:GetBucketLogging", "s3:GetBucketTagging"], Resource = "*" },
      # SDK-sourced alb_listener_rule sync (Steampipe rule table needs a per-listener qualifier):
      # read-only ELBv2 describe for LBs/listeners/rules. Read-only; no mutation.
      { Effect = "Allow", Action = ["elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeRules"], Resource = "*" },
      # SDK-sourced opensearch_serverless sync (pinned Steampipe plugin lacks the AOSS table):
      # read-only collection list/detail. Read-only; no mutation.
      { Effect = "Allow", Action = ["aoss:ListCollections", "aoss:BatchGetCollection"], Resource = "*" }
      # NOTE (M2, round 5): the "0-row account" reachability probe queries the account's OWN
      # Steampipe connection directly (data path) instead of doing an independent sts:AssumeRole
      # from this Lambda — an AssumeRole only proves the IAM trust policy is intact, not that the
      # aggregator actually queried the account this run. No extra IAM permission is needed here;
      # Steampipe's own task role (steampipe_task, above) already holds the AssumeRole this
      # Lambda's probe rides on.
    ]
  })
}
resource "aws_lambda_function" "inv_sync" {
  count                          = local.sp
  function_name                  = "${var.project}-inv-sync"
  role                           = aws_iam_role.inv_sync[0].arn
  runtime                        = "python3.12"
  architectures                  = ["arm64"]
  handler                        = "sync_lambda.lambda_handler"
  filename                       = data.archive_file.inv_sync_src[0].output_path
  source_code_hash               = data.archive_file.inv_sync_src[0].output_base64sha256
  timeout                        = 120
  memory_size                    = 512
  layers                         = [aws_lambda_layer_version.inv_pg8000[0].arn]
  reserved_concurrent_executions = var.steampipe_sync_reserved_concurrency
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      STEAMPIPE_HOST       = "steampipe.${var.project}.internal"
      STEAMPIPE_SECRET_ARN = aws_secretsmanager_secret.steampipe[0].arn
      AURORA_ENDPOINT      = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE      = aws_rds_cluster.aurora.database_name
      AURORA_SECRET_ARN    = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
    }
  }
  depends_on = [aws_cloudwatch_log_group.inv_sync, aws_iam_role_policy_attachment.inv_sync_vpc]
}

resource "aws_lambda_function_event_invoke_config" "inv_sync" {
  count                        = local.sp
  function_name                = aws_lambda_function.inv_sync[0].function_name
  maximum_event_age_in_seconds = 900
  maximum_retry_attempts       = 0
}

# ---- scheduled sync (EventBridge rate(15m) -> ec2) ----
resource "aws_cloudwatch_event_rule" "inv_sync" {
  count               = local.sp
  name                = "${var.project}-inv-sync-ec2"
  schedule_expression = "rate(15 minutes)"
}
resource "aws_cloudwatch_event_target" "inv_sync" {
  count     = local.sp
  rule      = aws_cloudwatch_event_rule.inv_sync[0].name
  target_id = "inv-sync-ec2"
  arn       = aws_lambda_function.inv_sync[0].arn
  input     = jsonencode({ type = "all" })
  retry_policy {
    maximum_event_age_in_seconds = 900
    maximum_retry_attempts       = 0
  }
}
resource "aws_lambda_permission" "inv_sync_events" {
  count         = local.sp
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.inv_sync[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.inv_sync[0].arn
}

# ---- web task role may invoke the sync Lambda (refresh) ----
resource "aws_iam_role_policy" "task_inv_sync_invoke" {
  count = local.sp
  name  = "${var.project}-task-inv-sync-invoke"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = aws_lambda_function.inv_sync[0].arn }]
  })
}

output "inv_sync_function" { value = one(aws_lambda_function.inv_sync[*].function_name) }
output "steampipe_ecr_uri" { value = one(aws_ecr_repository.steampipe[*].repository_url) }
