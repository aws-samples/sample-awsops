# Application capability only. No IAM role or administrator membership.
resource "aws_cognito_user_group" "deployment_verifiers" {
  count        = var.ci_readiness_enabled && var.agentcore_enabled ? 1 : 0
  name         = "deployment-verifiers"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "May invoke the bounded deployment readiness probe"
}

resource "aws_cognito_user_in_group" "demo_readiness" {
  count        = var.ci_readiness_enabled && var.agentcore_enabled && var.create_demo_user ? 1 : 0
  user_pool_id = aws_cognito_user_pool.main.id
  group_name   = aws_cognito_user_group.deployment_verifiers[0].name
  username     = aws_cognito_user.demo[0].username
}
