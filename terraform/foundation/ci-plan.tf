# The optional plan-role grant is separate from application/task permissions.
# ReadOnlyAccess omits secret values, but Terraform refreshes this owned version.
variable "ci_terraform_plan_role_name" {
  type        = string
  default     = ""
  description = "Existing CI plan role allowed to refresh this stack's Steampipe secret version. Empty disables the grant."
  validation {
    condition     = var.ci_terraform_plan_role_name == "" || can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.ci_terraform_plan_role_name))
    error_message = "Use an existing IAM role name, or empty to disable; ARNs and wildcard names are not accepted."
  }
}

resource "aws_iam_role_policy" "ci_plan_steampipe_read" {
  count = local.sp > 0 && var.ci_terraform_plan_role_name != "" ? 1 : 0
  name  = "${var.project}-ci-plan-steampipe-read"
  role  = var.ci_terraform_plan_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "RefreshOwnedSteampipeSecret"
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.steampipe[0].arn]
    }]
  })
}
