output "cloudfront_domain" {
  value = one(aws_cloudfront_distribution.main[*].domain_name)
}

output "distribution_id" {
  value = one(aws_cloudfront_distribution.main[*].id)
}

output "public_url" {
  value = "https://${var.domain_name}"
}

output "alb_arn" {
  value = aws_lb.spine.arn
}

output "ecr_uri" {
  value = aws_ecr_repository.web.repository_url
}

output "cognito_user_pool_id" { value = aws_cognito_user_pool.main.id }
output "cognito_client_id" { value = aws_cognito_user_pool_client.main.id }
output "cognito_hosted_ui" { value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com" }

output "aurora_endpoint" { value = aws_rds_cluster.aurora.endpoint }
output "aurora_database" { value = aws_rds_cluster.aurora.database_name }
output "aurora_secret_arn" { value = aws_rds_cluster.aurora.master_user_secret[0].secret_arn }

output "ecr_web_uri" { value = aws_ecr_repository.web.repository_url }
output "ecr_public_uri" { value = aws_ecrpublic_repository.web.repository_uri }

output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
output "ecs_service_name" { value = aws_ecs_service.web.name }

# Principal the operator registers on an EKS cluster (out-of-band CLI) so the istio-read MCP can read
# Istio CRDs via the k8s API. null when agentcore is off. See scripts/v2/eks/register-istio-access.sh.
output "agent_lambda_role_arn" {
  value = var.agentcore_enabled ? aws_iam_role.agent_lambda[0].arn : null
}

# Principal the operator registers on an EKS cluster (out-of-band) so the AI-Insights k8s_events
# collector can LIST core/v1 Events. null when workers are off. See register-insight-access.sh.
output "worker_lambda_role_arn" {
  value = var.workers_enabled ? aws_iam_role.worker_lambda[0].arn : null
}
