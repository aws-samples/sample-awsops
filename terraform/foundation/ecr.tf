resource "aws_ecr_repository" "web" {
  name                 = "${var.project}-web"
  image_tag_mutability = var.ci_deployment_enabled ? "IMMUTABLE_WITH_EXCLUSION" : "MUTABLE"
  dynamic "image_tag_mutability_exclusion_filter" {
    for_each = var.ci_deployment_enabled ? [1] : []
    content {
      filter      = "web-latest"
      filter_type = "WILDCARD"
    }
  }
  image_scanning_configuration {
    scan_on_push = true
  }
  force_delete = true
}

# Prod-public image distribution (OSS). ECR Public is us-east-1 only.
resource "aws_ecrpublic_repository" "web" {
  provider        = aws.use1
  repository_name = "${var.project}-web"
  catalog_data {
    about_text    = "AWSops v2 web tier (Next.js thin-BFF on Fargate)."
    architectures = ["ARM 64"]
    description   = "AWSops v2 dashboard web image."
  }
}
