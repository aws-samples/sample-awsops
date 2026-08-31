resource "aws_ecr_repository" "web" {
  name                 = "${var.project}-web"
  image_tag_mutability = "MUTABLE"
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
