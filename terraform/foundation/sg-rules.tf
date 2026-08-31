# SG Rules & Usage — daily Athena flow-log evidence pipeline (ADR-019 / design spec
# docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md).
#
# EVERY resource here is gated on local.sgr (var.workers_enabled AND var.sg_rule_activity_enabled)
# → default false/false = 0 resources, $0. Reuses the worker tier's shared role/pg8000 layer/VPC/
# jobs queue the same way schedule_dispatcher / dsindex_dispatcher / insight_dispatcher do
# (workers.tf), so this feature REQUIRES workers_enabled=true (enforced by the variable's own
# gate composition, no separate validation block needed — local.sgr is simply 0 when either is off).
#
# Two-role IAM split (ADR-019 §4 / spec's "IAM and multi-account behavior" — do not conflate):
#   Role A (rule inventory / ENI describe) = the EXISTING, reused AWSopsReadOnlyRole — the SAME
#     trust boundary the web task role / Steampipe task role / agent Lambda already assume
#     (workload.tf's task_assume_readonly, steampipe.tf, ai.tf). worker_task gets ONLY
#     sts:AssumeRole scoped to that role NAME (target accounts are dynamic) — no new permissions on
#     AWSopsReadOnlyRole itself, which stays a read-only-only role.
#   Role B (Athena StartQueryExecution/GetQueryExecution/StopQueryExecution + the workgroup's own
#     result-prefix S3 write) = the ISOLATED, target-account AWSopsSgRuleAthenaRole. The ONLY
#     principal in this Terraform root allowed to `sts:AssumeRole` on it is the broker Lambda's OWN,
#     dedicated role (aws_iam_role.sg_rule_athena_broker) — worker_task and the web task role NEVER
#     get that AssumeRole grant. They only get lambda:InvokeFunction on the broker function itself,
#     which does not confer AssumeRole and is safe to hand to multiple callers (sg_rule_scan.py on
#     the Fargate worker, and web/lib/sg-rules.ts's validateFlowSourceViaBroker on the web BFF).
#
# AWSopsSgRuleAthenaRole itself is NOT a resource in this root — like AWSopsReadOnlyRole, it lives in
# each onboarded TARGET account (out-of-band onboarding, mirroring the existing read-only role
# convention), scoped to exactly the workgroup(s)/result-prefix configured for that source, with an
# ExternalId condition + explicit principal-ARN restriction to this broker role in its trust policy
# (spec's "Trust policy" subsection). Resource references below therefore use the role NAME wildcard
# (arn:aws:iam::*:role/AWSopsSgRuleAthenaRole), matching the existing AWSopsReadOnlyRole pattern.

locals {
  sgr          = var.workers_enabled && var.sg_rule_activity_enabled ? 1 : 0
  sgr_role_arn = "arn:aws:iam::*:role/AWSopsSgRuleAthenaRole"
  # Appended into the worker Fargate task's container environment (workers.tf) and the web task's
  # environment (workload.tf) — empty when the gate is off, so concat(base, []) == base (byte-
  # identical task defs, no redeploy) exactly like every other optional-env local in this repo.
  sgr_env_list = local.sgr == 1 ? [
    { name = "AWS_ACCOUNT_ID", value = local.acct },
    { name = "SG_RULE_ATHENA_BROKER_ARN", value = one(aws_lambda_function.sg_rule_athena_broker[*].arn) },
  ] : []
  sgr_env_map = local.sgr == 1 ? {
    AWS_ACCOUNT_ID            = local.acct
    SG_RULE_ATHENA_BROKER_ARN = one(aws_lambda_function.sg_rule_athena_broker[*].arn)
  } : {}
}

############################################################
# Role B isolation — the Athena/Glue broker Lambda's OWN, dedicated role. This is the ONLY
# principal anywhere in this repo permitted to assume AWSopsSgRuleAthenaRole (spec: "cannot reuse
# the shared Fargate worker task role as-is" — granting that AssumeRole to worker_task would expose
# every other job type this worker fleet runs to Athena/S3 access it has no business needing).
############################################################
resource "aws_iam_role" "sg_rule_athena_broker" {
  count              = local.sgr
  name               = "${var.project}-sg-rule-athena-broker"
  assume_role_policy = data.aws_iam_policy_document.worker_lambda_assume.json # lambda.amazonaws.com (workers.tf)
}

# L3 finding #6 (round 2 broker redesign): the broker now resolves a source's config from Aurora
# ITSELF (never trusts a caller-supplied account_id/region/workgroup/database/query again) — it
# therefore needs the same VPC-attached, rds-db-IAM-auth connectivity every other worker-tier
# Lambda has (db.py/sg_rule_dispatcher.py's pattern), which it deliberately did NOT need under the
# old caller-controlled-SQL design.
resource "aws_iam_role_policy_attachment" "sg_rule_athena_broker_vpc" {
  count      = local.sgr
  role       = aws_iam_role.sg_rule_athena_broker[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "sg_rule_athena_broker" {
  count = local.sgr
  name  = "${var.project}-sg-rule-athena-broker"
  role  = aws_iam_role.sg_rule_athena_broker[0].id
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
        # Role B — scoped to the role NAME only (target accounts are dynamic, same convention as
        # AWSopsReadOnlyRole elsewhere in this repo). ExternalId + principal restriction live in the
        # TARGET account's trust policy (out-of-band onboarding), not here.
        Sid      = "AssumeSgRuleAthenaRole"
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = local.sgr_role_arn
      },
      {
        # Read-only Aurora access to resolve a source's own config by `flow_source_id` — the SAME
        # rds-db IAM-auth pattern as db.py/sg_rule_dispatcher.py, least-privilege `awsops_worker`
        # role, never the master secret.
        Sid      = "AuroraIamAuth"
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = "arn:aws:rds-db:${var.region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_rds_cluster.aurora.cluster_resource_id}/awsops_worker"
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "sg_rule_athena_broker" {
  count             = local.sgr
  name              = "/aws/lambda/${var.project}-sg-rule-athena-broker"
  retention_in_days = 30
}

# Code bundle now also includes db.py (Aurora IAM-auth connect helper) + sg_rule_matching.py (the
# pure day-SELECT builder this module imports to build SQL server-side from resolved config) — a
# separate zip from the shared workers_src archive still keeps this Lambda's own hash stable across
# unrelated worker-tier changes.
data "archive_file" "sg_rule_athena_broker_src" {
  count       = local.sgr
  type        = "zip"
  output_path = "${path.module}/.build/sg_rule_athena_broker.zip"
  source {
    content  = file("${local.workers_src}/sg_rule_athena_broker.py")
    filename = "sg_rule_athena_broker.py"
  }
  source {
    content  = file("${local.workers_src}/sg_rule_matching.py")
    filename = "sg_rule_matching.py"
  }
  source {
    content  = file("${local.workers_src}/db.py")
    filename = "db.py"
  }
}

resource "aws_lambda_function" "sg_rule_athena_broker" {
  count            = local.sgr
  function_name    = "${var.project}-sg-rule-athena-broker"
  role             = aws_iam_role.sg_rule_athena_broker[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "sg_rule_athena_broker.lambda_handler"
  filename         = data.archive_file.sg_rule_athena_broker_src[0].output_path
  source_code_hash = data.archive_file.sg_rule_athena_broker_src[0].output_base64sha256
  timeout          = 150 # > _MAX_POLL_S default (120s) + assume-role/API round-trip margin
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      SG_RULE_ATHENA_POLL_TIMEOUT_S = "120"
      AURORA_ENDPOINT               = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE               = aws_rds_cluster.aurora.database_name
      AURORA_USER                   = "awsops_worker"
    }
  }
  depends_on = [aws_cloudwatch_log_group.sg_rule_athena_broker, aws_iam_role_policy_attachment.sg_rule_athena_broker_vpc]
}

############################################################
# Worker Fargate task role (worker_task, workers.tf) — Role A assume grant + direct EC2 describe
# (for the host-account case, where sg_rule_scan.py's _assumed_session skips AssumeRole entirely and
# uses the task's own credentials) + lambda:InvokeFunction on the broker (Role B stays isolated —
# this is invoke-only, never AssumeRole).
############################################################
resource "aws_iam_role_policy" "worker_task_sg_rule_readonly_assume" {
  count = local.sgr
  name  = "${var.project}-worker-task-sg-rule-readonly-assume"
  role  = aws_iam_role.worker_task[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Role A — the same reused AWSopsReadOnlyRole grant workload.tf's task_assume_readonly gives
        # the web task role. Read-only assume; grants nothing beyond that role's own permissions.
        Sid      = "AssumeReadOnlyForSgRuleScan"
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = "arn:aws:iam::*:role/AWSopsReadOnlyRole"
      },
      {
        # Host-account case (account_id == HOST_ACCOUNT_ID): sg_rule_scan.py uses the task's own
        # session directly instead of assuming AWSopsReadOnlyRole. Read-only describe only.
        Sid      = "DescribeSgRulesAndEniHostAccount"
        Effect   = "Allow"
        Action   = ["ec2:DescribeSecurityGroupRules", "ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },
      {
        # Invoke-only — does NOT confer AssumeRole on AWSopsSgRuleAthenaRole. Only the broker's own
        # role (above) may assume that role; this grant just lets the worker call the broker.
        Sid      = "InvokeSgRuleAthenaBroker"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.sg_rule_athena_broker[0].arn
      }
    ]
  })
}

# Web BFF task role (aws_iam_role.task, workload.tf) — invoke-only on the broker, for the admin
# source-validation path (web/lib/sg-rules.ts's validateFlowSourceViaBroker, called from
# PUT /api/sg/flow-sources). Same isolation guarantee: invoke, never AssumeRole.
resource "aws_iam_role_policy" "web_sg_rule_broker_invoke" {
  count = local.sgr
  name  = "${var.project}-web-sg-rule-broker-invoke"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeSgRuleAthenaBroker"
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.sg_rule_athena_broker[0].arn
    }]
  })
}

############################################################
# Daily dispatcher (EventBridge -> Lambda): one `sg_rule_scan` job per enabled sg_flow_sources row
# (sg_rule_dispatcher.py). Reuses the shared worker_lambda role + pg8000 layer + VPC (Aurora read of
# sg_flow_sources) + adds ONLY sqs:SendMessage to the jobs queue — same pattern as
# schedule_dispatcher/dsindex_dispatcher/insight_dispatcher in workers.tf.
############################################################
resource "aws_cloudwatch_log_group" "sg_rule_dispatcher" {
  count             = local.sgr
  name              = "/aws/lambda/${var.project}-sg-rule-dispatcher"
  retention_in_days = 14
}

data "archive_file" "sg_rule_dispatcher_src" {
  count       = local.sgr
  type        = "zip"
  output_path = "${path.module}/.build/sg_rule_dispatcher.zip"
  source {
    content  = file("${local.workers_src}/db.py")
    filename = "db.py"
  }
  source {
    content  = file("${local.workers_src}/sg_rule_dispatcher.py")
    filename = "sg_rule_dispatcher.py"
  }
}

resource "aws_iam_role_policy" "sg_rule_dispatcher_sqs" {
  count = local.sgr
  name  = "sg-rule-dispatcher-enqueue"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "EnqueueSgRuleScanJob"
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = aws_sqs_queue.jobs[0].arn
    }]
  })
}

resource "aws_lambda_function" "sg_rule_dispatcher" {
  count            = local.sgr
  function_name    = "${var.project}-sg-rule-dispatcher"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "sg_rule_dispatcher.lambda_handler"
  filename         = data.archive_file.sg_rule_dispatcher_src[0].output_path
  source_code_hash = data.archive_file.sg_rule_dispatcher_src[0].output_base64sha256
  timeout          = 60
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      AURORA_ENDPOINT = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE = aws_rds_cluster.aurora.database_name
      AURORA_USER     = "awsops_worker"
      AWS_ACCOUNT_ID  = local.acct
      JOBS_QUEUE_URL  = aws_sqs_queue.jobs[0].url
    }
  }
  depends_on = [aws_cloudwatch_log_group.sg_rule_dispatcher, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

resource "aws_cloudwatch_event_rule" "sg_rule_dispatcher" {
  count               = local.sgr
  name                = "${var.project}-sg-rule-dispatcher"
  description         = "Daily: enqueue one sg_rule_scan job per enabled sg_flow_sources row (ADR-019)"
  schedule_expression = "rate(24 hours)"
}

resource "aws_cloudwatch_event_target" "sg_rule_dispatcher" {
  count     = local.sgr
  rule      = aws_cloudwatch_event_rule.sg_rule_dispatcher[0].name
  target_id = "sg-rule-dispatcher"
  arn       = aws_lambda_function.sg_rule_dispatcher[0].arn
}

resource "aws_lambda_permission" "sg_rule_dispatcher_events" {
  count         = local.sgr
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sg_rule_dispatcher[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sg_rule_dispatcher[0].arn
}

############################################################
# Outputs (null when disabled).
############################################################
output "sg_rule_athena_broker_arn" {
  value = one(aws_lambda_function.sg_rule_athena_broker[*].arn)
}
output "sg_rule_dispatcher_arn" {
  value = one(aws_lambda_function.sg_rule_dispatcher[*].arn)
}
