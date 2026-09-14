variable "region" {
  type    = string
  default = "ap-northeast-2"
}

variable "project" {
  type    = string
  default = "awsops-v2"
}

variable "state_bucket_name" {
  type        = string
  description = "Globally-unique S3 bucket for Terraform state. Override per account."
  default     = "awsops-v2-tfstate"
}

variable "private_plan_retention_enabled" {
  type        = bool
  default     = false
  description = "Manage plan-prefix lifecycle on this bucket. Enable only after reviewing ownership of the entire bucket lifecycle configuration and preserving any unrelated rules."
}
