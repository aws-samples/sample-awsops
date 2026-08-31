# terraform/foundation/k8sgpt.tf
# AWSops v2 ADR-035 — K8sGPT in-cluster diagnosis, AWSOPS-SIDE SUBSTRATE ONLY.
# Gated by var.k8sgpt_enabled (default false → count=0 → ZERO gated AWS resources, ZERO cost).
#
# REUSE (no new infra): the Result CRD reader is a BFF route reusing the P3-D presigned-STS read
# path (web/lib/eks-incluster.ts — the awsops-v2-task Access Entry + AmazonEKSViewPolicy from
# eks.tf, GET-only); the Haiku 4.5 narration rides the EXISTING AgentCore runtime (Container agent,
# ai.tf). NO new compute, NO new IAM role, NO ECR. The always-present k8s_findings/k8s_scan_runs
# tables (migration v7) are inert when off.
#
# OUT-OF-BAND (NOT here, mirrors ADR-029 §7 KEDA): the K8sGPT operator Helm install, its read-only
# ClusterRole + --fix-off config, and binding the Result-CRD read RBAC to awsops-v2-task are ALL
# operator/cluster-admin actions documented in docs/runbooks/k8sgpt-operator-install.md. AWSops
# issues ONLY HTTP GET against the cluster API — it NEVER writes to the shared EKS cluster.
#
# The ONLY gated AWS resource is the Rule 11 monthly Bedrock budget alarm.

locals {
  k8s = var.k8sgpt_enabled ? 1 : 0
}

# Rule 11 — monthly Bedrock budget alarm scoped to the narration spend. Notifies via email when
# actual or forecasted spend crosses the threshold. No enforcement (cost VISIBILITY, not a kill).
resource "aws_budgets_budget" "k8sgpt_bedrock" {
  count        = local.k8s
  name         = "${var.project}-k8sgpt-bedrock-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.k8sgpt_monthly_bedrock_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "Service"
    values = ["Amazon Bedrock"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.admin_email] # reuse the existing single admin email (variables.tf:67)
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.admin_email]
  }
}
