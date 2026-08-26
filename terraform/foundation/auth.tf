resource "aws_cognito_user_pool" "main" {
  name                     = "${var.project}-pool"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]
  mfa_configuration        = "OFF"

  password_policy {
    minimum_length    = 8
    require_uppercase = true
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_user_pool_client" "main" {
  name                                 = "${var.project}-client"
  user_pool_id                         = aws_cognito_user_pool.main.id
  generate_secret                      = false # public client + PKCE (no secret in edge code)
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  callback_urls                        = [for d in concat([var.domain_name], var.extra_domain_aliases) : "https://${d}/_callback"]
  logout_urls                          = [for d in concat([var.domain_name], var.extra_domain_aliases) : "https://${d}/"]

  # USER_PASSWORD_AUTH powers the self-hosted /login form's BFF InitiateAuth call; the Hosted UI
  # authorization-code (PKCE) flow above coexists as the edge dark fallback. No ALLOW_REFRESH_TOKEN_AUTH:
  # the refresh flow is not implemented (least privilege — the BFF discards the RefreshToken immediately).
  # Token lifetimes are declared explicitly to match the live deployment (id/access = 12h).
  explicit_auth_flows   = ["ALLOW_USER_PASSWORD_AUTH"]
  id_token_validity     = 12
  access_token_validity = 12
  token_validity_units {
    id_token     = "hours"
    access_token = "hours"
  }
}

resource "aws_cognito_user" "admin" {
  user_pool_id = aws_cognito_user_pool.main.id
  username     = var.admin_email
  password     = var.admin_password
  attributes = {
    email          = var.admin_email
    email_verified = true
  }
}

data "aws_iam_policy_document" "edge_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com", "edgelambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "edge" {
  name               = "${var.project}-edge-auth"
  assume_role_policy = data.aws_iam_policy_document.edge_assume.json
}

resource "aws_iam_role_policy_attachment" "edge_basic" {
  role       = aws_iam_role.edge.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "random_password" "edge_state_key" {
  length  = 48
  special = false
}

locals {
  edge_src = templatefile("${path.module}/edge-lambda/cognito_edge.py.tftpl", {
    client_id      = aws_cognito_user_pool_client.main.id
    cognito_domain = "${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
    region         = var.region
    user_pool_id   = aws_cognito_user_pool.main.id
    state_key      = random_password.edge_state_key.result
  })
}

data "archive_file" "edge" {
  type        = "zip"
  output_path = "${path.module}/.build/cognito_edge.zip"
  source {
    content  = local.edge_src
    filename = "cognito_edge.py"
  }
}

resource "aws_lambda_function" "edge" {
  provider         = aws.use1
  function_name    = "${var.project}-cognito-auth"
  runtime          = "python3.12"
  handler          = "cognito_edge.lambda_handler"
  role             = aws_iam_role.edge.arn
  filename         = data.archive_file.edge.output_path
  source_code_hash = data.archive_file.edge.output_base64sha256
  timeout          = 5
  memory_size      = 128
  publish          = true
}
