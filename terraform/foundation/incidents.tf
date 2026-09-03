# terraform/foundation/incidents.tf
# AWSops v2 ADR-032 — autonomous incident LIFECYCLE substrate.
# EVERY resource here is gated by var.incident_lifecycle_enabled (default false → count=0 → ZERO
# AWS resources, ZERO cost, ZERO autonomous trigger). The always-present incident_* domain tables
# (migration v5) are harmless when off — empty and inert. This EXTENDS the P2 backbone (workers.tf):
# it REUSES the SQS jobs queue, the dispatcher, the reaper, the reused P2 status_updater (the
# failure path's job terminalizer), the pg8000 Lambda layer, and the shared service SG. It adds ONE
# sibling Step Functions machine (incident), the seven incident stage Lambdas, a per-stage timeout
# watchdog (rate-1m EventBridge), and the five configurable storm-cap / window SSM params.
#
# REQUIRES workers_enabled=true: the pg8000 layer (aws_lambda_layer_version.pg8000[0]) and the
# service SG (aws_security_group.service) are provisioned only when workers are on — exactly as
# remediation.tf documents. variables.tf states the same precondition.
#
# SAFETY (autonomous lifecycle shipped OFF): the Lead DELEGATES ONLY; the Sub-agents are
# recommendation-only; NO Lambda or SM state here performs an AWS mutation / runTask / remediation
# call. The incident SM role carries lambda:InvokeFunction on the incident Lambdas (+ the reused
# status_updater) ONLY — NO ecs:*, NO states:StartExecution (the dispatcher starts the SM), NO
# mutating actions. The incident-Lambda role is least-privilege: Aurora secret + KMS + AgentCore
# InvokeAgentRuntime + ssm:GetParameter on the incident/agentcore params + logs + VPC ENI ONLY.
# Design refs: ADR-032 (Addenda #4 configurable windows, #5 least-priv, #6 isolation, #7 storm caps).

locals {
  il             = var.incident_lifecycle_enabled ? 1 : 0
  rwb            = var.rca_writeback_enabled ? 1 : 0 # ADR-034 write-back gate (see writeback.tf)
  inc_src        = "${path.module}/../../scripts/v2/incident"
  workers_src_il = "${path.module}/../../scripts/v2/workers"     # reuse db.py + status_updater ARN
  rem_src_il     = "${path.module}/../../scripts/v2/remediation" # ADR-034: writeback.py imports remediation_executor (+ action_catalog) — the 029/036 single-write surface
  inc_acct       = data.aws_caller_identity.current.account_id
  # The AgentCore runtime ARN SSM param — created by ai.tf when agentcore_enabled, written by
  # provision.py after apply. Referenced by NAME (string), NOT the gated resource, so the incident
  # slice is independent of agentcore_enabled. agent_bridge.py reads it at runtime (TTL-cached).
  inc_runtime_arn_param = "/ops/${var.project}/agentcore/runtime_arn"
}

############################################################
# Step 1: Configurable storm-cap / window SSM params (Addendum #4/#7 — NOT hardcoded).
#   ignore_changes on value (operator-tunable; the Lambdas read the live value with safe fallbacks).
#   Suffixes match scripts/v2/incident/lifecycle.py _CAP_PARAMS and web/lib/incident.ts byte-for-byte.
############################################################
resource "aws_ssm_parameter" "incident_correlation_window" {
  count       = local.il
  name        = "/ops/${var.project}/incident/correlation-window-minutes"
  description = "ADR-032 #4: dedup look-back window (minutes). Operator-tunable; ignore drift."
  type        = "String"
  value       = "20"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "incident_stage_timeout" {
  count       = local.il
  name        = "/ops/${var.project}/incident/stage-timeout-seconds"
  description = "ADR-032 #4: per-stage watchdog timeout (seconds). Snapshotted onto each incident_stages row. Operator-tunable; ignore drift."
  type        = "String"
  value       = "600"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "incident_max_concurrent" {
  count       = local.il
  name        = "/ops/${var.project}/incident/max-concurrent-investigations"
  description = "ADR-032 #7 storm cap: max concurrent in-flight investigations. Operator-tunable; ignore drift."
  type        = "String"
  value       = "5"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "incident_fanout_max" {
  count       = local.il
  name        = "/ops/${var.project}/incident/subagent-fanout-max"
  description = "ADR-032 #7 storm cap: max Sub-agent fan-out per incident (the SM Map MaxConcurrency). Operator-tunable; ignore drift."
  type        = "String"
  value       = "4"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "incident_min_severity" {
  count       = local.il
  name        = "/ops/${var.project}/incident/min-severity"
  description = "ADR-032 #7 severity gate: drop alerts below this severity before any write (info|warning|critical). Operator-tunable; ignore drift."
  type        = "String"
  value       = "warning"
  lifecycle { ignore_changes = [value] }
}

############################################################
# Step 2: Lambda packaging (one zip: shared workers/db.py + all incident/*.py) + the two IAM roles.
############################################################
data "archive_file" "incident_src" {
  count       = local.il
  type        = "zip"
  output_path = "${path.module}/.build/incident_src.zip"
  source {
    content  = file("${local.workers_src_il}/db.py") # shared Aurora pg8000 connector
    filename = "db.py"
  }
  source {
    content  = file("${local.inc_src}/correlation.py")
    filename = "correlation.py"
  }
  source {
    content  = file("${local.inc_src}/lifecycle.py")
    filename = "lifecycle.py"
  }
  source {
    content  = file("${local.inc_src}/agent_bridge.py")
    filename = "agent_bridge.py"
  }
  source {
    content  = file("${local.inc_src}/triage.py")
    filename = "triage.py"
  }
  source {
    content  = file("${local.inc_src}/lead.py")
    filename = "lead.py"
  }
  source {
    content  = file("${local.inc_src}/subagent.py")
    filename = "subagent.py"
  }
  source {
    content  = file("${local.inc_src}/rootcause.py")
    filename = "rootcause.py"
  }
  source {
    content  = file("${local.inc_src}/mitigation_plan.py")
    filename = "mitigation_plan.py"
  }
  source {
    content  = file("${local.inc_src}/prevention.py")
    filename = "prevention.py"
  }
  source {
    content  = file("${local.inc_src}/incident_stage_failed.py")
    filename = "incident_stage_failed.py"
  }
  source {
    content  = file("${local.inc_src}/incident_watchdog.py")
    filename = "incident_watchdog.py"
  }
  # ADR-034 write-back stage sources — added ONLY when rca_writeback_enabled, so the ADR-032 GREEN
  # archive (lifecycle on, write-back off) stays byte-identical and the incident Lambdas are not
  # forced to re-package. writeback.py imports writeback_render + slack_thread (incident slice) and
  # remediation_executor + action_catalog (the 029/036 single-write surface) — db.py is already above.
  dynamic "source" {
    for_each = local.rwb == 1 ? [1] : []
    content {
      content  = file("${local.inc_src}/writeback.py")
      filename = "writeback.py"
    }
  }
  dynamic "source" {
    for_each = local.rwb == 1 ? [1] : []
    content {
      content  = file("${local.inc_src}/writeback_render.py")
      filename = "writeback_render.py"
    }
  }
  dynamic "source" {
    for_each = local.rwb == 1 ? [1] : []
    content {
      content  = file("${local.inc_src}/slack_thread.py")
      filename = "slack_thread.py"
    }
  }
  dynamic "source" {
    for_each = local.rwb == 1 ? [1] : []
    content {
      content  = file("${local.rem_src_il}/remediation_executor.py")
      filename = "remediation_executor.py"
    }
  }
  dynamic "source" {
    for_each = local.rwb == 1 ? [1] : []
    content {
      content  = file("${local.rem_src_il}/action_catalog.py")
      filename = "action_catalog.py"
    }
  }
}

# ---- incident-Lambda role: VPC ENI + Aurora secret + KMS + AgentCore invoke + scoped SSM reads ----
# Least-privilege (Addendum #5): NO ecs:*, NO mutating actions, NO states:StartExecution. The
# dispatcher starts the SM; the SM invokes these Lambdas.
resource "aws_iam_role" "incident_lambda" {
  count              = local.il
  name               = "${var.project}-incident-lambda"
  assume_role_policy = data.aws_iam_policy_document.worker_lambda_assume.json # reuse (workers.tf)
}

resource "aws_iam_role_policy_attachment" "incident_lambda_vpc" {
  count      = local.il
  role       = aws_iam_role.incident_lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "incident_lambda" {
  count = local.il
  name  = "${var.project}-incident-lambda"
  role  = aws_iam_role.incident_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.inc_acct}:*"
      },
      {
        # RDS IAM database auth: db.py generates a short-lived signed token (rds-db:connect) per
        # connect() to authenticate as the dedicated least-privilege `awsops_worker` Postgres role
        # (see the awsops_worker_role migration) instead of the Aurora master secret. Mirrors
        # workers.tf's worker_lambda AuroraIamAuth statement.
        Sid      = "AuroraIamAuth"
        Effect   = "Allow"
        Action   = ["rds-db:connect"]
        Resource = "arn:aws:rds-db:${var.region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_rds_cluster.aurora.cluster_resource_id}/awsops_worker"
      },
      {
        # AgentCore Runtime invoke for the read-only Sub-agent consults (agent_bridge.py). Scoped to
        # the provisioner's fixed runtime name (local.agent_runtime_name) + its control-plane-
        # generated suffix, written to SSM by provision.py post-apply. NOT var.project — that yields
        # a non-matching ARN (hyphens + wrong prefix). Read-only consult only.
        Sid      = "InvokeAgentRuntime"
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:InvokeAgentRuntime"]
        Resource = "arn:aws:bedrock-agentcore:${var.region}:${local.inc_acct}:runtime/${local.agent_runtime_name}-*"
      },
      {
        # The Lambdas derive SSM paths from PROJECT (/ops/<project>/incident/*) and read the
        # AgentCore runtime-ARN param. Scoped to exactly those parameter ARNs.
        Sid    = "ReadIncidentAndRuntimeParams"
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          aws_ssm_parameter.incident_correlation_window[0].arn,
          aws_ssm_parameter.incident_stage_timeout[0].arn,
          aws_ssm_parameter.incident_max_concurrent[0].arn,
          aws_ssm_parameter.incident_fanout_max[0].arn,
          aws_ssm_parameter.incident_min_severity[0].arn,
          # prevention_loop live-reads its window/threshold each run (PR #36 review: the
          # env-baked copies went stale until the next apply, defeating ignore_changes tunability).
          aws_ssm_parameter.incident_prevention_window_days[0].arn,
          aws_ssm_parameter.incident_prevention_threshold[0].arn,
          "arn:aws:ssm:${var.region}:${local.inc_acct}:parameter${local.inc_runtime_arn_param}",
        ]
      }
    ]
  })
}

# ---- ADR-034 write-back add-on policy (SEPARATE resource, count=local.rwb) ----
# Kept OUT of aws_iam_role_policy.incident_lambda so the ADR-032 GREEN incident-Lambda policy is
# byte-unchanged when write-back is off. Grants the incident-Lambda role exactly what writeback.py
# needs: assume the two per-action write roles (#1 per-action role — the actual OpsItem/IM write is
# done UNDER those assumed roles, NOT this role), read-only response-plan routing, and GetParameter on
# the writeback config params. NO ssm:CreateOpsItem / ssm-incidents mutate here — those live on the
# assumed per-action roles (least-privilege; the incident-Lambda role itself cannot write).
resource "aws_iam_role_policy" "incident_lambda_writeback" {
  count = local.rwb
  name  = "${var.project}-incident-lambda-writeback"
  role  = aws_iam_role.incident_lambda[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    {
      Sid    = "AssumeWriteRoles"
      Effect = "Allow"
      Action = ["sts:AssumeRole"]
      Resource = [
        aws_iam_role.action_opscenter_write[0].arn, # reused 029/036 role (remediation.tf)
        aws_iam_role.action_incident_write[0].arn,  # writeback.tf
      ]
    },
    {
      # Read-only response-plan lookup for OpsCenter-vs-Incident-Manager routing (_route).
      Sid      = "ReadResponsePlans"
      Effect   = "Allow"
      Action   = ["ssm-incidents:ListResponsePlans", "ssm-incidents:GetResponsePlan"]
      Resource = "*"
    },
    {
      Sid    = "ReadWritebackParams"
      Effect = "Allow"
      Action = ["ssm:GetParameter"]
      Resource = [
        aws_ssm_parameter.writeback_opscenter_source[0].arn,
        aws_ssm_parameter.writeback_response_plan_map[0].arn,
        aws_ssm_parameter.writeback_slack_enabled[0].arn,
      ]
    }
  ] })
}

# ---- incident SM role: lambda:InvokeFunction on the 7 incident Lambdas + the reused
#      status_updater + SfnLogging ONLY. NO ecs:*, NO states:StartExecution, NO mutation. ----
resource "aws_iam_role" "incident_sfn" {
  count = local.il
  name  = "${var.project}-incident-sfn"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "incident_sfn" {
  count = local.il
  name  = "${var.project}-incident-sfn"
  role  = aws_iam_role.incident_sfn[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "InvokeIncidentLambdas", Effect = "Allow", Action = ["lambda:InvokeFunction"],
      # ADR-034: the writeback Lambda ARN is appended ONLY when rca_writeback_enabled (concat with an
      # empty list when off), so the OFF SM-role policy is byte-identical to the ADR-032 GREEN policy.
      Resource = concat([
        aws_lambda_function.incident_triage[0].arn,
        aws_lambda_function.incident_lead[0].arn,
        aws_lambda_function.incident_subagent[0].arn,
        aws_lambda_function.incident_rootcause[0].arn,
        aws_lambda_function.incident_mitigation_plan[0].arn,
        aws_lambda_function.incident_prevention[0].arn,
        aws_lambda_function.incident_stage_failed[0].arn,
        aws_lambda_function.status_updater[0].arn, # reused P2 terminalizer (failure path)
    ], local.rwb == 1 ? [aws_lambda_function.incident_writeback[0].arn] : []) },
  { Sid = "SfnLogging", Effect = "Allow", Action = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"], Resource = "*" }] })
}

############################################################
# Step 3: CloudWatch log groups (each Lambda + the SM).
############################################################
resource "aws_cloudwatch_log_group" "incident_lambdas" {
  count             = local.il
  name              = "/aws/lambda/${var.project}-incident"
  retention_in_days = 90 # incident audit
}
resource "aws_cloudwatch_log_group" "incident_watchdog" {
  count             = local.il
  name              = "/aws/lambda/${var.project}-incident-watchdog"
  retention_in_days = 90
}
resource "aws_cloudwatch_log_group" "incident_sfn" {
  count             = local.il
  name              = "/aws/vendedlogs/states/${var.project}-incident"
  retention_in_days = 90
}

############################################################
# Step 3 (cont.): the seven incident stage Lambdas (arm64, python3.12, pg8000 layer, VPC for Aurora).
#   Each handler is "<mod>.lambda_handler". Env: Aurora connection (db.py) + PROJECT (the Lambdas
#   derive the incident SSM paths from it) + the five SSM param names + the AgentCore runtime-ARN
#   param (agent_bridge.py reads SSM_RUNTIME_ARN_PARAM). NO mutation surface in any of these.
############################################################
locals {
  inc_env_base = local.il == 1 ? {
    AURORA_ENDPOINT = aws_rds_cluster.aurora.endpoint
    AURORA_DATABASE = aws_rds_cluster.aurora.database_name
    AURORA_USER     = "awsops_worker"
    PROJECT         = var.project # lifecycle.py derives /ops/<PROJECT>/incident/<suffix>
    # The five configurable-window SSM param NAMES (Addendum #4/#7). The Lambdas read the live
    # values (with safe fallbacks); these names document the contract + keep web/python aligned.
    INCIDENT_CORRELATION_WINDOW_PARAM = aws_ssm_parameter.incident_correlation_window[0].name
    INCIDENT_STAGE_TIMEOUT_PARAM      = aws_ssm_parameter.incident_stage_timeout[0].name
    INCIDENT_MAX_CONCURRENT_PARAM     = aws_ssm_parameter.incident_max_concurrent[0].name
    INCIDENT_FANOUT_MAX_PARAM         = aws_ssm_parameter.incident_fanout_max[0].name
    INCIDENT_MIN_SEVERITY_PARAM       = aws_ssm_parameter.incident_min_severity[0].name
    # AgentCore runtime-ARN SSM param (read-only Sub-agent consult bridge). agent_bridge.py reads
    # SSM_RUNTIME_ARN_PARAM; AGENTCORE_RUNTIME_ARN_PARAM is the plan-named alias (same value).
    SSM_RUNTIME_ARN_PARAM       = local.inc_runtime_arn_param
    AGENTCORE_RUNTIME_ARN_PARAM = local.inc_runtime_arn_param
  } : {}

  # ADR-034: the WriteBack stage Lambda env additions. Merged in ONLY when rca_writeback_enabled, so
  # the ADR-032 GREEN env (write-back off) is byte-identical and the other stage Lambdas are unchanged.
  # writeback.py reads: the two per-action role ARNs it assumes (#1 per-action role), the OpsCenter
  # source + the response-plan routing map + the public base URL for the evidence link. Slack uses the
  # webhook-url param (resolved at runtime from /ops/<project>/writeback/slack/* — read-only, no env).
  # writeback.py reads these env values DIRECTLY (not as SSM param names): WRITEBACK_OPSCENTER_SOURCE
  # is the OpsItem Source string (defaults to PROJECT); WRITEBACK_RESPONSE_PLAN_MAP is the JSON routing
  # map ("{}" => always OpsCenter). The writeback_* SSM params (writeback.tf) are the operator-tunable
  # live config of record; depend_on them so the params exist before the Lambda is wired.
  inc_env = local.rwb == 1 ? merge(local.inc_env_base, {
    ACTION_ROLE_OPSCENTER_CREATE_OPSITEM = aws_iam_role.action_opscenter_write[0].arn # reuse 029/036 role
    ACTION_ROLE_INCIDENT_WRITE           = aws_iam_role.action_incident_write[0].arn  # writeback.tf
    WRITEBACK_OPSCENTER_SOURCE           = var.project
    WRITEBACK_RESPONSE_PLAN_MAP          = "{}" # default: always OpsCenter. Operator overrides the live map in SSM.
    PUBLIC_BASE_URL                      = "https://${var.domain_name}"
  }) : local.inc_env_base
}

resource "aws_lambda_function" "incident_triage" {
  count            = local.il
  function_name    = "${var.project}-incident-triage"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "triage.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_lead" {
  count            = local.il
  function_name    = "${var.project}-incident-lead"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "lead.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_subagent" {
  count            = local.il
  function_name    = "${var.project}-incident-subagent"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "subagent.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_rootcause" {
  count            = local.il
  function_name    = "${var.project}-incident-rootcause"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "rootcause.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_mitigation_plan" {
  count            = local.il
  function_name    = "${var.project}-incident-mitigation-plan"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "mitigation_plan.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_prevention" {
  count            = local.il
  function_name    = "${var.project}-incident-prevention"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "prevention.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_lambda_function" "incident_stage_failed" {
  count            = local.il
  function_name    = "${var.project}-incident-stage-failed"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "incident_stage_failed.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 60
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

# ADR-034 WriteBack stage Lambda — provisioned ONLY when rca_writeback_enabled (count=local.rwb). Same
# role/layer/vpc/env as the other stage Lambdas (its env adds the per-action role ARNs + routing config
# via local.inc_env's rwb merge). Ships in the SAME incident_src archive (writeback.py + its imports are
# added to data.archive_file.incident_src only when rwb). It performs the single BEST-EFFORT marked
# observability write via the assumed per-action roles — never inline in the web BFF, never blocking.
resource "aws_lambda_function" "incident_writeback" {
  count            = local.rwb
  function_name    = "${var.project}-incident-writeback"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "writeback.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 600
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

############################################################
# Step 4: The incident SM (sibling STANDARD machine; T6 ASL) + the per-stage timeout watchdog.
#   ADR-034 (write-back): the committed incident.asl.json is the OFF graph (NO WriteBack state). ASL is
#   JSON (not conditional), so:
#     * OFF (local.rwb==0): local.incident_def is the RAW templatefile render of the committed ASL —
#       BYTE-IDENTICAL to the ADR-032 GREEN machine (no re-serialization, no whitespace/key reorder).
#       This guarantees zero plan diff vs the previously-shipped OFF graph.
#     * ON  (local.rwb==1): jsondecode the same render, splice the WriteBack + WriteBackSkipped states
#       in (repoint RootCause.Next -> WriteBack), and jsonencode. The WriteBack stage is BEST-EFFORT
#       NON-BLOCKING: its Catch (States.ALL) -> a Pass that CONTINUES to MitigationPlan — a write-back
#       failure NEVER stalls the incident or blocks the primary Slack/SNS notification.
############################################################
locals {
  # The raw templatefile render of the committed OFF ASL. Guard the [0] derefs: when local.il==0 the
  # incident_* Lambdas are count=0 and the SM resource is itself count=0 (the definition is never
  # consumed), so render an empty string. This keeps the OFF plan valid.
  incident_def_off = local.il == 1 ? templatefile("${local.inc_src}/incident.asl.json", {
    triage_fn_arn                = aws_lambda_function.incident_triage[0].arn
    lead_fn_arn                  = aws_lambda_function.incident_lead[0].arn
    subagent_fn_arn              = aws_lambda_function.incident_subagent[0].arn
    rootcause_fn_arn             = aws_lambda_function.incident_rootcause[0].arn
    mitigation_fn_arn            = aws_lambda_function.incident_mitigation_plan[0].arn
    prevention_fn_arn            = aws_lambda_function.incident_prevention[0].arn
    incident_stage_failed_fn_arn = aws_lambda_function.incident_stage_failed[0].arn
    status_fn_arn                = aws_lambda_function.status_updater[0].arn # reused P2 terminalizer
  }) : ""

  # ON: decode the same OFF render and splice the write-back branch in. Only evaluated when rwb==1.
  incident_asl_base = local.il == 1 && local.rwb == 1 ? jsondecode(local.incident_def_off) : null
  incident_asl_on = local.il == 1 && local.rwb == 1 ? merge(local.incident_asl_base, {
    States = merge(local.incident_asl_base.States, {
      # repoint RootCause -> WriteBack (everything else in RootCause preserved)
      RootCause = merge(local.incident_asl_base.States.RootCause, { Next = "WriteBack" })
      WriteBack = {
        Type           = "Task"
        Resource       = aws_lambda_function.incident_writeback[0].arn
        TimeoutSeconds = 600
        Comment        = "ADR-034 RCA write-back (observability-write). Reads incidents.rca (NO model re-run), renders a recommendation-only body, routes OpsCenter vs Incident Manager, performs ONE marked write via the 029/036 executor. BEST-EFFORT: any failure Catches to WriteBackSkipped and CONTINUES to MitigationPlan — it NEVER stalls the incident or blocks the primary notification. ResultPath isolates output so job_id+incident_id survive."
        ResultPath     = "$.writeback"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
          IntervalSeconds = 2
          MaxAttempts     = 2
          BackoffRate     = 2.0
        }]
        Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.writebackError", Next = "WriteBackSkipped" }]
        Next  = "MitigationPlan"
      }
      WriteBackSkipped = {
        Type    = "Pass"
        Comment = "Write-back is a SEPARATE best-effort branch (ADR-034). A failed write-back is non-fatal: the incident proceeds and the primary Slack/SNS path is untouched. Continue to MitigationPlan."
        Next    = "MitigationPlan"
      }
    })
  }) : null

  # Final SM definition: OFF => the byte-identical raw render; ON => the spliced+jsonencoded graph.
  incident_def = local.rwb == 1 ? jsonencode(local.incident_asl_on) : local.incident_def_off
}

resource "aws_sfn_state_machine" "incident" {
  count      = local.il
  name       = "${var.project}-incident"
  role_arn   = aws_iam_role.incident_sfn[0].arn
  type       = "STANDARD"
  definition = local.incident_def
  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.incident_sfn[0].arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }
  depends_on = [aws_iam_role_policy.incident_sfn]
}

# Per-stage timeout watchdog: flips stuck 'running' stages → 'stalled' (binding (b)/(d)). EventBridge
# rate(1 minute). The rule fires ONLY when the lifecycle flag is on (count=local.il) → no autonomous
# tick when off. The watchdog never cancels SFN / mutates AWS — two bounded conditional UPDATEs.
resource "aws_lambda_function" "incident_watchdog" {
  count            = local.il
  function_name    = "${var.project}-incident-watchdog"
  role             = aws_iam_role.incident_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "incident_watchdog.lambda_handler"
  filename         = data.archive_file.incident_src[0].output_path
  source_code_hash = data.archive_file.incident_src[0].output_base64sha256
  timeout          = 120
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.inc_env }
  depends_on = [aws_cloudwatch_log_group.incident_watchdog, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

resource "aws_cloudwatch_event_rule" "incident_watchdog" {
  count               = local.il
  name                = "${var.project}-incident-watchdog"
  description         = "ADR-032: per-stage timeout reaper — flips stale 'running' incident_stages to 'stalled'."
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "incident_watchdog" {
  count     = local.il
  rule      = aws_cloudwatch_event_rule.incident_watchdog[0].name
  target_id = "incident-watchdog"
  arn       = aws_lambda_function.incident_watchdog[0].arn
}

resource "aws_lambda_permission" "incident_watchdog" {
  count         = local.il
  statement_id  = "AllowEventBridgeWatchdog"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.incident_watchdog[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.incident_watchdog[0].arn
}

############################################################
# Step 6: ADR-032 Phase 4 — cross-incident PROACTIVE-PREVENTION feedback loop (gated; rate(24h)).
#   A periodic analyzer that reads recent incident/RCA history, detects RECURRING patterns
#   (rca.category x primary service over a window, recurrence >= threshold), and UPSERTs one
#   prevention_insight per recurring pattern (idempotent on dedup_key). RECOMMEND-ONLY: it emits
#   recommendations and performs ZERO AWS/k8s/SSM/SFN mutation — no /api/actions, no
#   create_ops_item / start_execution / put_parameter. It REUSES the incident-Lambda role
#   (aws_iam_role.incident_lambda — Aurora secret + KMS + scoped SSM reads; already grants
#   ssm:GetParameter on the project incident params via the ReadIncidentAndRuntimeParams Sid),
#   the pg8000 layer (aws_lambda_layer_version.pg8000), and the same vpc_config (private subnets +
#   service SG) EXACTLY as incident_watchdog. Inert when off: no incidents => no insights, and with
#   the lifecycle flag off the Lambda/schedule/SSM params are count=0 (plan No-changes, $0).
############################################################

# Operator-tunable window/threshold SSM params (ignore_changes on value — the analyzer reads the
# live values with safe fallbacks; defaults mirror prevention_loop.py PREVENTION_* env defaults).
resource "aws_ssm_parameter" "incident_prevention_window_days" {
  count       = local.il
  name        = "/ops/${var.project}/incident/prevention-window-days"
  description = "ADR-032 #4: cross-incident prevention look-back window (days). Operator-tunable; ignore drift."
  type        = "String"
  value       = "30"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "incident_prevention_threshold" {
  count       = local.il
  name        = "/ops/${var.project}/incident/prevention-recurrence-threshold"
  description = "ADR-032 #4: cross-incident recurrence threshold (>= N occurrences => emit one insight). Operator-tunable; ignore drift."
  type        = "String"
  value       = "2"
  lifecycle { ignore_changes = [value] }
}

# Dedicated archive (multi-source, mirroring data.archive_file.incident_src): packages the shared
# Aurora connector workers/db.py + the analyzer prevention_loop.py. prevention_loop.py imports `db`,
# which lives in local.workers_src_il (NOT local.inc_src) — so it MUST be co-packaged here, exactly
# as the incident archive co-packages db.py with each incident stage module.
data "archive_file" "prevention_loop" {
  count       = local.il
  type        = "zip"
  output_path = "${path.module}/.build/prevention_loop.zip"
  source {
    content  = file("${local.workers_src_il}/db.py") # shared Aurora pg8000 connector (same as incident_src)
    filename = "db.py"
  }
  source {
    content  = file("${local.inc_src}/prevention_loop.py")
    filename = "prevention_loop.py"
  }
}

# The prevention-loop Lambda. role/layer/vpc_config copied VERBATIM from incident_watchdog; only the
# function name, handler, source archive, and env additions differ. Aurora env wiring matches the
# other incident Lambdas (local.inc_env_base) — but inlined here (not local.inc_env) to add the two
# PREVENTION_* defaults + param names without touching the shared incident env map. RECOMMEND-ONLY:
# the incident-Lambda role carries NO mutating actions (no ecs:*, no states:StartExecution, no
# ssm:PutParameter, no ssm:CreateOpsItem) — see aws_iam_role_policy.incident_lambda above.
resource "aws_lambda_function" "prevention_loop" {
  count            = local.il
  function_name    = "${var.project}-prevention-loop"
  role             = aws_iam_role.incident_lambda[0].arn # reuse the incident-Lambda least-priv role
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "prevention_loop.lambda_handler"
  filename         = data.archive_file.prevention_loop[0].output_path
  source_code_hash = data.archive_file.prevention_loop[0].output_base64sha256
  timeout          = 120
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment {
    variables = {
      AURORA_ENDPOINT                 = aws_rds_cluster.aurora.endpoint
      AURORA_DATABASE                 = aws_rds_cluster.aurora.database_name
      AURORA_USER                     = "awsops_worker"
      PROJECT                         = var.project
      PREVENTION_WINDOW_DAYS          = aws_ssm_parameter.incident_prevention_window_days[0].value
      PREVENTION_RECURRENCE_THRESHOLD = aws_ssm_parameter.incident_prevention_threshold[0].value
      PREVENTION_WINDOW_DAYS_PARAM    = aws_ssm_parameter.incident_prevention_window_days[0].name
      PREVENTION_THRESHOLD_PARAM      = aws_ssm_parameter.incident_prevention_threshold[0].name
    }
  }
  depends_on = [aws_cloudwatch_log_group.incident_lambdas, aws_iam_role_policy_attachment.incident_lambda_vpc]
}

# EventBridge rate(24 hours): the periodic prevention sweep. Fires ONLY when the lifecycle flag is on
# (count=local.il) — no autonomous tick when off. The target Lambda is recommend-only.
resource "aws_cloudwatch_event_rule" "prevention_loop" {
  count               = local.il
  name                = "${var.project}-prevention-loop"
  description         = "ADR-032 Phase 4: daily cross-incident prevention sweep — UPSERTs recurring-pattern insights (recommend-only)."
  schedule_expression = "rate(24 hours)"
}

resource "aws_cloudwatch_event_target" "prevention_loop" {
  count     = local.il
  rule      = aws_cloudwatch_event_rule.prevention_loop[0].name
  target_id = "prevention-loop"
  arn       = aws_lambda_function.prevention_loop[0].arn
}

resource "aws_lambda_permission" "prevention_loop_events" {
  count         = local.il
  statement_id  = "AllowEventBridgePreventionLoop"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.prevention_loop[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.prevention_loop[0].arn
}

############################################################
# Step 5: Gated output (mirror workers/remediation one(...) style).
############################################################
output "incident_state_machine_arn" { value = one(aws_sfn_state_machine.incident[*].arn) }
