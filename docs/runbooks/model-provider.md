# Choosing the model provider

`model_provider` (Terraform, `terraform/foundation/models.tf`) selects the model family that every
model-calling role uses: the AgentCore chat runtime, web query generation, synthesis, routing,
the product-help assistant and the AI Diagnosis / insight / FinOps workers.

| `model_provider` | Chat | Fast roles (routing, assistant, insight) | Standard roles (query generation, synthesis, code generation, diagnosis) | Deep diagnosis | Query fallback |
|---|---|---|---|---|---|
| `mixed` (default) | `global.openai.gpt-6-luna` | `global.anthropic.claude-haiku-5-5` | Terra for query generation, Sonnet 5.5 elsewhere | `global.anthropic.claude-opus-5-5` | Sonnet 5.5 |
| `bedrock_claude` | `global.anthropic.claude-sonnet-5-5` | `global.anthropic.claude-haiku-5-5` | `global.anthropic.claude-sonnet-5-5` | `global.anthropic.claude-opus-5-5` | none |
| `bedrock_openai` | `global.openai.gpt-6-luna` | `global.openai.gpt-6-luna` | `global.openai.gpt-6.1-terra` | `global.openai.gpt-6.1-terra` | none |
| `anthropic_api` | `claude-sonnet-5-5` | `claude-haiku-5-5` | `claude-sonnet-5-5` | `claude-opus-5-5` | none |

`mixed` sets no role environment and keeps the existing grants, so the default plan is unchanged.
The other values pass `MODEL_PROVIDER` plus one model ID per role to the web task, the worker
Lambda and Fargate task, and (through the `agentcore` output and `make agentcore`) the AgentCore
runtime. Bedrock `InvokeModel*` grants shrink to the chosen family; `anthropic_api` has none.

## Prerequisites

- `bedrock_claude` / `bedrock_openai`: model access for the listed models and their `global.*`
  inference profiles in the deployment account.
- `anthropic_api`: an Anthropic API key stored in Secrets Manager, encrypted with the AWS managed
  `aws/secretsmanager` key, as a plain string or JSON `{"api_key": "..."}`. Calls leave through the
  existing private-subnet NAT egress to `api.anthropic.com:443`; no ingress or security-group change
  is made. Usage is billed by Anthropic and does not appear in the Bedrock invocation logs that the
  AI usage pages read.
- `anthropic_api` sends the same prompt content the Bedrock path sends (chat context, inventory
  rows, security-group rules and account identifiers redacted only where the Bedrock path already
  redacts them) to Anthropic as a third-party processor. Confirm that is acceptable for the
  account's data before enabling it.

## Enable

1. Create the secret (anthropic_api only) without putting the key in shell history or tfvars:

   ```bash
   aws secretsmanager create-secret --name <project>/anthropic-api-key \
     --secret-string file://<path-to-a-file-containing-the-key>
   ```

2. Set `model_provider` (and `anthropic_api_key_secret_arn` for `anthropic_api`) in the stack's
   tfvars. Terraform rejects `anthropic_api` without the secret ARN.
3. Produce a saved plan, review the env and IAM diff, then apply that plan. Never use
   `-auto-approve` on shared infrastructure.
4. Run `make agentcore` (or the Deploy AgentCore workflow) so the runtime receives the new
   environment, and redeploy the worker image if it predates this change.
5. Verify with the deployment readiness probe (it calls the configured chat model) and one chat,
   one Explore query generation and one AI Diagnosis run.

## Key rotation

Rotate by writing a new value to the same secret (`aws secretsmanager put-secret-value
--secret-id <arn> --secret-string file://<path>`). The web task and the worker Lambda/Fargate
calls drop their cached key and read the secret again on the first `401` from the API, then retry
once, so no redeploy is needed. The AgentCore chat runtime reads the key once per cold start; run
`make agentcore` (or wait for the next runtime restart) after rotating. Revoke the old key in the
Anthropic console only after the new one is in the secret.

## Rollback

Set `model_provider = "mixed"`, apply a reviewed saved plan and run `make agentcore`. The secret
is not deleted by Terraform; remove it separately when no stack references it.
