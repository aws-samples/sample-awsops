# Scheduled-diagnosis email notifications (v1 report-scheduler parity), gated on diagnosis_notify_enabled.
# One dedicated SNS topic: the worker publishes a summary+link when a SCHEDULED report finishes; the web
# BFF manages its email subscriptions (admin-only). Governed external-comms write (ADR-040/041) — every
# IAM grant is scoped to this single topic ARN; this is NOT the frozen AWS-resource-mutation class.
# false (default) → empty count/for_each everywhere → 0 resources, $0.
locals {
  notify_count     = var.diagnosis_notify_enabled ? 1 : 0
  notify_topic_arn = try(aws_sns_topic.diagnosis[0].arn, "")
  # Worker publish lives on the worker roles, which only exist when workers_enabled.
  notify_worker_roles = (var.diagnosis_notify_enabled && var.workers_enabled) ? toset(["task", "lambda"]) : toset([])

  # Env injected into the web/worker task defs ONLY when enabled — appended via concat/merge so that
  # flag-off appends nothing → ZERO task-definition diff (no churn, no redeploy, $0). The worker needs
  # both vars; the web container already has APP_DOMAIN so it needs only the topic ARN.
  notify_worker_env_list = var.diagnosis_notify_enabled ? [
    { name = "DIAGNOSIS_SNS_TOPIC_ARN", value = local.notify_topic_arn },
    { name = "APP_DOMAIN", value = var.domain_name },
  ] : []
  notify_worker_env_map = var.diagnosis_notify_enabled ? {
    DIAGNOSIS_SNS_TOPIC_ARN = local.notify_topic_arn
    APP_DOMAIN              = var.domain_name
  } : {}
  notify_web_env_list = var.diagnosis_notify_enabled ? [
    { name = "DIAGNOSIS_SNS_TOPIC_ARN", value = local.notify_topic_arn },
  ] : []
}

resource "aws_sns_topic" "diagnosis" {
  count = local.notify_count
  name  = "${var.project}-diagnosis-notifications"
  # SSE at rest with the AWS-managed SNS key. Its key policy authorizes account principals to use it via
  # SNS, so publishers need NO explicit kms IAM (see the worker policy note below).
  kms_master_key_id = "alias/aws/sns"
  tags              = { Name = "${var.project}-diagnosis-notifications" }
}

# Worker (Fargate task + short Lambda) → sns:Publish on the one topic. No kms grant needed: the topic
# uses the AWS-managed key (alias/aws/sns), whose key policy already authorizes account principals to use
# it *via SNS* — so publishers need no explicit kms IAM (adding it would be both redundant and an unscoped
# Resource="*" governance gap; consensus gate, 2026-06-19). for_each is empty unless notify + workers enabled.
resource "aws_iam_role_policy" "worker_diagnosis_notify" {
  for_each = local.notify_worker_roles
  name     = "${var.project}-worker-${each.key}-diagnosis-notify"
  role     = each.key == "task" ? aws_iam_role.worker_task[0].id : aws_iam_role.worker_lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "PublishDiagnosisNotification"
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = aws_sns_topic.diagnosis[0].arn
    }]
  })
}

# Web task role → manage the email subscriptions for this one topic (in-app admin UI). Read-only on the
# rest of SNS; no CreateTopic / DeleteTopic / Publish. aws_iam_role.task always exists (no count).
resource "aws_iam_role_policy" "task_diagnosis_notify" {
  count = local.notify_count
  name  = "${var.project}-task-diagnosis-notify"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ManageDiagnosisSubscriptions"
      Effect   = "Allow"
      Action   = ["sns:Subscribe", "sns:Unsubscribe", "sns:ListSubscriptionsByTopic", "sns:GetTopicAttributes"]
      Resource = aws_sns_topic.diagnosis[0].arn
    }]
  })
}

output "diagnosis_notify_topic_arn" {
  description = "SNS topic ARN for scheduled-diagnosis email (empty when diagnosis_notify_enabled=false)."
  value       = local.notify_topic_arn
}
