# Deploy-time model family (var.model_provider). Every model-calling role reads its model ID from
# env; this file is the single mapping. mixed keeps the code defaults (no env, no IAM change).
locals {
  model_profiles = {
    mixed = {
      chat     = "global.openai.gpt-6-luna", fast = "global.anthropic.claude-haiku-5-5",
      standard = "global.anthropic.claude-sonnet-5-5", deep = "global.anthropic.claude-opus-5-5",
      querygen = "global.openai.gpt-6.1-terra", querygen_fallback = "global.anthropic.claude-sonnet-5-5"
    }
    bedrock_claude = {
      chat     = "global.anthropic.claude-sonnet-5-5", fast = "global.anthropic.claude-haiku-5-5",
      standard = "global.anthropic.claude-sonnet-5-5", deep = "global.anthropic.claude-opus-5-5",
      querygen = "global.anthropic.claude-sonnet-5-5", querygen_fallback = ""
    }
    bedrock_openai = {
      chat     = "global.openai.gpt-6-luna", fast = "global.openai.gpt-6-luna",
      standard = "global.openai.gpt-6.1-terra", deep = "global.openai.gpt-6.1-terra",
      querygen = "global.openai.gpt-6.1-terra", querygen_fallback = ""
    }
    anthropic_api = {
      chat     = "claude-sonnet-5-5", fast = "claude-haiku-5-5",
      standard = "claude-sonnet-5-5", deep = "claude-opus-5-5",
      querygen = "claude-sonnet-5-5", querygen_fallback = ""
    }
  }
  models          = local.model_profiles[var.model_provider]
  model_custom    = var.model_provider != "mixed"
  model_on_api    = var.model_provider == "anthropic_api"
  model_api_count = local.model_on_api ? 1 : 0

  # Role env shared by the web task, workers and the AgentCore runtime. Empty for mixed, so
  # merge(base, {}) / concat(base, []) keeps every task definition and function unchanged.
  model_env = local.model_custom ? merge({
    MODEL_PROVIDER                        = var.model_provider
    AGENT_MODEL_ID                        = local.models.chat
    DATASOURCE_QUERYGEN_MODEL_ID          = local.models.querygen
    DATASOURCE_QUERYGEN_FALLBACK_MODEL_ID = local.models.querygen_fallback
    SYNTHESIS_MODEL_ID                    = local.models.standard
    CODEGEN_MODEL_ID                      = local.models.standard
    ASSISTANT_MODEL_ID                    = local.models.fast
    DIAGNOSIS_MODEL_SONNET                = local.models.standard
    DIAGNOSIS_MODEL_OPUS                  = local.models.deep
    DIAGNOSIS_TITLE_MODEL                 = local.models.standard
    GRAPH_QUERYGEN_MODEL_ID               = local.models.fast
    FINOPS_EXPLAIN_MODEL_ID               = local.models.fast
    INSIGHT_MODEL_ID                      = local.models.fast
    RCA_MODEL_ID                          = local.models.standard
  }, local.model_on_api ? { ANTHROPIC_API_KEY_SECRET_ARN = var.anthropic_api_key_secret_arn } : {}) : {}
  # The web task sets CLASSIFIER_MODEL_ID / K8SGPT_NARRATION_MODEL in their own gated blocks.
  model_env_list = [for k in sort(keys(local.model_env)) : { name = k, value = local.model_env[k] }]

  # Bedrock model IDs per grant scope for the custom Bedrock families (mixed keeps its literal lists).
  model_scope_ids = {
    bedrock_claude = {
      web      = ["anthropic.claude-sonnet-5-5", "anthropic.claude-haiku-5-5"]
      fast     = ["anthropic.claude-haiku-5-5"]
      standard = ["anthropic.claude-sonnet-5-5"]
      runtime  = ["anthropic.claude-sonnet-5-5", "anthropic.claude-haiku-5-5", "anthropic.claude-opus-5-5"]
    }
    bedrock_openai = {
      web      = ["openai.gpt-6.1-terra", "openai.gpt-6-luna"]
      fast     = ["openai.gpt-6-luna"]
      standard = ["openai.gpt-6.1-terra"]
      runtime  = ["openai.gpt-6-luna", "openai.gpt-6.1-terra"]
    }
  }
  # Bare and dated foundation-model IDs plus the global profile; regional profile ARNs for the web
  # task (as its existing grants), any-region profile ARNs for the runtime/worker roles.
  model_regional_arns = { for scope, ids in try(local.model_scope_ids[var.model_provider], {}) : scope => flatten([
    for id in ids : [
      "arn:aws:bedrock:*::foundation-model/${id}",
      "arn:aws:bedrock:*::foundation-model/${id}-*",
      "arn:aws:bedrock:${var.region}:${data.aws_caller_identity.current.account_id}:inference-profile/global.${id}",
      "arn:aws:bedrock:${var.region}:${data.aws_caller_identity.current.account_id}:inference-profile/global.${id}-*",
  ]]) }
  model_runtime_arns = flatten([for id in try(local.model_scope_ids[var.model_provider].runtime, []) : [
    "arn:aws:bedrock:*::foundation-model/${id}",
    "arn:aws:bedrock:*::foundation-model/${id}-*",
    "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/global.${id}",
    "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/global.${id}-*",
  ]])

  # Statement for roles that read the Anthropic API key (anthropic_api only).
  model_api_key_statements = local.model_on_api ? [{
    Sid      = "AnthropicApiKeyRead"
    Effect   = "Allow"
    Action   = ["secretsmanager:GetSecretValue"]
    Resource = [var.anthropic_api_key_secret_arn]
  }] : []
}

# anthropic_api: the web task role reads exactly the configured API key secret.
resource "aws_iam_role_policy" "task_model_api_key" {
  count  = local.model_api_count
  name   = "${var.project}-task-model-api-key"
  role   = aws_iam_role.task.id
  policy = jsonencode({ Version = "2012-10-17", Statement = local.model_api_key_statements })
}

resource "aws_iam_role_policy" "agentcore_model_api_key" {
  count  = local.model_api_count * local.ac_count
  name   = "${var.project}-agentcore-model-api-key"
  role   = aws_iam_role.agentcore[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = local.model_api_key_statements })
}

resource "aws_iam_role_policy" "worker_task_model_api_key" {
  count  = local.model_api_count * local.we
  name   = "${var.project}-worker-task-model-api-key"
  role   = aws_iam_role.worker_task[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = local.model_api_key_statements })
}

resource "aws_iam_role_policy" "worker_lambda_model_api_key" {
  count  = local.model_api_count * local.we
  name   = "${var.project}-worker-lambda-model-api-key"
  role   = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = local.model_api_key_statements })
}

# task_web_models gained a count (absent for anthropic_api); keep the existing policy in state.
moved {
  from = aws_iam_role_policy.task_web_models
  to   = aws_iam_role_policy.task_web_models[0]
}
