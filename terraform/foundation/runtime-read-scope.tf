# Runtime activation is opt-in. Host inventory retains its all-enabled-region
# scan; global IAM/CloudFront/Route53 endpoints also require us-east-1.
variable "ci_runtime_rollout" {
  type        = bool
  default     = false
  description = "Saved-plan intent for dev core-runtime activation/private discovery; not a permission bypass."
}

variable "inventory_host_only" {
  type        = bool
  default     = false
  description = "Restrict the inventory collector to its verified host account; omit cross-account AssumeRole."
}

variable "steampipe_image_digest" {
  type        = string
  default     = null
  nullable    = true
  description = "Verified immutable ARM64 inventory image digest; null preserves the legacy image tag."
  validation {
    condition     = var.steampipe_image_digest == null || can(regex("^sha256:[a-f0-9]{64}$", var.steampipe_image_digest))
    error_message = "steampipe_image_digest must be a sha256 digest."
  }
}

variable "worker_image_digest" {
  type        = string
  default     = null
  nullable    = true
  description = "Verified immutable ARM64 worker image digest; null preserves the legacy image tag."
  validation {
    condition     = var.worker_image_digest == null || can(regex("^sha256:[a-f0-9]{64}$", var.worker_image_digest))
    error_message = "worker_image_digest must be a sha256 digest."
  }
}

locals {
  core_runtime_enabled = var.steampipe_enabled || var.agentcore_enabled || var.workers_enabled
}

data "aws_regions" "runtime_read" {
  count       = local.core_runtime_enabled ? 1 : 0
  all_regions = false
}

locals {
  runtime_read_regions = local.core_runtime_enabled ? sort(distinct(concat(
    tolist(data.aws_regions.runtime_read[0].names), [var.region, "us-east-1"]
  ))) : [var.region, "us-east-1"]
  runtime_read_condition = {
    StringEquals = { "aws:RequestedRegion" = local.runtime_read_regions }
  }
  runtime_region_condition = {
    StringEquals = { "aws:RequestedRegion" = var.region }
  }
  runtime_model_resources = [
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
    "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*anthropic.claude-*",
    "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:application-inference-profile/*",
  ]
}

output "runtime_deployment" {
  description = "Nonsecret deployment identities and intended capabilities. Flags are not proof of runtime readiness."
  value = {
    schema_version = 1
    account_id     = data.aws_caller_identity.current.account_id
    region         = var.region
    project        = var.project
    features = {
      inventory = var.steampipe_enabled
      agentcore = var.agentcore_enabled
      workers   = var.workers_enabled
    }
    web = {
      cluster       = aws_ecs_cluster.main.name
      service       = aws_ecs_service.web.name
      task_role_arn = aws_iam_role.task.arn
    }
    inventory = {
      ecr_uri             = one(aws_ecr_repository.steampipe[*].repository_url)
      service             = one(aws_ecs_service.steampipe[*].name)
      task_definition_arn = one(aws_ecs_task_definition.steampipe[*].arn)
      task_role_arn       = one(aws_iam_role.steampipe_task[*].arn)
      sync_function_name  = one(aws_lambda_function.inv_sync[*].function_name)
      sync_function_arn   = one(aws_lambda_function.inv_sync[*].arn)
      sync_code_sha256    = one(aws_lambda_function.inv_sync[*].code_sha256)
    }
    agentcore = {
      ecr_uri              = one(aws_ecr_repository.agentcore[*].repository_url)
      role_arn             = one(aws_iam_role.agentcore[*].arn)
      runtime_arn_param    = one(aws_ssm_parameter.agentcore_runtime_arn[*].name)
      interpreter_id_param = one(aws_ssm_parameter.agentcore_interpreter_id[*].name)
      memory_id_param      = one(aws_ssm_parameter.agentcore_memory_id[*].name)
    }
    workers = {
      ecr_uri             = one(aws_ecr_repository.worker[*].repository_url)
      task_definition_arn = one(aws_ecs_task_definition.worker[*].arn)
      queue_url           = one(aws_sqs_queue.jobs[*].url)
      state_machine_arn   = one(aws_sfn_state_machine.workers[*].arn)
      dispatcher_esm_uuid = one(aws_lambda_event_source_mapping.dispatcher[*].uuid)
    }
    known = {
      cloudfront_distribution_id = aws_cloudfront_distribution.main.id
      vpc_id                     = local.vpc_id
    }
  }
}
