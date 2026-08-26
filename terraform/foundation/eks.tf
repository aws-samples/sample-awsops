variable "onboard_eks_clusters" {
  type        = list(string)
  description = "Host-account EKS cluster names to grant the web task role read access (Access Entry). Written by `make configure`."
  default     = []
}

# Look up each onboarded cluster (validates existence + exposes endpoint/CA for P3 kubeconfig).
data "aws_eks_cluster" "onboard" {
  for_each = toset(var.onboard_eks_clusters)
  name     = each.value
}

# Access Entry: register the web task role as a STANDARD principal on each cluster.
resource "aws_eks_access_entry" "web" {
  for_each      = toset(var.onboard_eks_clusters)
  cluster_name  = each.value
  principal_arn = aws_iam_role.task.arn
  type          = "STANDARD"
}

# Bind the AWS-managed read-only AdminView policy at cluster scope.
# AdminView (not View): AmazonEKSViewPolicy mirrors the k8s 'view' ClusterRole and has NO
# cluster-scoped resources — listing nodes 403s. AdminViewPolicy is */*/get,list,watch.
# It can read Secrets, but the BFF only proxies an allow-listed set of kinds
# (nodes/pods/deployments/services/namespaces/events/endpoints + explorer kinds replicasets/
# daemonsets/statefulsets/jobs/pvcs/configmaps[METADATA-ONLY] in eks-incluster.ts isKind/KIND_PATH)
# — secrets/configmaps never transit, and eks-incluster.test.ts pins their rejection.
# ⚠️ This allow-list is the single line of defense behind AdminView: ANY new kind added
# to eks-incluster.ts MUST update this comment + the negative-kind test in the same PR.
resource "aws_eks_access_policy_association" "web_view" {
  for_each      = toset(var.onboard_eks_clusters)
  cluster_name  = each.value
  principal_arn = aws_iam_role.task.arn
  # Keep in sync with scripts/v2/eks/auto_register.py _READONLY_POLICY_SUFFIXES (PR #36 r5).
  policy_arn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy"
  access_scope {
    type = "cluster"
  }
  depends_on = [aws_eks_access_entry.web]
}

# ── istio-read MCP (2026-06-18): the agent Lambda exec role needs an EKS Access Entry to read Istio
#    CRDs via the k8s API. We DELIBERATELY do NOT create it in terraform — granting a principal k8s
#    access is the CLUSTER OWNER's call, and the apply principal may lack eks:CreateAccessEntry on
#    third-party clusters. Instead the operator (who holds cluster perms) runs
#    scripts/v2/eks/register-istio-access.sh (docs/runbooks/istio-agent-eks-access.md), which
#    registers `output.agent_lambda_role_arn` with **AmazonEKSViewPolicy** (View, NOT AdminView —
#    least privilege: no cluster-wide Secret/node read for the AI-agent principal; istio-read only
#    LISTs namespaced CRDs + namespaces). Mirrors the v2 stance: AWSops never mutates a cluster; the
#    operator grants access out-of-band. The web task-role entry above stays terraform-managed and
#    uses AdminView because it lists cluster-scoped nodes — that rationale does NOT apply here.

# IAM the web task role needs to discover clusters + build a kubeconfig (P3 consumes this).
# ALWAYS created (was gated on onboard_eks_clusters): Aurora-stored cluster auth
# (eks_registrations.auth — sa-token/assume-role) lets clusters connect without terraform
# onboarding, but /eks discovery (ListClusters/DescribeCluster) must work regardless.
resource "aws_iam_role_policy" "task_eks" {
  name = "${var.project}-task-eks-read"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["eks:DescribeCluster", "eks:ListClusters", "eks:DescribeAccessEntry"]
      Resource = "*"
    }]
  })
}

output "onboarded_eks_clusters" {
  description = "Onboarded EKS clusters -> endpoint/ARN (for P3 dashboard kubeconfig registration)."
  value = {
    for k, c in data.aws_eks_cluster.onboard : k => {
      endpoint                   = c.endpoint
      arn                        = c.arn
      certificate_authority_data = c.certificate_authority[0].data
    }
  }
}

# ── EKS auto-register (EventBridge → Lambda → eks_registrations) ─────────────
# v1 "Register kubeconfig"의 완전 자동화: 운영자가 CLI로 access entry + AdminViewPolicy를
# 연계하면 CloudTrail 이벤트를 EventBridge가 잡아 Aurora 등록 리스트에 기록한다 (버튼 불요).
# AWS 리소스를 변경하지 않는 관찰-전용 자동화 (ADR-029 reversal과 무충돌).
# Requires workers_enabled=true (pg8000 layer + VPC plumbing 재사용).

locals {
  ear = var.eks_auto_register_enabled && var.workers_enabled ? 1 : 0
}

data "archive_file" "eks_auto_register" {
  count       = local.ear
  type        = "zip"
  output_path = "${path.module}/.build/eks_auto_register.zip"
  source {
    content  = file("${path.root}/../../../scripts/v2/eks/auto_register.py")
    filename = "auto_register.py"
  }
  source {
    # Regional RDS CA trust bundle — the Lambda REQUIRES verified TLS to Aurora
    # (PR #36 review: this write-path must not run CERT_NONE).
    content  = file("${path.root}/../../../scripts/v2/eks/rds-ca-bundle.pem")
    filename = "rds-ca-bundle.pem"
  }
}

resource "aws_iam_role" "eks_auto_register" {
  count = local.ear
  name  = "${var.project}-eks-auto-register"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_auto_register_vpc" {
  count      = local.ear
  role       = aws_iam_role.eks_auto_register[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "eks_auto_register_secret" {
  count = local.ear
  name  = "${var.project}-eks-auto-register-secret"
  role  = aws_iam_role.eks_auto_register[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      },
      {
        # the RDS-managed secret is CMK-encrypted — decrypt is required to read it (workers.tf pattern)
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.aurora.arn
      }
    ]
  })
}

resource "aws_lambda_function" "eks_auto_register" {
  count            = local.ear
  function_name    = "${var.project}-eks-auto-register"
  role             = aws_iam_role.eks_auto_register[0].arn
  runtime          = "python3.12"
  handler          = "auto_register.handler"
  filename         = data.archive_file.eks_auto_register[0].output_path
  source_code_hash = data.archive_file.eks_auto_register[0].output_base64sha256
  timeout          = 30
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
      AURORA_SECRET_ARN = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      TASK_ROLE_NAME    = aws_iam_role.task.name
    }
  }
}

# CloudTrail 경유 EKS 관리 이벤트 — 우리 task role 대상의 정책 연계/엔트리 삭제만 Lambda에서 필터.
resource "aws_cloudwatch_event_rule" "eks_access_change" {
  count       = local.ear
  name        = "${var.project}-eks-access-change"
  description = "EKS AssociateAccessPolicy/DeleteAccessEntry via CloudTrail -> auto (un)register for in-app queries"
  event_pattern = jsonencode({
    source        = ["aws.eks"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["eks.amazonaws.com"]
      eventName   = ["AssociateAccessPolicy", "DeleteAccessEntry"]
    }
  })
}

resource "aws_cloudwatch_event_target" "eks_access_change" {
  count = local.ear
  rule  = aws_cloudwatch_event_rule.eks_access_change[0].name
  arn   = aws_lambda_function.eks_auto_register[0].arn
}

resource "aws_lambda_permission" "eks_auto_register_events" {
  count         = local.ear
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.eks_auto_register[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.eks_access_change[0].arn
}
