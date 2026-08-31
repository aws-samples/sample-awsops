# terraform/foundation/writeback.tf
# AWSops v2 ADR-034 — RCA write-back (observability-write tier). EVERY resource here is gated by
# var.rca_writeback_enabled (local.rwb; default false => count=0 => ZERO write-back infra, ZERO cost,
# ZERO OpsCenter / Incident-Manager write). The webhook marker-drop ingress filter is ALWAYS-ON and
# lives in the web BFF (independent of this flag) — it is the feedback-loop safety control.
#
# REUSES the 029/036 action_opscenter_write role (remediation.tf) for the OpsItem write; adds ONLY the
# Incident Manager per-action role + the write-back SSM config params here. The WriteBack stage Lambda
# (aws_lambda_function.incident_writeback) and its IAM wiring live in incidents.tf (it ships in the
# incident_src archive and runs as a stage of the incident SM, spliced in only when local.rwb).
#
# REQUIRES incident_lifecycle_enabled=true (the write-back is a stage of the incident SM and reads
# incidents.rca) AND remediation_enabled=true (reuses the opscenter-create-opsitem catalog action +
# the action_opscenter_write per-action role). See variables.tf (rca_writeback_enabled).
#
# SAFETY: the write-back is BEST-EFFORT NON-BLOCKING (a write failure never blocks the primary
# Slack/SNS notification) and recommendation-only ("AWSops recommendation", never "confirmed root
# cause"). The single AWS write is performed UNDER an assumed per-action role (#1), is MARKED
# (CreatedBy=AWSops-AIOps) so the always-on ingress filter drops the resulting echo, and is single-
# operator (NO 4-eyes — this is NOT the /api/actions mutating path).

locals { rwb_acct = data.aws_caller_identity.current.account_id }

# Incident Manager per-action role (ADR-036 #1 per-action IAM). Assumed by the incident-Lambda role
# (incidents.tf). ssm-incidents enrich ONLY (timeline event / incident-record update) — NO ssm:*
# infra mutate, NO destructive action. Routing reads (ListResponsePlans/GetResponsePlan) are granted
# so the same assumed session can confirm the target record.
resource "aws_iam_role" "action_incident_write" {
  count = local.rwb
  name  = "${var.project}-action-incident-write"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Principal = { AWS = aws_iam_role.incident_lambda[0].arn }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "action_incident_write" {
  count = local.rwb
  name  = "${var.project}-action-incident-write"
  role  = aws_iam_role.action_incident_write[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ssm-incidents:CreateTimelineEvent", "ssm-incidents:UpdateIncidentRecord",
      "ssm-incidents:GetIncidentRecord", "ssm-incidents:ListResponsePlans", "ssm-incidents:GetResponsePlan"],
  Resource = "*" }] })
}

# Write-back config params (operator-tunable; ignore drift). Live config of record; the IAM/enable
# wiring lives in TF/catalog. The WriteBack Lambda reads the routing map + the source string + the
# Slack-enabled toggle at runtime (read-only ssm:GetParameter, granted by incident_lambda_writeback).
resource "aws_ssm_parameter" "writeback_opscenter_source" {
  count       = local.rwb
  name        = "/ops/${var.project}/writeback/opscenter-source"
  description = "ADR-034: OpsItem Source string for write-back OpsItems. Operator-tunable; ignore drift."
  type        = "String"
  value       = var.project
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "writeback_response_plan_map" {
  count       = local.rwb
  name        = "/ops/${var.project}/writeback/response-plan-map"
  description = "ADR-034 routing: JSON map {trigger_source -> incidentRecordArn}. Empty {} => always OpsCenter."
  type        = "String"
  value       = "{}"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "writeback_slack_enabled" {
  count       = local.rwb
  name        = "/ops/${var.project}/writeback/slack/enabled"
  description = "ADR-034: secondary best-effort Slack thread on the write-back recommendation (false default)."
  type        = "String"
  value       = "false"
  lifecycle { ignore_changes = [value] }
}

output "writeback_incident_write_role_arn" { value = one(aws_iam_role.action_incident_write[*].arn) }
