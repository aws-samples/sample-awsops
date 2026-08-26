# AWSops v2 P2 — async worker backbone (SQS → dispatcher → Step Functions → Lambda/Fargate).
# EVERY resource here is gated by var.workers_enabled (default false → count=0 → zero AWS
# resources and zero cost). Enable only in P2 W9. Design refs: ADR-029/030 + the P2 spec/plan.
# Key decisions baked in:
#   C1  pg8000 vendored as a Lambda LAYER (worker/status/reaper import pg8000; dispatcher does not).
#   C5  SFN role carries ecs:RunTask + StopTask + DescribeTasks + iam:PassRole + the .sync managed rule.
#   C8  workers REUSE aws_security_group.service (no new SG; Aurora SG already allows it → no drift).
#   C11 the SQS→dispatcher ESM depends_on the dispatcher SQS-consume policy.
#   C14 the dispatcher has its own MINIMAL role (StartExecution + SQS consume + logs only).

locals {
  we           = var.workers_enabled ? 1 : 0
  workers_src  = "${path.module}/../../../scripts/v2/workers"
  worker_cname = "worker" # MUST equal the ContainerOverrides Name in sfn.asl.json
  acct         = data.aws_caller_identity.current.account_id
  # ai-cost aggregator gate — reuses the worker role/pg8000 layer/VPC, so it REQUIRES workers_enabled.
  act = var.workers_enabled && var.ai_cost_tracking_enabled ? 1 : 0
  # datasource-diagnosis egress gate (ADR-039/041) — requires workers_enabled. Grants the worker role
  # lambda:InvokeFunction on the 5 connector Lambdas + sets the enabling env. Default false → 0/$0.
  dsd = var.workers_enabled && var.datasource_diagnosis_enabled ? 1 : 0
  ds_connector_arns = [for k in ["prometheus", "loki", "tempo", "mimir", "clickhouse"] :
  "arn:aws:lambda:${var.region}:${local.acct}:function:${var.project}-agent-${k}-mcp"]
  # env that turns collect_datasources on (only when the gate is set) — kept as a list/map fragment so
  # it's concat/merge-appended to the worker task def + Lambda envs below.
  ds_env_list = local.dsd == 1 ? [
    { name = "DIAG_DATASOURCES_ENABLED", value = "true" },
    { name = "HOST_ACCOUNT_ID", value = local.acct },
    { name = "PROJECT", value = var.project },
  ] : []
  ds_env_map = local.dsd == 1 ? {
    DIAG_DATASOURCES_ENABLED = "true"
    HOST_ACCOUNT_ID          = local.acct
    PROJECT                  = var.project
  } : {}
  # graph_querygen (hybrid LLM fallback for non-standard ClickHouse schemas, registry-driven graph
  # sources design 2026-07-08) — requires datasource_diagnosis_enabled (runs INSIDE the same
  # datasource_index job, needs the same PROJECT/connector-invoke plumbing). bedrock:InvokeModel is
  # ALREADY granted to worker_lambda via worker_lambda_diagnosis (same Haiku/global-inference-profile
  # scope) — this gate only adds the env flag + (best-effort, optional) Code Interpreter IAM below.
  # Default false → 0 resources/IAM, $0.
  gqg         = local.dsd == 1 && var.graph_querygen_enabled ? 1 : 0
  gqg_env_map = local.gqg == 1 ? { GRAPH_QUERYGEN_ENABLED = "true" } : {}
  # scheduled auto-diagnosis dispatcher gate — reuses the worker role/pg8000 layer/VPC + the jobs queue,
  # so it REQUIRES workers_enabled. Default false → 0 resources, $0, no scheduled runs.
  sched = var.workers_enabled && var.diagnosis_schedule_enabled ? 1 : 0

  # AI Insights gate — requires workers_enabled. Grants the worker role read-only CloudWatch/Cost/EKS
  # describe + SendMessage, wires the runtime flag + cluster list, and creates the daily dispatcher.
  # Default false → 0 resources, $0. (EKS event access-entry is out-of-band: register-insight-access.sh.)
  aii = var.workers_enabled && var.ai_insights_enabled ? 1 : 0
  insight_env_list = local.aii == 1 ? [
    { name = "AI_INSIGHTS_ENABLED", value = "true" },
    { name = "ONBOARD_EKS_CLUSTERS", value = join(",", var.onboard_eks_clusters) },
  ] : []
  insight_env_map = local.aii == 1 ? {
    AI_INSIGHTS_ENABLED  = "true"
    ONBOARD_EKS_CLUSTERS = join(",", var.onboard_eks_clusters)
  } : {}
}

############################################################
# SQS job queue + DLQ
############################################################
resource "aws_sqs_queue" "jobs_dlq" {
  count                     = local.we
  name                      = "${var.project}-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days — poison-message sink
}

resource "aws_sqs_queue" "jobs" {
  count                      = local.we
  name                       = "${var.project}-jobs"
  visibility_timeout_seconds = 180 # > dispatcher Lambda timeout (60s) with margin
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq[0].arn
    maxReceiveCount     = 5
  })
}

############################################################
# Lambda packaging
#   - function code: one zip from the shared workers/ sources (handler selects the module)
#   - pg8000 as a LAYER (C1): built via pip into .build/, attached to worker/status/reaper only
############################################################
data "archive_file" "workers_src" {
  count       = local.we
  type        = "zip"
  output_path = "${path.module}/.build/workers_src.zip"
  source {
    content  = file("${local.workers_src}/db.py")
    filename = "db.py"
  }
  source {
    content  = file("${local.workers_src}/handlers.py")
    filename = "handlers.py"
  }
  source {
    content  = file("${local.workers_src}/worker_lambda.py")
    filename = "worker_lambda.py"
  }
  source {
    content  = file("${local.workers_src}/status_updater.py")
    filename = "status_updater.py"
  }
  source {
    content  = file("${local.workers_src}/reaper.py")
    filename = "reaper.py"
  }
  source {
    content  = file("${local.workers_src}/dispatcher.py")
    filename = "dispatcher.py"
  }
  source {
    content  = file("${local.workers_src}/ai_cost_aggregator.py")
    filename = "ai_cost_aggregator.py"
  }
  source {
    content  = file("${local.workers_src}/ai_cost/aggregate.py")
    filename = "aggregate.py"
  }
  # datasource_index handler (REGISTRY 'datasource_index', lambda runtime) + its catalogs. Flattened —
  # datasource_index.py falls back to `import signal_catalog` when the diagnosis package isn't
  # bundled; graph_catalog.py/graph_querygen.py are always flat (they never lived under a package).
  source {
    content  = file("${local.workers_src}/datasource_index.py")
    filename = "datasource_index.py"
  }
  source {
    content  = file("${local.workers_src}/diagnosis/signal_catalog.py")
    filename = "signal_catalog.py"
  }
  source {
    content  = file("${local.workers_src}/graph_catalog.py")
    filename = "graph_catalog.py"
  }
  source {
    content  = file("${local.workers_src}/graph_querygen.py")
    filename = "graph_querygen.py"
  }
  # AI Insights: the `insight` REGISTRY handler (job.py) + collectors. The `insight/` package structure
  # is PRESERVED in the zip (NOT flattened) so `from insight.x import …` resolves at runtime.
  source {
    content  = file("${local.workers_src}/insight/__init__.py")
    filename = "insight/__init__.py"
  }
  source {
    content  = file("${local.workers_src}/insight/job.py")
    filename = "insight/job.py"
  }
  source {
    content  = file("${local.workers_src}/insight/cost_anomalies.py")
    filename = "insight/cost_anomalies.py"
  }
  source {
    content  = file("${local.workers_src}/insight/cw_anomalies.py")
    filename = "insight/cw_anomalies.py"
  }
  source {
    content  = file("${local.workers_src}/insight/k8s_events.py")
    filename = "insight/k8s_events.py"
  }
  source {
    content  = file("${local.workers_src}/insight/generate.py")
    filename = "insight/generate.py"
  }
}

# pg8000 (pure-Python; works on any arch incl. arm64 Lambda). Rebuilt only when requirements change.
resource "terraform_data" "pg8000_layer_build" {
  count            = local.we
  triggers_replace = filemd5("${local.workers_src}/requirements.txt")
  provisioner "local-exec" {
    command = <<-EOT
      set -e
      rm -rf ${path.module}/.build/pg8000_layer
      mkdir -p ${path.module}/.build/pg8000_layer/python
      python3 -m pip install pg8000==1.31.2 --target ${path.module}/.build/pg8000_layer/python
    EOT
  }
}

data "archive_file" "pg8000_layer" {
  count       = local.we
  type        = "zip"
  source_dir  = "${path.module}/.build/pg8000_layer"
  output_path = "${path.module}/.build/pg8000_layer.zip"
  depends_on  = [terraform_data.pg8000_layer_build]
}

resource "aws_lambda_layer_version" "pg8000" {
  count                    = local.we
  layer_name               = "${var.project}-pg8000"
  filename                 = data.archive_file.pg8000_layer[0].output_path
  source_code_hash         = data.archive_file.pg8000_layer[0].output_base64sha256
  compatible_runtimes      = ["python3.12"]
  compatible_architectures = ["arm64"]
}

############################################################
# IAM — dispatcher (MINIMAL, C14) + worker-lambda (VPC+Aurora) + worker-task + SFN
############################################################
data "aws_iam_policy_document" "worker_lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---- dispatcher role: StartExecution + SQS consume + logs ONLY (C14) ----
resource "aws_iam_role" "dispatcher" {
  count              = local.we
  name               = "${var.project}-dispatcher"
  assume_role_policy = data.aws_iam_policy_document.worker_lambda_assume.json
}

resource "aws_iam_role_policy" "dispatcher" {
  count = local.we
  name  = "${var.project}-dispatcher"
  role  = aws_iam_role.dispatcher[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.acct}:*"
      },
      {
        Sid      = "SqsConsume"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.jobs[0].arn
      },
      {
        Sid      = "StartSfn"
        Effect   = "Allow"
        Action   = ["states:StartExecution"]
        Resource = aws_sfn_state_machine.workers[0].arn
      }
    ]
  })
}

# ---- worker/status/reaper shared role: VPC ENI + Aurora secret + KMS + logs ----
resource "aws_iam_role" "worker_lambda" {
  count              = local.we
  name               = "${var.project}-worker-lambda"
  assume_role_policy = data.aws_iam_policy_document.worker_lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "worker_lambda_vpc" {
  count      = local.we
  role       = aws_iam_role.worker_lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "worker_lambda" {
  count = local.we
  name  = "${var.project}-worker-lambda"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.acct}:*"
      },
      {
        # RDS IAM database auth: db.py generates a short-lived signed token (rds-db:connect) per
        # connect() to authenticate as the dedicated least-privilege `awsops_worker` Postgres role
        # (see the awsops_worker_role migration) instead of the Aurora master secret — the master
        # secret is never granted to this role at all now. Mirrors workload.tf's task_rds_iam_auth.
        Sid      = "AuroraIamAuth"
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = "arn:aws:rds-db:${var.region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_rds_cluster.aurora.cluster_resource_id}/awsops_worker"
      },
      {
        # reaper kill-switch check: GetEventSourceMapping has no resource-level scoping → "*".
        # Read-only; the slight over-grant to worker/status is acceptable & documented.
        Sid      = "ReaperReadEsm"
        Effect   = "Allow"
        Action   = ["lambda:GetEventSourceMapping"]
        Resource = "*"
      }
    ]
  })
}

# ---- worker Fargate task role: RDS IAM auth (db.py generates a signed token via boto3) ----
resource "aws_iam_role" "worker_task" {
  count              = local.we
  name               = "${var.project}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json # reuse (workload.tf)
}

resource "aws_iam_role_policy" "worker_task" {
  count = local.we
  name  = "${var.project}-worker-task"
  role  = aws_iam_role.worker_task[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = "arn:aws:rds-db:${var.region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_rds_cluster.aurora.cluster_resource_id}/awsops_worker"
      }
    ]
  })
}

# CIS compliance (`compliance` job): the Fargate worker reads the Steampipe FDW password at runtime
# (boto3 → task role) to build POWERPIPE_DATABASE. Gated on BOTH workers AND steampipe being enabled
# so the steampipe secret is only referenced when it exists. The secret uses the default
# aws/secretsmanager key → no extra KMS grant needed (see steampipe.tf).
resource "aws_iam_role_policy" "worker_task_steampipe_secret" {
  count = local.we * local.sp
  name  = "${var.project}-worker-task-steampipe-secret"
  role  = aws_iam_role.worker_task[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.steampipe[0].arn
    }]
  })
}

# ---- Step Functions role (C5 + .sync managed-rule perms) ----
resource "aws_iam_role" "sfn" {
  count = local.we
  name  = "${var.project}-workers-sfn"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "sfn" {
  count = local.we
  name  = "${var.project}-workers-sfn"
  role  = aws_iam_role.sfn[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeWorkers"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = [aws_lambda_function.worker[0].arn, aws_lambda_function.status_updater[0].arn]
      },
      {
        Sid      = "RunWorkerTask"
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = "arn:aws:ecs:${var.region}:${local.acct}:task-definition/${var.project}-worker:*"
      },
      {
        # .sync (runTask.sync) needs StopTask (on SFN timeout/abort) + DescribeTasks (poll). C5.
        Sid      = "ControlTasks"
        Effect   = "Allow"
        Action   = ["ecs:StopTask", "ecs:DescribeTasks"]
        Resource = "*"
      },
      {
        # RunTask's EnableECSManagedTags+PropagateTags (sfn.asl.json) tags the started task —
        # AWS requires ecs:TagResource on the caller for that, even though the tag itself is
        # AWS-generated (aws:ecs:clusterName). Task ARNs are per-run, so wildcard like ControlTasks.
        Sid      = "TagRunTasks"
        Effect   = "Allow"
        Action   = ["ecs:TagResource"]
        Resource = "*"
        Condition = {
          StringEquals = { "ecs:CreateAction" = "RunTask" }
        }
      },
      {
        Sid      = "PassTaskRoles"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.execution.arn, aws_iam_role.worker_task[0].arn]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
      {
        # runTask.sync uses an EventBridge managed rule to get task-state-change events.
        Sid      = "EcsSyncManagedRule"
        Effect   = "Allow"
        Action   = ["events:PutTargets", "events:PutRule", "events:DescribeRule"]
        Resource = "arn:aws:events:${var.region}:${local.acct}:rule/StepFunctionsGetEventsForECSTaskRule"
      },
      {
        Sid      = "SfnLogging"
        Effect   = "Allow"
        Action   = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"]
        Resource = "*"
      }
    ]
  })
}

############################################################
# ECR (worker image) + CloudWatch log groups
############################################################
resource "aws_ecr_repository" "worker" {
  count                = local.we
  name                 = "${var.project}-worker"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  force_delete = true
}

resource "aws_cloudwatch_log_group" "worker_fargate" {
  count             = local.we
  name              = "/ecs/${var.project}-worker"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_group" "dispatcher" {
  count             = local.we
  name              = "/aws/lambda/${var.project}-dispatcher"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_group" "worker_fn" {
  count             = local.we
  name              = "/aws/lambda/${var.project}-worker"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_group" "status_updater" {
  count             = local.we
  name              = "/aws/lambda/${var.project}-status-updater"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_group" "reaper" {
  count             = local.we
  name              = "/aws/lambda/${var.project}-reaper"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_group" "sfn" {
  count             = local.we
  name              = "/aws/vendedlogs/states/${var.project}-workers"
  retention_in_days = 30
}

############################################################
# Worker Fargate task definition (the long/heavy + OOM-demo path)
############################################################
resource "aws_ecs_task_definition" "worker" {
  count                    = local.we
  family                   = "${var.project}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "4096"                          # headroom for the report job's headless chromium PDF render; the --oom proof still OOM-kills (infinite alloc) at this higher ceiling
  execution_role_arn       = aws_iam_role.execution.arn      # reuse: ECR pull + awslogs
  task_role_arn            = aws_iam_role.worker_task[0].arn # SM + KMS for db.py creds
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([
    {
      name      = local.worker_cname
      image     = "${aws_ecr_repository.worker[0].repository_url}:${var.worker_image_tag}"
      essential = true
      environment = concat([
        { name = "AURORA_ENDPOINT", value = aws_rds_cluster.aurora.endpoint },
        { name = "AURORA_DATABASE", value = aws_rds_cluster.aurora.database_name },
        { name = "AURORA_USER", value = "awsops_worker" },
        { name = "AWS_REGION", value = var.region },
        # AI Diagnosis (Task 1b): the report worker uploads markdown here (handlers.py reads
        # ARTIFACT_BUCKET → RuntimeError if unset) and invokes a global.* Bedrock inference profile
        # from the home region so calls land in the ap-northeast-2 invocation log (awsops cost attribution).
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.diagnosis_artifacts[0].bucket },
        { name = "BEDROCK_REGION", value = var.region },
        # CIS compliance (`compliance` job): the Fargate worker reuses aws_security_group.service,
        # and steampipe.tf already allows that SG into the Steampipe FDW on :9193 — no SG change.
        # Powerpipe connects via POWERPIPE_DATABASE built from these (the worker reads the secret at
        # runtime via boto3 → task role, not execution role). Empty when steampipe disabled →
        # _compliance fails fast with a clear error.
        { name = "STEAMPIPE_HOST", value = "steampipe.${var.project}.internal" },
        { name = "STEAMPIPE_SECRET_ARN", value = try(aws_secretsmanager_secret.steampipe[0].arn, "") }
      ], local.ds_env_list, local.notify_worker_env_list, local.insight_env_list) # + gated datasource env; + AI_INSIGHTS_ENABLED/ONBOARD_EKS_CLUSTERS when ai_insights_enabled
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker_fargate[0].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])
}

############################################################
# Lambda functions
#   dispatcher: NO VPC (reaches SQS/SFN APIs directly); minimal role; ESM = kill-switch
#   worker/status/reaper: VPC (Aurora) + pg8000 layer + service SG (C8)
############################################################
resource "aws_lambda_function" "dispatcher" {
  count            = local.we
  function_name    = "${var.project}-dispatcher"
  role             = aws_iam_role.dispatcher[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "dispatcher.lambda_handler"
  filename         = data.archive_file.workers_src[0].output_path
  source_code_hash = data.archive_file.workers_src[0].output_base64sha256
  timeout          = 60
  memory_size      = 128
  environment {
    # concat/merge keeps this byte-identical when remediation_enabled=false (merge(base,{})==base →
    # no dispatcher revision). Enabling remediation adds the sibling SM ARN so the dispatcher can
    # route catalog-flagged jobs to the remediation SFN. Remediation REQUIRES workers_enabled=true
    # (this resource only exists when workers are on).
    variables = merge(
      { STATE_MACHINE_ARN = aws_sfn_state_machine.workers[0].arn },
      # ADR-040/041: the remediation SM is OR-gated (re_or_iw) so the Slack DATA-write path can dispatch
      # while remediation_enabled stays false. The dispatcher needs the SM ARN whenever EITHER plane is on.
      (var.remediation_enabled || var.integrations_write_enabled) ? { REMEDIATION_STATE_MACHINE_ARN = aws_sfn_state_machine.remediation[0].arn } : {},
      # ADR-032: enabling the incident lifecycle adds the sibling incident SM ARN so the dispatcher
      # can route incident_stage jobs to it (dispatcher.py reads INCIDENT_STATE_MACHINE_ARN; empty
      # → the incident branch is inert). merge(base,{}) == base when off → byte-identical dispatcher
      # (no revision). Incident lifecycle REQUIRES workers_enabled=true (this Lambda only exists then).
      var.incident_lifecycle_enabled ? { INCIDENT_STATE_MACHINE_ARN = aws_sfn_state_machine.incident[0].arn } : {},
    )
  }
  depends_on = [aws_cloudwatch_log_group.dispatcher]
}

resource "aws_lambda_function" "worker" {
  count            = local.we
  function_name    = "${var.project}-worker"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "worker_lambda.lambda_handler"
  filename         = data.archive_file.workers_src[0].output_path
  source_code_hash = data.archive_file.workers_src[0].output_base64sha256
  timeout          = 900
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = merge({
      AURORA_ENDPOINT   = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE   = aws_rds_cluster.aurora.database_name
      AURORA_USER       = "awsops_worker"
      # AI Diagnosis (Task 1b): report worker uploads here + invokes a global.* Bedrock profile from var.region.
      ARTIFACT_BUCKET = aws_s3_bucket.diagnosis_artifacts[0].bucket
      BEDROCK_REGION  = var.region
      # + gated DIAGNOSIS_SNS_TOPIC_ARN/APP_DOMAIN (notify) — empty map when diagnosis_notify_enabled=false → no env diff.
    }, local.notify_worker_env_map, local.ds_env_map, local.insight_env_map, local.gqg_env_map)
    # + gated datasource env; + AI_INSIGHTS_ENABLED/ONBOARD_EKS_CLUSTERS when ai_insights_enabled;
    # + GRAPH_QUERYGEN_ENABLED when graph_querygen_enabled
  }
  depends_on = [aws_cloudwatch_log_group.worker_fn, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

resource "aws_lambda_function" "status_updater" {
  count            = local.we
  function_name    = "${var.project}-status-updater"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "status_updater.lambda_handler"
  filename         = data.archive_file.workers_src[0].output_path
  source_code_hash = data.archive_file.workers_src[0].output_base64sha256
  timeout          = 60
  memory_size      = 128
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      AURORA_ENDPOINT   = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE   = aws_rds_cluster.aurora.database_name
      AURORA_USER       = "awsops_worker"
    }
  }
  depends_on = [aws_cloudwatch_log_group.status_updater, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

resource "aws_lambda_function" "reaper" {
  count            = local.we
  function_name    = "${var.project}-reaper"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "reaper.lambda_handler"
  filename         = data.archive_file.workers_src[0].output_path
  source_code_hash = data.archive_file.workers_src[0].output_base64sha256
  timeout          = 120
  memory_size      = 128
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      AURORA_ENDPOINT   = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE   = aws_rds_cluster.aurora.database_name
      AURORA_USER       = "awsops_worker"
      DISPATCH_ESM_UUID = aws_lambda_event_source_mapping.dispatcher[0].uuid
      QUEUED_STALE_MIN  = "30"
      # Must EXCEED the longest legit run (the Fargate SFN TimeoutSeconds = 3600s = 60min) so the
      # SFN/status_updater is always the authority on a timed-out job's terminal state; the reaper
      # then only catches truly-orphaned 'running' rows. Equal-to-60 races: a ~60min job could be
      # reaped to 'failed' and its later 'succeeded' silently dropped (terminal-immutable). (W6 review)
      RUNNING_STALE_MIN = "75"
    }
  }
  depends_on = [aws_cloudwatch_log_group.reaper, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

############################################################
# Step Functions state machine (Standard) — the worker orchestrator
############################################################
resource "aws_sfn_state_machine" "workers" {
  count    = local.we
  name     = "${var.project}-workers"
  role_arn = aws_iam_role.sfn[0].arn
  type     = "STANDARD"
  definition = templatefile("${local.workers_src}/sfn.asl.json", {
    worker_fn_arn = aws_lambda_function.worker[0].arn
    status_fn_arn = aws_lambda_function.status_updater[0].arn
    cluster_arn   = aws_ecs_cluster.main.arn
    # Reference the task def by FAMILY (revision-less) so runTask always uses the latest ACTIVE
    # revision. Pinning the full ARN (with revision) breaks runTask with "TaskDefinition is inactive"
    # whenever the task def is replaced (new revision + old deregistered) — e.g. a targeted apply that
    # bumps the task def without re-templating this SFN. IAM already allows .../awsops-v2-worker:*.
    task_def_arn   = aws_ecs_task_definition.worker[0].family
    subnets_json   = jsonencode(local.private_subnet_ids)
    sg_id          = aws_security_group.service.id
    container_name = local.worker_cname
  })
  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn[0].arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }
  depends_on = [aws_iam_role_policy.sfn]
}

############################################################
# SQS → dispatcher event-source mapping (the KILL-SWITCH) + reaper schedule
############################################################
resource "aws_lambda_event_source_mapping" "dispatcher" {
  count                   = local.we
  event_source_arn        = aws_sqs_queue.jobs[0].arn
  function_name           = aws_lambda_function.dispatcher[0].arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
  enabled                 = true # kill-switch INITIAL state: disable to pause all dispatch (jobs stay queued)
  # C11: the ESM must not start consuming before the dispatcher can read SQS + start SFN.
  depends_on = [aws_iam_role_policy.dispatcher]
  # The kill-switch is OPERATIONALLY toggled (aws lambda update-event-source-mapping --no-enabled).
  # Without this, any later `terraform apply` would silently re-enable dispatch and undo an
  # out-of-band pause. TF sets the initial enabled=true; operators own it thereafter. (W6 review)
  lifecycle {
    ignore_changes = [enabled]
  }
}

resource "aws_cloudwatch_event_rule" "reaper" {
  count               = local.we
  name                = "${var.project}-reaper"
  description         = "Periodic reconcile of stale worker_jobs (running->failed; queued->failed when dispatch enabled)"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "reaper" {
  count     = local.we
  rule      = aws_cloudwatch_event_rule.reaper[0].name
  target_id = "reaper"
  arn       = aws_lambda_function.reaper[0].arn
}

resource "aws_lambda_permission" "reaper_events" {
  count         = local.we
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.reaper[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reaper[0].arn
}

############################################################
# Web tier → SQS (the producer). Gated so the web task role is untouched when disabled.
# (JOBS_QUEUE_URL is injected into the web container env in workload.tf, also gated.)
############################################################
resource "aws_iam_role_policy" "web_sqs_send" {
  count = local.we
  name  = "${var.project}-web-jobs-send"
  role  = aws_iam_role.task.id # the web task role (workload.tf)
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = aws_sqs_queue.jobs[0].arn
    }]
  })
}

############################################################
# AI Diagnosis (Task 1b) — artifact bucket + worker read-only IAM + web GetObject.
# Gated on the SAME flag as the rest of the worker tier (var.workers_enabled → local.we):
# off → count=0 → No changes / $0. The `report` worker uploads its markdown to this bucket
# (handlers.py reads ARTIFACT_BUCKET; RuntimeError if unset) and the web BFF reads it back
# via s3:GetObject on diagnosis/* (web/app/api/diagnosis/[id]/route.ts).
############################################################
resource "aws_s3_bucket" "diagnosis_artifacts" {
  count         = local.we
  bucket        = "${var.project}-diagnosis-artifacts"
  force_destroy = true
}

# Block ALL public access (all four flags).
resource "aws_s3_bucket_public_access_block" "diagnosis_artifacts" {
  count                   = local.we
  bucket                  = aws_s3_bucket.diagnosis_artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE — AES256 (SSE-S3). No bucket CMK is conventional here; the Aurora CMK is Aurora-scoped.
resource "aws_s3_bucket_server_side_encryption_configuration" "diagnosis_artifacts" {
  count  = local.we
  bucket = aws_s3_bucket.diagnosis_artifacts[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Expire diagnosis/ reports after 90 days (markdown reports are ephemeral artifacts).
resource "aws_s3_bucket_lifecycle_configuration" "diagnosis_artifacts" {
  count  = local.we
  bucket = aws_s3_bucket.diagnosis_artifacts[0].id
  rule {
    id     = "expire-diagnosis-reports"
    status = "Enabled"
    filter {
      prefix = "diagnosis/"
    }
    expiration {
      days = 90
    }
  }
}

# Worker task role (Fargate worker + worker Lambda share this role for the diagnosis report job):
# EXACTLY the read-only data-source actions the report worker calls, plus s3:PutObject scoped to
# diagnosis/* on the artifact bucket. No wildcards on service actions; no mutating actions.
resource "aws_iam_role_policy" "worker_diagnosis" {
  count = local.we
  name  = "${var.project}-worker-diagnosis-read"
  role  = aws_iam_role.worker_task[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # report.py invokes a global.anthropic.* Sonnet/Opus inference profile from var.region
        # (BEDROCK_REGION=var.region). Scoped to the Claude FM + global cross-region inference profiles.
        Sid    = "BedrockInvokeReadOnly"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
          "arn:aws:bedrock:*:*:inference-profile/global.anthropic.*",
        ]
      },
      {
        # The diagnosis data sources (Cost Explorer, CloudWatch, X-Ray, Security Hub, CloudTrail) —
        # all read-only; each of these APIs requires Resource "*" (no resource-level scoping).
        Sid    = "DiagnosisDataSourcesReadOnly"
        Effect = "Allow"
        Action = [
          "ce:GetCostAndUsage",
          "ce:GetReservationCoverage",
          "ce:GetSavingsPlansCoverage",
          "cloudwatch:GetMetricData",
          "xray:GetServiceGraph",
          "securityhub:GetFindings",
          "cloudtrail:LookupEvents",
        ]
        Resource = "*"
      },
      {
        # Upload the markdown report — scoped to diagnosis/* on the artifact bucket only.
        Sid      = "PutDiagnosisArtifact"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.diagnosis_artifacts[0].arn}/diagnosis/*"
      }
    ]
  })
}

# The worker LAMBDA path runs as aws_iam_role.worker_lambda (not worker_task). The diagnosis report
# job can run on either compute path, so grant the same read-only diagnosis actions there too.
resource "aws_iam_role_policy" "worker_lambda_diagnosis" {
  count = local.we
  name  = "${var.project}-worker-lambda-diagnosis-read"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "BedrockInvokeReadOnly"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
          "arn:aws:bedrock:*:*:inference-profile/global.anthropic.*",
        ]
      },
      {
        Sid    = "DiagnosisDataSourcesReadOnly"
        Effect = "Allow"
        Action = [
          "ce:GetCostAndUsage",
          "ce:GetReservationCoverage",
          "ce:GetSavingsPlansCoverage",
          "cloudwatch:GetMetricData",
          "xray:GetServiceGraph",
          "securityhub:GetFindings",
          "cloudtrail:LookupEvents",
        ]
        Resource = "*"
      },
      {
        Sid      = "PutDiagnosisArtifact"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.diagnosis_artifacts[0].arn}/diagnosis/*"
      }
    ]
  })
}

# Datasource-diagnosis connector invoke (ADR-039/041 governed external egress) — GATED on
# datasource_diagnosis_enabled (default false → not created → $0). Scoped to the 5 named connector
# Lambda ARNs only (NO function:* wildcard). Granted to BOTH diagnosis compute roles (Fargate task +
# worker Lambda), matching the worker_diagnosis / worker_lambda_diagnosis split above. The matching
# DIAG_DATASOURCES_ENABLED env is set on the same gate, so IAM and activation move together.
resource "aws_iam_role_policy" "worker_task_datasource_invoke" {
  count = local.dsd
  name  = "${var.project}-worker-datasource-invoke"
  role  = aws_iam_role.worker_task[0].id
  # Fail LOUD (CLAUDE.md: no silent caps) if the flag is set but the connector Lambdas it grants
  # InvokeFunction on won't exist — agentcore_enabled + integrations_enabled create the
  # ${var.project}-agent-*-mcp functions. Without this the worker would silently degrade on AccessDenied.
  lifecycle {
    precondition {
      condition     = var.agentcore_enabled && var.integrations_enabled
      error_message = "datasource_diagnosis_enabled requires agentcore_enabled AND integrations_enabled (they create the ${var.project}-agent-*-mcp connector Lambdas this grants lambda:InvokeFunction on)."
    }
  }
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeDatasourceConnectors"
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = local.ds_connector_arns
    }]
  })
}

resource "aws_iam_role_policy" "worker_lambda_datasource_invoke" {
  count = local.dsd
  name  = "${var.project}-worker-lambda-datasource-invoke"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeDatasourceConnectors"
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = local.ds_connector_arns
    }]
  })
}

# graph_querygen's step (b) — best-effort, advisory-only AgentCore Code Interpreter sandbox check
# (graph_querygen.py:_code_interpreter_check). Reads the provisioned interpreter id from SSM, then
# starts/invokes/stops a session. No static ARN exists for the session actions (the interpreter id is
# a runtime value written by agentcore.mjs's provisioner, not a Terraform resource here) — Resource
# "*" on this narrow, session-scoped action set, consistent with the AgentCore execution role's own
# broader `bedrock-agentcore:*` grant elsewhere (ai.tf). Every failure mode in _code_interpreter_check
# already degrades to a safe skip (None), so an AccessDenied here just means step (b) never runs — it
# does not weaken (a)/(c), which are the checks that actually gate.
resource "aws_iam_role_policy" "worker_lambda_graph_querygen" {
  count = local.gqg
  name  = "${var.project}-worker-lambda-graph-querygen"
  role  = aws_iam_role.worker_lambda[0].id
  lifecycle {
    precondition {
      condition     = var.agentcore_enabled
      error_message = "graph_querygen_enabled requires agentcore_enabled (it provisions the Code Interpreter this best-effort check reads from SSM)."
    }
  }
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadInterpreterId"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/ops/${var.project}/agentcore/interpreter_id"
      },
      {
        Sid      = "CodeInterpreterSandboxCheck"
        Effect   = "Allow"
        Action = [
          "bedrock-agentcore:StartCodeInterpreterSession",
          "bedrock-agentcore:InvokeCodeInterpreter",
          "bedrock-agentcore:StopCodeInterpreterSession",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = var.region
          }
        }
      },
    ]
  })
}

# Web BFF task role: read the report back (s3:GetObject on diagnosis/* only). Gated on the worker
# flag so the web task role is UNTOUCHED when the worker tier is off.
resource "aws_iam_role_policy" "web_diagnosis_get" {
  count = local.we
  name  = "${var.project}-web-diagnosis-get"
  role  = aws_iam_role.task.id # the web task role (workload.tf)
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "${aws_s3_bucket.diagnosis_artifacts[0].arn}/diagnosis/*"
    }]
  })
}

############################################################
# Outputs (null when disabled — consumed by W8 make targets / W9 verification)
############################################################
output "jobs_queue_url" {
  value = one(aws_sqs_queue.jobs[*].url)
}
output "workers_state_machine_arn" {
  value = one(aws_sfn_state_machine.workers[*].arn)
}
output "dispatcher_esm_uuid" {
  value = one(aws_lambda_event_source_mapping.dispatcher[*].uuid)
}
output "worker_ecr_uri" {
  value = one(aws_ecr_repository.worker[*].repository_url)
}

############################################################
# ai-cost aggregator — awsops-only Bedrock cost (Logs Insights -> ai_usage_daily).
# Gated by var.ai_cost_tracking_enabled (local.act also requires workers_enabled, since it reuses
# the worker IAM role + pg8000 layer + VPC). Default off -> count 0 -> $0, no behavior change.
############################################################
resource "aws_cloudwatch_log_group" "ai_cost_aggregator" {
  count             = local.act
  name              = "/aws/lambda/${var.project}-ai-cost-aggregator"
  retention_in_days = 14
}

# Read-only Bedrock invocation-log access for the (shared) worker role, added only when tracking is on.
resource "aws_iam_role_policy" "ai_cost_logs_read" {
  count = local.act
  name  = "ai-cost-bedrock-logs-read"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StartBedrockInsightsQuery"
        Effect   = "Allow"
        Action   = ["logs:StartQuery"]
        Resource = "arn:aws:logs:${var.region}:${local.acct}:log-group:/aws/bedrock/invocation-logs:*"
      },
      {
        # GetQueryResults / StopQuery do not support resource-level scoping.
        Sid      = "ReadBedrockInsightsResults"
        Effect   = "Allow"
        Action   = ["logs:GetQueryResults", "logs:StopQuery"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_lambda_function" "ai_cost_aggregator" {
  count            = local.act
  function_name    = "${var.project}-ai-cost-aggregator"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "ai_cost_aggregator.lambda_handler"
  filename         = data.archive_file.workers_src[0].output_path
  source_code_hash = data.archive_file.workers_src[0].output_base64sha256
  timeout          = 120
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      AURORA_ENDPOINT       = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE       = aws_rds_cluster.aurora.database_name
      AURORA_USER           = "awsops_worker"
      BEDROCK_LOG_GROUP     = "/aws/bedrock/invocation-logs"
      AWSOPS_IDENTITY_MATCH = "awsops-v2"
      LOOKBACK_DAYS         = "3"
    }
  }
  depends_on = [aws_cloudwatch_log_group.ai_cost_aggregator, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

resource "aws_cloudwatch_event_rule" "ai_cost_aggregator" {
  count               = local.act
  name                = "${var.project}-ai-cost-aggregator"
  description         = "Aggregate awsops-only Bedrock token usage from invocation logs into ai_usage_daily"
  schedule_expression = "rate(6 hours)"
}

resource "aws_cloudwatch_event_target" "ai_cost_aggregator" {
  count     = local.act
  rule      = aws_cloudwatch_event_rule.ai_cost_aggregator[0].name
  target_id = "ai-cost-aggregator"
  arn       = aws_lambda_function.ai_cost_aggregator[0].arn
}

resource "aws_lambda_permission" "ai_cost_aggregator_events" {
  count         = local.act
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ai_cost_aggregator[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ai_cost_aggregator[0].arn
}

############################################################
# Scheduled auto-diagnosis dispatcher (v1 report-scheduler parity).
# Hourly EventBridge -> Lambda that scans report_schedules for due rows and enqueues a `report` job each
# (the diagnosis is read-only). Reuses the shared worker role + pg8000 layer + VPC (Aurora reachability);
# adds ONLY sqs:SendMessage to the jobs queue. All count-gated on local.sched (workers_enabled &&
# diagnosis_schedule_enabled). Default off -> 0 resources, $0, no scheduled runs.
############################################################
resource "aws_cloudwatch_log_group" "schedule_dispatcher" {
  count             = local.sched
  name              = "/aws/lambda/${var.project}-schedule-dispatcher"
  retention_in_days = 14
}

# Dedicated code bundle (db.py + schedule_dispatcher.py) so enabling this does NOT change the shared
# workers_src archive hash → existing worker Lambdas stay byte-identical (strict no-op when off).
data "archive_file" "schedule_dispatcher_src" {
  count       = local.sched
  type        = "zip"
  output_path = "${path.module}/.build/schedule_dispatcher.zip"
  source {
    content  = file("${local.workers_src}/db.py")
    filename = "db.py"
  }
  source {
    content  = file("${local.workers_src}/schedule_dispatcher.py")
    filename = "schedule_dispatcher.py"
  }
}

# The dispatcher enqueues jobs (db.insert_job + SQS) — grant the shared worker role SendMessage, only when on.
resource "aws_iam_role_policy" "schedule_dispatcher_sqs" {
  count = local.sched
  name  = "schedule-dispatcher-enqueue"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "EnqueueDiagnosisJob"
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = aws_sqs_queue.jobs[0].arn
    }]
  })
}

resource "aws_lambda_function" "schedule_dispatcher" {
  count            = local.sched
  function_name    = "${var.project}-schedule-dispatcher"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "schedule_dispatcher.lambda_handler"
  filename         = data.archive_file.schedule_dispatcher_src[0].output_path
  source_code_hash = data.archive_file.schedule_dispatcher_src[0].output_base64sha256
  timeout          = 120
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      AURORA_ENDPOINT   = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE   = aws_rds_cluster.aurora.database_name
      AURORA_USER       = "awsops_worker"
      AWS_ACCOUNT_ID    = local.acct
      JOBS_QUEUE_URL    = aws_sqs_queue.jobs[0].url
    }
  }
  depends_on = [aws_cloudwatch_log_group.schedule_dispatcher, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

resource "aws_cloudwatch_event_rule" "schedule_dispatcher" {
  count               = local.sched
  name                = "${var.project}-schedule-dispatcher"
  description         = "Scan report_schedules for due rows and enqueue AI-diagnosis report jobs"
  schedule_expression = "rate(1 hour)"
}

resource "aws_cloudwatch_event_target" "schedule_dispatcher" {
  count     = local.sched
  rule      = aws_cloudwatch_event_rule.schedule_dispatcher[0].name
  target_id = "schedule-dispatcher"
  arn       = aws_lambda_function.schedule_dispatcher[0].arn
}

resource "aws_lambda_permission" "schedule_dispatcher_events" {
  count         = local.sched
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.schedule_dispatcher[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule_dispatcher[0].arn
}

############################################################
# datasource_index dispatcher — daily EventBridge -> Lambda that enqueues a `datasource_index` job per
# enabled Prometheus/Mimir instance (rebuilds pre-built diagnostic signals on schema change). Reuses the
# shared worker role + pg8000 layer + VPC; adds ONLY sqs:SendMessage. Gated on local.dsd (workers_enabled
# && datasource_diagnosis_enabled) — same gate as the diagnosis egress. Default off -> 0 resources, $0.
############################################################
resource "aws_cloudwatch_log_group" "dsindex_dispatcher" {
  count             = local.dsd
  name              = "/aws/lambda/${var.project}-datasource-index-dispatcher"
  retention_in_days = 14
}

data "archive_file" "dsindex_dispatcher_src" {
  count       = local.dsd
  type        = "zip"
  output_path = "${path.module}/.build/dsindex_dispatcher.zip"
  source {
    content  = file("${local.workers_src}/db.py")
    filename = "db.py"
  }
  source {
    content  = file("${local.workers_src}/datasource_index_dispatcher.py")
    filename = "datasource_index_dispatcher.py"
  }
}

resource "aws_iam_role_policy" "dsindex_dispatcher_sqs" {
  count = local.dsd
  name  = "dsindex-dispatcher-enqueue"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "EnqueueDatasourceIndexJob"
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = aws_sqs_queue.jobs[0].arn
    }]
  })
}

resource "aws_lambda_function" "dsindex_dispatcher" {
  count            = local.dsd
  function_name    = "${var.project}-datasource-index-dispatcher"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "datasource_index_dispatcher.lambda_handler"
  filename         = data.archive_file.dsindex_dispatcher_src[0].output_path
  source_code_hash = data.archive_file.dsindex_dispatcher_src[0].output_base64sha256
  timeout          = 120
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      AURORA_ENDPOINT   = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE   = aws_rds_cluster.aurora.database_name
      AURORA_USER       = "awsops_worker"
      AWS_ACCOUNT_ID    = local.acct
      JOBS_QUEUE_URL    = aws_sqs_queue.jobs[0].url
    }
  }
  depends_on = [aws_cloudwatch_log_group.dsindex_dispatcher, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

resource "aws_cloudwatch_event_rule" "dsindex_dispatcher" {
  count               = local.dsd
  name                = "${var.project}-datasource-index-dispatcher"
  description         = "Daily: enqueue a datasource_index job per enabled datasource instance (all 5 kinds)"
  schedule_expression = "rate(24 hours)"
}

resource "aws_cloudwatch_event_target" "dsindex_dispatcher" {
  count     = local.dsd
  rule      = aws_cloudwatch_event_rule.dsindex_dispatcher[0].name
  target_id = "datasource-index-dispatcher"
  arn       = aws_lambda_function.dsindex_dispatcher[0].arn
}

resource "aws_lambda_permission" "dsindex_dispatcher_events" {
  count         = local.dsd
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dsindex_dispatcher[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.dsindex_dispatcher[0].arn
}

############################################################
# AI Insights — read-only IAM (CloudWatch/Cost/EKS describe + SendMessage) + daily insight_dispatcher.
# All count-gated on local.aii (workers_enabled && ai_insights_enabled). Default off → 0 resources, $0.
# The `insight` job runs on the shared worker Lambda (REGISTRY); the dispatcher only enqueues it.
############################################################
resource "aws_iam_role_policy" "insight_reads" {
  count = local.aii
  name  = "ai-insights-reads"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InsightReadOnly"
        Effect   = "Allow"
        Action   = ["cloudwatch:DescribeAlarms", "ce:GetCostAndUsage", "eks:DescribeCluster"]
        Resource = "*" # these read-only describe/get APIs do not support resource-level scoping
      },
      {
        Sid      = "InsightEnqueue"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.jobs[0].arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "insight_dispatcher" {
  count             = local.aii
  name              = "/aws/lambda/${var.project}-insight-dispatcher"
  retention_in_days = 14
}

data "archive_file" "insight_dispatcher_src" {
  count       = local.aii
  type        = "zip"
  output_path = "${path.module}/.build/insight_dispatcher.zip"
  source {
    content  = file("${local.workers_src}/db.py")
    filename = "db.py"
  }
  source {
    content  = file("${local.workers_src}/insight_dispatcher.py")
    filename = "insight_dispatcher.py"
  }
}

resource "aws_lambda_function" "insight_dispatcher" {
  count            = local.aii
  function_name    = "${var.project}-insight-dispatcher"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "insight_dispatcher.lambda_handler"
  filename         = data.archive_file.insight_dispatcher_src[0].output_path
  source_code_hash = data.archive_file.insight_dispatcher_src[0].output_base64sha256
  timeout          = 60
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      AURORA_ENDPOINT   = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE   = aws_rds_cluster.aurora.database_name
      AURORA_USER       = "awsops_worker"
      JOBS_QUEUE_URL    = aws_sqs_queue.jobs[0].url
    }
  }
  depends_on = [aws_cloudwatch_log_group.insight_dispatcher, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

resource "aws_cloudwatch_event_rule" "insight_dispatcher" {
  count               = local.aii
  name                = "${var.project}-insight-dispatcher"
  description         = "Every 6 hours: enqueue an AI Insights generation job"
  schedule_expression = "rate(6 hours)"
}

resource "aws_cloudwatch_event_target" "insight_dispatcher" {
  count     = local.aii
  rule      = aws_cloudwatch_event_rule.insight_dispatcher[0].name
  target_id = "insight-dispatcher"
  arn       = aws_lambda_function.insight_dispatcher[0].arn
}

resource "aws_lambda_permission" "insight_dispatcher_events" {
  count         = local.aii
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.insight_dispatcher[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.insight_dispatcher[0].arn
}
