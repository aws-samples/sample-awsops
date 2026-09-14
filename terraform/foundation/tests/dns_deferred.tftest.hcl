# Offline plans only: every provider, including us-east-1 and archive, is mocked.
# State -> preflight -> typed inputs roundtrips are exercised in the Python CI tests.
# From the repository root, with Terraform 1.15.7 and cached providers:
#   bash scripts/v2/terraform-test.sh
# Copies tracked files; init -backend=false; validate; terraform test (no real backend).
mock_provider "aws" {
  override_during = plan

  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_vpc" {
    defaults = { cidr_block = "10.20.0.0/16" }
  }

  mock_data "aws_security_groups" {
    defaults = { ids = ["sg-0123456789abcdef0"] }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:ap-northeast-2:123456789012:certificate/11111111-1111-1111-1111-111111111111"
      domain_validation_options = [{
        domain_name           = "dev.example.com"
        resource_record_name  = "_primary.dev.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_primary.acm-validations.aws."
      }]
    }
  }

  mock_resource "aws_rds_cluster" {
    defaults = {
      master_user_secret = [{
        kms_key_id    = "mock-key"
        secret_arn    = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:mock"
        secret_status = "active"
      }]
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      domain_name    = "d111111abcdef8.cloudfront.net"
      hosted_zone_id = "Z2FDTNDATAQYW2"
    }
  }
}

mock_provider "aws" {
  alias           = "use1"
  override_during = plan

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/22222222-2222-2222-2222-222222222222"
      domain_validation_options = [{
        domain_name           = "dev.example.com"
        resource_record_name  = "_primary.dev.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_primary.acm-validations.aws."
        }, {
        domain_name           = "extra.example.com"
        resource_record_name  = "_extra.extra.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_extra.acm-validations.aws."
      }]
    }
  }
}

mock_provider "archive" {}
mock_provider "random" {}

override_resource {
  target          = aws_route53_record.cf_validation["dev.example.com"]
  override_during = plan
  values          = { fqdn = "_primary.dev.example.com." }
}

override_resource {
  target          = aws_route53_record.cf_validation["extra.example.com"]
  override_during = plan
  values          = { fqdn = "_extra.extra.example.com." }
}

variables {
  domain_name                 = "dev.example.com"
  hosted_zone_name            = "example.com"
  extra_domain_aliases        = ["extra.example.com"]
  create_network              = false
  existing_vpc_id             = "vpc-0123456789abcdef0"
  existing_private_subnet_ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
}

run "deferred_service_dns_keeps_tls_and_validation" {
  command = plan

  variables {
    publish_service_dns = false
  }

  assert {
    condition     = !var.ci_readiness_enabled && output.agentcore == null
    error_message = "Readiness defaults off and disabled AgentCore has no provisioning output."
  }

  assert {
    condition     = length(aws_route53_record.alias) == 0
    error_message = "Deferred service DNS must plan no public service A records."
  }

  assert {
    condition     = length(aws_route53_record.cf_validation) == 2
    error_message = "Deferring service DNS must not disable managed certificate CNAME validation."
  }

  assert {
    condition     = aws_cloudfront_distribution.main.aliases == toset(["dev.example.com", "extra.example.com"])
    error_message = "Deferring service DNS must retain the requested CloudFront aliases."
  }

  assert {
    condition     = aws_lb.internal.internal && aws_lb_listener.https.port == 443 && aws_lb_listener.https.protocol == "HTTPS" && one(aws_cloudfront_vpc_origin.alb.vpc_origin_endpoint_config).origin_protocol_policy == "https-only" && one(aws_cloudfront_vpc_origin.alb.vpc_origin_endpoint_config).https_port == 443
    error_message = "Deferred DNS must retain the internal ALB and HTTPS-only VPC origin on port 443."
  }

  assert {
    condition     = length(aws_acm_certificate.cf) == 1 && length(aws_acm_certificate.alb) == 1 && length(aws_acm_certificate_validation.cf) == 1 && length(aws_acm_certificate_validation.alb) == 1
    error_message = "Deferring service DNS alone must retain both managed certificates and validation waiters."
  }

  assert {
    condition     = aws_acm_certificate_validation.cf[0].validation_record_fqdns == toset(["_primary.dev.example.com.", "_extra.extra.example.com."]) && aws_acm_certificate_validation.alb[0].validation_record_fqdns == toset(["_primary.dev.example.com.", "_extra.extra.example.com."])
    error_message = "Both managed certificates must share the existing validation record owner."
  }
}

run "readiness_flag_reaches_provisioning" {
  command = plan
  variables {
    agentcore_enabled    = true
    ci_readiness_enabled = true
  }
  override_resource {
    target          = aws_ecr_repository.agentcore[0]
    override_during = plan
    values          = { repository_url = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/fixture-agent" }
  }
  assert {
    condition     = output.agentcore.deployment_readiness_enabled == true
    error_message = "The applied readiness flag must reach the provisioner without an environment override."
  }
}

run "default_still_publishes_aliases_and_manages_certificates" {
  command = plan

  assert {
    condition     = toset(keys(aws_route53_record.alias)) == toset(["dev.example.com", "extra.example.com"]) && length(aws_route53_record.cf_validation) == 2
    error_message = "Defaults must retain both service A aliases and managed validation CNAMEs."
  }

  assert {
    condition     = alltrue([for r in aws_route53_record.alias : r.type == "A" && one(r.alias).name == "d111111abcdef8.cloudfront.net" && one(r.alias).zone_id == "Z2FDTNDATAQYW2"])
    error_message = "All service DNS aliases must point to CloudFront, never directly to the ALB."
  }

  assert {
    condition     = length(aws_acm_certificate.cf) == 1 && length(aws_acm_certificate.alb) == 1 && aws_acm_certificate.cf[0].domain_name == "dev.example.com" && aws_acm_certificate.cf[0].subject_alternative_names == toset(["extra.example.com"]) && aws_acm_certificate.alb[0].domain_name == "dev.example.com"
    error_message = "Defaults must preserve managed certificate domains and CloudFront SANs."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.main.viewer_certificate).acm_certificate_arn == "arn:aws:acm:us-east-1:123456789012:certificate/22222222-2222-2222-2222-222222222222" && aws_lb_listener.https.certificate_arn == "arn:aws:acm:ap-northeast-2:123456789012:certificate/11111111-1111-1111-1111-111111111111"
    error_message = "Defaults must wire the appropriate regional managed certificates into CloudFront and the ALB."
  }
}

run "existing_certificates_allow_zero_dns_writes" {
  command = plan

  variables {
    publish_service_dns          = false
    existing_cf_certificate_arn  = "arn:aws:acm:us-east-1:123456789012:certificate/33333333-3333-3333-3333-333333333333"
    existing_alb_certificate_arn = "arn:aws:acm:ap-northeast-2:123456789012:certificate/44444444-4444-4444-4444-444444444444"
  }

  assert {
    condition     = length(aws_route53_record.alias) == 0 && length(aws_route53_record.cf_validation) == 0
    error_message = "A new stack reusing both certificates with service DNS deferred must plan no Route53 record writes."
  }

  assert {
    condition     = length(aws_acm_certificate.cf) == 0 && length(aws_acm_certificate.alb) == 0 && length(aws_acm_certificate_validation.cf) == 0 && length(aws_acm_certificate_validation.alb) == 0
    error_message = "Reusing both certificates must skip managed certificate requests and validation waiters."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.main.viewer_certificate).acm_certificate_arn == "arn:aws:acm:us-east-1:123456789012:certificate/33333333-3333-3333-3333-333333333333" && aws_lb_listener.https.certificate_arn == "arn:aws:acm:ap-northeast-2:123456789012:certificate/44444444-4444-4444-4444-444444444444"
    error_message = "Reused certificates must reach their intended TLS consumers."
  }

  assert {
    condition     = output.public_url == "https://dev.example.com" && output.cloudfront_domain == "d111111abcdef8.cloudfront.net" && one(aws_cloudfront_distribution.main.origin).domain_name == "dev.example.com" && aws_cloudfront_distribution.main.aliases == toset(["dev.example.com", "extra.example.com"])
    error_message = "DNS-deferred smoke-test outputs must retain the original service URL, origin SNI domain, and CloudFront aliases."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.main.viewer_certificate).minimum_protocol_version == "TLSv1.2_2021" && one(aws_cloudfront_distribution.main.default_cache_behavior).viewer_protocol_policy == "redirect-to-https" && length(one(aws_cloudfront_distribution.main.default_cache_behavior).lambda_function_association) == 1
    error_message = "Reusing certificates must retain viewer HTTPS and Lambda@Edge authentication."
  }

  assert {
    condition     = aws_lb.internal.internal && aws_lb_listener.https.port == 443 && aws_lb_listener.https.protocol == "HTTPS" && one(aws_cloudfront_vpc_origin.alb.vpc_origin_endpoint_config).origin_protocol_policy == "https-only" && one(aws_cloudfront_vpc_origin.alb.vpc_origin_endpoint_config).https_port == 443
    error_message = "Reusing certificates must retain the private HTTPS-only origin path."
  }
}

run "existing_cf_with_managed_alb_uses_alb_validation_tokens" {
  command = plan

  variables {
    publish_service_dns         = false
    existing_cf_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/33333333-3333-3333-3333-333333333333"
  }

  assert {
    condition     = length(aws_acm_certificate.cf) == 0 && length(aws_acm_certificate_validation.cf) == 0 && length(aws_acm_certificate.alb) == 1 && length(aws_acm_certificate_validation.alb) == 1
    error_message = "Reusing only CloudFront's certificate must retain ALB certificate management."
  }

  assert {
    condition     = toset(keys(aws_route53_record.cf_validation)) == toset(["dev.example.com"]) && aws_route53_record.cf_validation["dev.example.com"].name == "_primary.dev.example.com." && aws_route53_record.cf_validation["dev.example.com"].type == "CNAME" && aws_route53_record.cf_validation["dev.example.com"].records == toset(["_primary.acm-validations.aws."])
    error_message = "The existing validation record address must use the ALB token, without requesting CloudFront SAN validation."
  }

  assert {
    condition     = aws_acm_certificate_validation.alb[0].validation_record_fqdns == toset(["_primary.dev.example.com."]) && length(aws_route53_record.alias) == 0
    error_message = "ALB validation must wait on its CNAME even while service DNS is deferred."
  }
}

run "managed_cf_with_existing_alb_keeps_cf_validation" {
  command = plan

  variables {
    publish_service_dns          = false
    existing_alb_certificate_arn = "arn:aws:acm:ap-northeast-2:123456789012:certificate/44444444-4444-4444-4444-444444444444"
  }

  assert {
    condition     = length(aws_acm_certificate.cf) == 1 && length(aws_acm_certificate_validation.cf) == 1 && length(aws_acm_certificate.alb) == 0 && length(aws_acm_certificate_validation.alb) == 0
    error_message = "Reusing only ALB's certificate must retain CloudFront certificate management."
  }

  assert {
    condition     = toset(keys(aws_route53_record.cf_validation)) == toset(["dev.example.com", "extra.example.com"]) && aws_acm_certificate_validation.cf[0].validation_record_fqdns == toset(["_primary.dev.example.com.", "_extra.extra.example.com."]) && length(aws_route53_record.alias) == 0
    error_message = "CloudFront must still validate its primary domain and SANs with no service A aliases."
  }
}

run "existing_certificates_can_publish_dns_in_another_alb_region" {
  command = plan

  variables {
    region                       = "eu-west-1"
    existing_cf_certificate_arn  = "arn:aws:acm:us-east-1:123456789012:certificate/33333333-3333-3333-3333-333333333333"
    existing_alb_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/44444444-4444-4444-4444-444444444444"
  }

  assert {
    condition     = length(aws_route53_record.alias) == 2 && length(aws_route53_record.cf_validation) == 0 && aws_lb_listener.https.certificate_arn == "arn:aws:acm:eu-west-1:123456789012:certificate/44444444-4444-4444-4444-444444444444"
    error_message = "Certificate reuse must permit normal service DNS publication and honor the configured ALB region."
  }
}

run "reject_wrong_certificate_regions" {
  command = plan

  variables {
    existing_cf_certificate_arn  = "arn:aws:acm:ap-northeast-2:123456789012:certificate/33333333-3333-3333-3333-333333333333"
    existing_alb_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/44444444-4444-4444-4444-444444444444"
  }

  expect_failures = [var.existing_cf_certificate_arn, var.existing_alb_certificate_arn]
}

run "reject_wrong_certificate_accounts" {
  command = plan

  variables {
    existing_cf_certificate_arn  = "arn:aws:acm:us-east-1:999999999999:certificate/33333333-3333-3333-3333-333333333333"
    existing_alb_certificate_arn = "arn:aws:acm:ap-northeast-2:999999999999:certificate/44444444-4444-4444-4444-444444444444"
  }

  expect_failures = [var.existing_cf_certificate_arn, var.existing_alb_certificate_arn]
}

run "reject_wrong_certificate_resource_types" {
  command = plan

  variables {
    existing_cf_certificate_arn  = "arn:aws:iam::123456789012:server-certificate/example"
    existing_alb_certificate_arn = "arn:aws:acm-pca:ap-northeast-2:123456789012:certificate-authority/44444444-4444-4444-4444-444444444444"
  }

  expect_failures = [var.existing_cf_certificate_arn, var.existing_alb_certificate_arn]
}

run "reject_malformed_certificate_ids" {
  command = plan

  variables {
    existing_cf_certificate_arn  = "arn:aws:acm:us-east-1:123456789012:certificate/not-a-certificate-id"
    existing_alb_certificate_arn = "arn:aws:acm:ap-northeast-2:123456789012:certificate/44444444-4444-4444-4444-444444444444/extra"
  }

  expect_failures = [var.existing_cf_certificate_arn, var.existing_alb_certificate_arn]
}

run "reject_empty_certificate_arns" {
  command = plan

  variables {
    existing_cf_certificate_arn  = ""
    existing_alb_certificate_arn = ""
  }

  expect_failures = [var.existing_cf_certificate_arn, var.existing_alb_certificate_arn]
}

run "steampipe_dns_is_still_dns_even_with_external_certificates" {
  command = plan

  variables {
    steampipe_enabled            = true
    publish_service_dns          = false
    existing_cf_certificate_arn  = "arn:aws:acm:us-east-1:123456789012:certificate/33333333-3333-3333-3333-333333333333"
    existing_alb_certificate_arn = "arn:aws:acm:ap-northeast-2:123456789012:certificate/44444444-4444-4444-4444-444444444444"
  }

  assert {
    condition     = length(aws_service_discovery_private_dns_namespace.main) == 1 && length(aws_service_discovery_service.steampipe) == 1
    error_message = "First-time Steampipe requires Cloud Map DNS writes; the CI all-DNS gate must reject this plan."
  }
}
