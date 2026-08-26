data "aws_route53_zone" "main" {
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "cf" {
  count                     = var.existing_acm_certificate_arn == "" ? 1 : 0
  provider                  = aws.use1
  domain_name               = var.domain_name
  subject_alternative_names = var.extra_domain_aliases
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cf_validation" {
  for_each = var.existing_acm_certificate_arn != "" ? {} : {
    for dvo in aws_acm_certificate.cf[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
  zone_id         = data.aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "cf" {
  count                   = var.create_edge && var.existing_acm_certificate_arn == "" ? 1 : 0
  provider                = aws.use1
  certificate_arn         = aws_acm_certificate.cf[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cf_validation : r.fqdn]
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

# Topology (per owner instruction): CloudFront → internet-facing ALB whose SG
# admits only CloudFront's origin-facing managed prefix list → ECS Fargate.
# No VPC Origin: the ALB is a standard custom origin reached over HTTP:80 at its
# public DNS name (viewer↔CloudFront stays HTTPS; the CF→ALB hop rides the AWS
# network, gated by the prefix-list SG + the X-Origin-Verify secret header), so
# there is no chicken-and-egg with the managed CloudFront-VPCOrigins-Service-SG.
resource "aws_cloudfront_distribution" "main" {
  count       = var.create_edge ? 1 : 0
  enabled     = true
  comment     = "AWSops v2 spine — ${var.domain_name}"
  aliases     = concat([var.domain_name], var.extra_domain_aliases)
  price_class = "PriceClass_200"

  origin {
    domain_name = aws_lb.spine.dns_name
    origin_id   = "alb-origin"
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }
    # Shared secret so the ALB can reject any request that did not come through
    # this distribution (defense-in-depth on top of the prefix-list SG).
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb-origin"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id

    lambda_function_association {
      event_type   = "viewer-request"
      lambda_arn   = aws_lambda_function.edge.qualified_arn
      include_body = false
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = "alb-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id

    lambda_function_association {
      event_type   = "viewer-request"
      lambda_arn   = aws_lambda_function.edge.qualified_arn
      include_body = false
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = var.existing_acm_certificate_arn != "" ? var.existing_acm_certificate_arn : aws_acm_certificate_validation.cf[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "alias" {
  for_each = var.create_edge ? toset(concat([var.domain_name], var.extra_domain_aliases)) : toset([])
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = each.value
  type     = "A"
  alias {
    name                   = aws_cloudfront_distribution.main[0].domain_name
    zone_id                = aws_cloudfront_distribution.main[0].hosted_zone_id
    evaluate_target_health = false
  }
}

# NOTE: the fork carried a `moved {}` block here reshaping a singleton
# aws_route53_record.alias into the for_each key "awsops-v2.atomai.click".
# That was a one-time state remap for the fork's own environment and is a
# no-op (worse: a confusing dangling key) on a fresh upstream apply where
# the records are created directly from for_each. Removed for upstream.
