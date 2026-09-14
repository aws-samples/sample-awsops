mock_provider "aws" {}

run "default_preserves_existing_lifecycle_ownership" {
  command = plan
  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.private_plans) == 0
    error_message = "Plan retention must not take lifecycle ownership by default."
  }
}

run "enabled_retention_excludes_state_and_expires_versions" {
  command = plan
  variables {
    private_plan_retention_enabled = true
  }
  assert {
    condition = alltrue([
      for rule in aws_s3_bucket_lifecycle_configuration.private_plans[0].rule :
      rule.filter[0].prefix == "ci/tfplans/" && rule.status == "Enabled"
    ])
    error_message = "Every managed lifecycle rule must be limited to private plans."
  }
  assert {
    condition = anytrue([
      for rule in aws_s3_bucket_lifecycle_configuration.private_plans[0].rule :
      try(rule.expiration[0].days == 7, false) &&
      try(rule.noncurrent_version_expiration[0].noncurrent_days == 7, false) &&
      try(rule.abort_incomplete_multipart_upload[0].days_after_initiation == 1, false)
    ])
    error_message = "Current, noncurrent and incomplete-upload retention must be bounded."
  }
}
