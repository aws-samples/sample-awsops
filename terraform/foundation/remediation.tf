# terraform/foundation/remediation.tf
# AWSops v2 ADR-029+036 — remediation / mutation execution substrate.
# EVERY resource here is gated by var.remediation_enabled (default false → count=0 → ZERO AWS
# resources, ZERO cost, ZERO live mutation). This EXTENDS the P2 backbone (workers.tf): it reuses
# the worker_jobs Aurora ledger, the SQS queue + dispatcher + status_updater + reaper, and the
# idempotency invariant (SFN execution name == job_id). It adds ONE sibling Step Functions machine
# (remediation), an SSM Automation/Change Manager AWS-resource executor, a per-action P2-code
# executor task role, an S3 Object-Lock audit bucket, an EventBridge SSM status-change resume
# Lambda, and the kill-switch SSM param. Nothing here mutates customer infra until an operator
# flips remediation_enabled, sets the kill-switch true, enables a catalog row, AND a 4-eyes
# approval passes. Design refs: ADR-029 (6 controls) + ADR-036 (hybrid substrate).
locals {
  re = var.remediation_enabled ? 1 : 0
  # ADR-040/041 §4 — the external DATA-write plane. `iw` gates its OWN resources (kill-switch, Slack
  # role/secret, external IAM). `re_or_iw` gates the SHARED execution infra (SM + executor/resume
  # Lambdas + audit bucket + SFN role/logs) so the executor EXISTS for Slack while remediation stays
  # off — AWS-resource safety is NOT infra-existence (it's the flag env + enabled + the prefix split +
  # the IAM split). Both default false ⇒ re_or_iw=0 ⇒ unchanged.
  iw              = var.integrations_write_enabled ? 1 : 0
  re_or_iw        = (var.remediation_enabled || var.integrations_write_enabled) ? 1 : 0
  rem_src         = "${path.module}/../../scripts/v2/remediation"
  workers_src_re  = "${path.module}/../../scripts/v2/workers" # reuse db.py/status_updater
  rem_acct        = data.aws_caller_identity.current.account_id
  worker_cname_re = local.worker_cname # reuse the worker container name (workers.tf)
}

############################################################
# Step 1: Kill-switch + cross-account toggle SSM params
#   default OFF; ignore_changes on value (operator-toggled), mirror the agentcore param style.
############################################################
resource "aws_ssm_parameter" "mutating_enabled" {
  count       = local.re
  name        = "/ops/${var.project}/mutating-actions/enabled"
  description = "ADR-029 kill-switch. 'false' (default) blocks ALL mutating execution (planning/dry-run still work). Operator-toggled; ignore drift."
  type        = "String"
  value       = "false"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "allow_cross_account" {
  count       = local.re
  name        = "/ops/${var.project}/mutating-actions/allow-cross-account"
  description = "ADR-029 #8 toggle. 'false' (default) = host-account-only mutation. Lifting requires a follow-up ADR + member-account AutomationAssumeRole."
  type        = "String"
  value       = "false"
  lifecycle { ignore_changes = [value] }
}

############################################################
# Step 2: S3 Object-Lock audit bucket (governance mode, 1yr; ADR-029 #6 second synchronous sink).
############################################################
resource "aws_s3_bucket" "remediation_audit" {
  count               = local.re_or_iw
  bucket              = "${var.project}-remediation-audit-${local.rem_acct}"
  object_lock_enabled = true
  force_destroy       = false
}
resource "aws_s3_bucket_versioning" "remediation_audit" {
  count  = local.re_or_iw
  bucket = aws_s3_bucket.remediation_audit[0].id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_object_lock_configuration" "remediation_audit" {
  count  = local.re_or_iw
  bucket = aws_s3_bucket.remediation_audit[0].id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = 365
    }
  }
}
resource "aws_s3_bucket_public_access_block" "remediation_audit" {
  count                   = local.re_or_iw
  bucket                  = aws_s3_bucket.remediation_audit[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

############################################################
# Step 3: SSM Automation document (Git→SSM sync) for the example AWS action.
############################################################
resource "aws_ssm_document" "ec2_create_tags" {
  count           = local.re
  name            = "${var.project}-ec2-create-tags"
  document_type   = "Automation"
  document_format = "YAML"
  content         = file("${local.rem_src}/runbooks/ec2-create-tags.yaml")
}

############################################################
# Step 4: Per-runbook AutomationAssumeRole (scoped; exact-ARN/allowlist where Modify* lacks tag
#   conditions — ADR-029 #5 revision).
############################################################
data "aws_iam_policy_document" "ssm_assume" {
  count = local.re
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ssm.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "automation_ec2_tags" {
  count              = local.re
  name               = "${var.project}-automation-ec2-create-tags"
  assume_role_policy = data.aws_iam_policy_document.ssm_assume[0].json
}
resource "aws_iam_role_policy" "automation_ec2_tags" {
  count = local.re
  name  = "${var.project}-automation-ec2-create-tags"
  role  = aws_iam_role.automation_ec2_tags[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # ec2:CreateTags/DeleteTags accept a resource-level scope; pin to the host region.
      # (No tag-on-create condition: CreateTags is the tag op itself — use region + the
      #  catalog's resourceArnAllowlist enforced in the runbook allowedPattern + web validation.)
      { Effect = "Allow", Action = ["ec2:CreateTags", "ec2:DeleteTags"], Resource = "arn:aws:ec2:${var.region}:${local.rem_acct}:instance/*",
      Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
      { Effect = "Allow", Action = ["ec2:DescribeTags"], Resource = "*" }
    ]
  })
}

############################################################
# Step 5: Per-action P2-code task roles (NOT the shared worker role — ADR-036 #3).
#   The remediation executor assumes these via STS.
############################################################
resource "aws_iam_role" "action_app_feature_flag" {
  count = local.re
  name  = "${var.project}-action-app-feature-flag"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Principal = { AWS = aws_iam_role.worker_lambda[0].arn }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "action_app_feature_flag" {
  count = local.re
  name  = "${var.project}-action-app-feature-flag"
  role  = aws_iam_role.action_app_feature_flag[0].id
  # App-state only: Aurora secret + KMS (the flag row lives in Aurora). NO AWS-resource mutate.
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_rds_cluster.aurora.master_user_secret[0].secret_arn },
  { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.aurora.arn }] })
}
resource "aws_iam_role" "action_opscenter_write" {
  count = local.re
  name  = "${var.project}-action-opscenter-write"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Principal = { AWS = aws_iam_role.worker_lambda[0].arn }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "action_opscenter_write" {
  count = local.re
  name  = "${var.project}-action-opscenter-write"
  role  = aws_iam_role.action_opscenter_write[0].id
  # ADR-036 #5 reduced subset: a single non-destructive observability write.
  policy = jsonencode({ Version = "2012-10-17", Statement = [
  { Effect = "Allow", Action = ["ssm:CreateOpsItem"], Resource = "*" }] })
}

############################################################
# Step 6: Change Manager change template (AutoApprove=false, approvers exclude the AWSops
#   principal — ADR-036 #2). Created via aws_ssm_document of type Automation.ChangeTemplate.
############################################################
resource "aws_ssm_document" "change_template" {
  count           = local.re
  name            = "${var.project}-remediation-change-template"
  document_type   = "Automation.ChangeTemplate"
  document_format = "YAML"
  content = yamlencode({
    schemaVersion       = "0.3"
    description         = "AWSops remediation change template — 4-eyes (AutoApprove=false; approvers must be HUMAN IAM principals, NOT the AWSops task role)."
    templateInformation = "AWSops mutating action. Requires a human approver (Change Manager approver role + ssm:SendAutomationSignal). The requesting AWSops principal is excluded from the approver set."
    executableRunBooks  = [{ name = aws_ssm_document.ec2_create_tags[0].name, version = "$DEFAULT" }]
    # AutoApprove is FALSE by omitting any auto-approval rule; approver groups are configured
    # out-of-band by the operator (human IAM principals only). The template enforces the gate.
  })
}

############################################################
# Step 7: CloudWatch log groups + remediation SFN role + the SFN itself (the sibling SM; T7 ASL).
############################################################
resource "aws_cloudwatch_log_group" "remediation_sfn" {
  count             = local.re_or_iw
  name              = "/aws/vendedlogs/states/${var.project}-remediation"
  retention_in_days = 90 # longer than workers: mutation audit
}
resource "aws_cloudwatch_log_group" "remediation_lambdas" {
  count             = local.re_or_iw
  name              = "/aws/lambda/${var.project}-remediation"
  retention_in_days = 90
}

resource "aws_iam_role" "remediation_sfn" {
  count = local.re_or_iw
  name  = "${var.project}-remediation-sfn"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "remediation_sfn" {
  count = local.re_or_iw
  name  = "${var.project}-remediation-sfn"
  role  = aws_iam_role.remediation_sfn[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "InvokeRemediationLambdas", Effect = "Allow", Action = ["lambda:InvokeFunction"],
      Resource = [aws_lambda_function.remediation_executor[0].arn, aws_lambda_function.record_ssm_start[0].arn,
    aws_lambda_function.approval_notifier[0].arn, aws_lambda_function.status_updater[0].arn] },
    { Sid = "RunFargateExecutor", Effect = "Allow", Action = ["ecs:RunTask"],
    Resource = "arn:aws:ecs:${var.region}:${local.rem_acct}:task-definition/${var.project}-worker:*" },
    { Sid = "ControlTasks", Effect = "Allow", Action = ["ecs:StopTask", "ecs:DescribeTasks"], Resource = "*" },
    { Sid      = "PassTaskRoles", Effect = "Allow", Action = ["iam:PassRole"],
      Resource = [aws_iam_role.execution.arn, aws_iam_role.worker_task[0].arn],
    Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } },
    { Sid = "EcsSyncManagedRule", Effect = "Allow", Action = ["events:PutTargets", "events:PutRule", "events:DescribeRule"],
    Resource = "arn:aws:events:${var.region}:${local.rem_acct}:rule/StepFunctionsGetEventsForECSTaskRule" },
  { Sid = "SfnLogging", Effect = "Allow", Action = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"], Resource = "*" }] })
}

resource "aws_sfn_state_machine" "remediation" {
  count    = local.re_or_iw
  name     = "${var.project}-remediation"
  role_arn = aws_iam_role.remediation_sfn[0].arn
  type     = "STANDARD"
  definition = templatefile("${local.rem_src}/remediation.asl.json", {
    executor_fn_arn   = aws_lambda_function.remediation_executor[0].arn
    record_ssm_fn_arn = aws_lambda_function.record_ssm_start[0].arn
    approval_fn_arn   = aws_lambda_function.approval_notifier[0].arn
    status_fn_arn     = aws_lambda_function.status_updater[0].arn
    cluster_arn       = aws_ecs_cluster.main.arn
    # FAMILY (revision-less) — same fix as workers.tf: pinning the revisioned ARN breaks runTask with
    # "TaskDefinition is inactive" when the shared worker task def is replaced. IAM allows worker:*.
    task_def_arn   = aws_ecs_task_definition.worker[0].family
    subnets_json   = jsonencode(local.private_subnet_ids)
    sg_id          = aws_security_group.service.id
    container_name = local.worker_cname_re
  })
  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.remediation_sfn[0].arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }
  depends_on = [aws_iam_role_policy.remediation_sfn]
}

############################################################
# Step 8: The remediation Lambdas (executor, record_ssm_start, approval_notifier, status_resume).
#   Packaged from scripts/v2/remediation/ + the shared scripts/v2/workers/db.py. VPC (Aurora),
#   reuse the pg8000 layer + aws_security_group.service. The shared worker_lambda role gets an
#   inline STS/SSM/kill-switch policy (it only needs Aurora + STS:AssumeRole on per-action roles).
############################################################
data "archive_file" "remediation_src" {
  count       = local.re_or_iw
  type        = "zip"
  output_path = "${path.module}/.build/remediation_src.zip"
  source {
    content  = file("${local.workers_src_re}/db.py")
    filename = "db.py"
  }
  source {
    content  = file("${local.rem_src}/action_catalog.py")
    filename = "action_catalog.py"
  }
  source {
    content  = file("${local.rem_src}/remediation_executor.py")
    filename = "remediation_executor.py"
  }
  source {
    content  = file("${local.rem_src}/record_ssm_start.py")
    filename = "record_ssm_start.py"
  }
  source {
    content  = file("${local.rem_src}/status_resume.py")
    filename = "status_resume.py"
  }
  source {
    content  = file("${local.rem_src}/ssm_bridge.py")
    filename = "ssm_bridge.py"
  }
  source {
    content  = file("${local.rem_src}/approval_notifier.py")
    filename = "approval_notifier.py"
  }
}

# Remediation executor needs STS:AssumeRole on the per-action roles + SSM start/get + kill-switch read.
resource "aws_iam_role_policy" "remediation_lambda_extra" {
  count = local.re
  name  = "${var.project}-remediation-lambda-extra"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "AssumePerActionRoles", Effect = "Allow", Action = ["sts:AssumeRole"],
    Resource = [aws_iam_role.action_app_feature_flag[0].arn, aws_iam_role.action_opscenter_write[0].arn] },
    { Sid = "StartSsmAutomation", Effect = "Allow", Action = ["ssm:StartAutomationExecution", "ssm:GetAutomationExecution"],
    Resource = "*" },
    { Sid      = "PassAutomationRole", Effect = "Allow", Action = ["iam:PassRole"],
      Resource = [aws_iam_role.automation_ec2_tags[0].arn],
    Condition = { StringEquals = { "iam:PassedToService" = "ssm.amazonaws.com" } } },
    { Sid = "ReadKillSwitch", Effect = "Allow", Action = ["ssm:GetParameter"],
    Resource = [aws_ssm_parameter.mutating_enabled[0].arn, aws_ssm_parameter.allow_cross_account[0].arn] },
    { Sid = "ResumeSfn", Effect = "Allow", Action = ["states:SendTaskSuccess", "states:SendTaskFailure"],
    Resource = aws_sfn_state_machine.remediation[0].arn },
    { Sid = "AuditBucket", Effect = "Allow", Action = ["s3:PutObject"],
  Resource = "${aws_s3_bucket.remediation_audit[0].arn}/*" }] })
}

locals {
  # ADR-040/041 §4 — base executor env present whenever the executor EXISTS (either plane). The flags
  # track the VARS (NOT infra-existence — opus R2 CRITICAL-1): REMEDIATION_ENABLED is "false" under
  # iw-only so the executor's AWS-resource gate fail-closes. iw-gated ARNs use one()/coalesce (null→"").
  rem_env_base = local.re_or_iw == 1 ? {
    AURORA_ENDPOINT                = aws_rds_cluster.aurora.endpoint
    AURORA_DATABASE                = aws_rds_cluster.aurora.database_name
    AURORA_USER                    = "awsops_worker"
    REMEDIATION_ENABLED            = tostring(var.remediation_enabled)
    INTEGRATIONS_WRITE_ENABLED     = tostring(var.integrations_write_enabled)
    INTEGRATIONS_WRITE_SSM         = coalesce(one(aws_ssm_parameter.integrations_write_enabled[*].name), "")
    SLACK_SECRET_ARN               = coalesce(one(aws_secretsmanager_secret.slack[*].arn), "")
    ACTION_ROLE_SLACK_POST_MESSAGE = coalesce(one(aws_iam_role.action_slack_write[*].arn), "")
    AUDIT_BUCKET                   = aws_s3_bucket.remediation_audit[0].id
  } : {}
  # AWS-resource-specific env — ONLY when the (frozen) remediation plane is on.
  rem_env_aws = local.re == 1 ? {
    MUTATING_ACTIONS_SSM                 = aws_ssm_parameter.mutating_enabled[0].name
    EC2_CREATE_TAGS_DOC                  = aws_ssm_document.ec2_create_tags[0].name
    ASSUME_ROLE_EC2_CREATE_TAGS          = aws_iam_role.automation_ec2_tags[0].arn
    ACTION_ROLE_APP_FEATURE_FLAG_SET     = aws_iam_role.action_app_feature_flag[0].arn
    ACTION_ROLE_OPSCENTER_CREATE_OPSITEM = aws_iam_role.action_opscenter_write[0].arn
    # NB: REMEDIATION_STATE_MACHINE_ARN is intentionally NOT injected here. These Lambdas resume the
    # parked SM via the per-execution task token (states:SendTaskSuccess/Failure), never by the SM ARN
    # — no source reads this var. Injecting it created a hard graph cycle (SM templatefile → Lambda
    # ARNs; Lambda env → rem_env → SM). The ARN is still surfaced via the gated output + the dispatcher
    # env + the web env. (Plan-as-written defect; removing the unused self-reference breaks the cycle
    # without weakening any control.)
  } : {}
  rem_env = merge(local.rem_env_base, local.rem_env_aws)
}

# ===== ADR-040/041 external knowledge/comms DATA-write (Slack) — OWN control plane, ZERO AWS-mutation =====
# All iw-gated (default off → $0). Requires integrations_enabled (the Slack secret uses the integrations
# CMK) + workers_enabled (shared executor infra). Enabling these can NEVER enable AWS-resource mutation.
resource "aws_ssm_parameter" "integrations_write_enabled" {
  count     = local.iw
  name      = "/ops/${var.project}/integrations-write/enabled"
  type      = "String"
  value     = "false" # operator-toggled live kill-switch — SEPARATE from the AWS mutating-actions switch
  overwrite = true
  lifecycle { ignore_changes = [value] }
}

resource "aws_secretsmanager_secret" "slack" {
  count       = local.iw
  name        = "ops/${var.project}/integrations/slack-bot-token"
  description = "ADR-040 Slack bot token for the governed external-write executor (integrations CMK)."
  kms_key_id  = aws_kms_key.integrations[0].arn
}

# Per-action role the executor assumes for a Slack write — ONLY secrets/kms, NO AWS-mutation.
resource "aws_iam_role" "action_slack_write" {
  count = local.iw
  name  = "${var.project}-action-slack-write"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
  Effect = "Allow", Principal = { AWS = aws_iam_role.worker_lambda[0].arn }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "action_slack_write" {
  count = local.iw
  name  = "${var.project}-action-slack-write"
  role  = aws_iam_role.action_slack_write[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "SlackSecretRead", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"],
    Resource = aws_secretsmanager_secret.slack[0].arn },
  { Sid = "SlackSecretKms", Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.integrations[0].arn }] })
}

# The executor's EXTERNAL slice on the worker_lambda role (iw): ONLY assume the Slack role + read the
# external kill-switch + audit. The StartSsmAutomation / AWS-action-role assume / PassRole statements
# stay in remediation_lambda_extra (re-only) → the data-write role carries ZERO AWS-mutation capability.
resource "aws_iam_role_policy" "remediation_lambda_integrations" {
  count = local.iw
  name  = "${var.project}-remediation-lambda-integrations"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "AssumeSlackRole", Effect = "Allow", Action = ["sts:AssumeRole"], Resource = aws_iam_role.action_slack_write[0].arn },
    { Sid = "ReadIntegrationsKillSwitch", Effect = "Allow", Action = ["ssm:GetParameter"], Resource = aws_ssm_parameter.integrations_write_enabled[0].arn },
  { Sid = "AuditBucketIntegrations", Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.remediation_audit[0].arn}/*" }] })
}

resource "aws_lambda_function" "remediation_executor" {
  count            = local.re_or_iw
  function_name    = "${var.project}-remediation-executor"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "remediation_executor.lambda_handler"
  filename         = data.archive_file.remediation_src[0].output_path
  source_code_hash = data.archive_file.remediation_src[0].output_base64sha256
  timeout          = 900
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.rem_env }
  depends_on = [aws_cloudwatch_log_group.remediation_lambdas, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

resource "aws_lambda_function" "record_ssm_start" {
  count            = local.re_or_iw
  function_name    = "${var.project}-remediation-record-ssm-start"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "record_ssm_start.lambda_handler"
  filename         = data.archive_file.remediation_src[0].output_path
  source_code_hash = data.archive_file.remediation_src[0].output_base64sha256
  timeout          = 60
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.rem_env }
  depends_on = [aws_cloudwatch_log_group.remediation_lambdas, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

resource "aws_lambda_function" "approval_notifier" {
  count            = local.re_or_iw
  function_name    = "${var.project}-remediation-approval-notifier"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "approval_notifier.lambda_handler"
  filename         = data.archive_file.remediation_src[0].output_path
  source_code_hash = data.archive_file.remediation_src[0].output_base64sha256
  timeout          = 60
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.rem_env }
  depends_on = [aws_cloudwatch_log_group.remediation_lambdas, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

resource "aws_lambda_function" "status_resume" {
  count            = local.re
  function_name    = "${var.project}-remediation-status-resume"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "status_resume.lambda_handler"
  filename         = data.archive_file.remediation_src[0].output_path
  source_code_hash = data.archive_file.remediation_src[0].output_base64sha256
  timeout          = 120
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.service.id]
  }
  environment { variables = local.rem_env }
  depends_on = [aws_cloudwatch_log_group.remediation_lambdas, aws_iam_role_policy_attachment.worker_lambda_vpc]
}

############################################################
# Step 9: EventBridge rule on SSM Automation status-change → status_resume.
############################################################
resource "aws_cloudwatch_event_rule" "ssm_status_change" {
  count       = local.re
  name        = "${var.project}-ssm-automation-status"
  description = "ADR-036: SSM Automation execution status-change → resume the parked remediation SFN task."
  event_pattern = jsonencode({
    source        = ["aws.ssm"]
    "detail-type" = ["EC2 Automation Execution Status-change Notification", "SSM Automation Execution Status-change Notification"]
  })
}
resource "aws_cloudwatch_event_target" "ssm_status_change" {
  count     = local.re
  rule      = aws_cloudwatch_event_rule.ssm_status_change[0].name
  target_id = "status-resume"
  arn       = aws_lambda_function.status_resume[0].arn
}
resource "aws_lambda_permission" "ssm_status_change" {
  count         = local.re
  statement_id  = "AllowEventBridgeResume"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.status_resume[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ssm_status_change[0].arn
}

############################################################
# Step 12: Gated outputs (mirror workers one(...) style).
############################################################
output "remediation_state_machine_arn" { value = one(aws_sfn_state_machine.remediation[*].arn) }
output "remediation_audit_bucket" { value = one(aws_s3_bucket.remediation_audit[*].id) }
output "mutating_kill_switch_param" { value = one(aws_ssm_parameter.mutating_enabled[*].name) }
