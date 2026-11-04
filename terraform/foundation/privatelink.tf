# Private connectivity from the connector Lambdas to observability datasources that run in
# ANOTHER AWS account, over AWS PrivateLink interface endpoints. Default-off: an empty
# `privatelink_endpoints` map creates nothing (plan = no changes, $0).
#
# The provider account exposes each datasource's internal NLB as a VPC endpoint service
# (docs/runbooks/privatelink-observability.md). This file only creates the CONSUMER side.
# No provider-side resource, route table or peering is involved. By default the connector uses the
# endpoint's regional DNS name (output below) as the datasource address; an optional private hosted
# zone (privatelink_zone_name) adds short stable names on top.

variable "privatelink_endpoints" {
  type = map(object({
    kind         = string
    service_name = string
    ports        = list(number)
  }))
  default     = {}
  nullable    = false
  description = "Interface endpoints to datasource endpoint services exposed by another account. Map key = a short label (lowercase letters, digits, hyphen). kind = clickhouse|prometheus|loki|tempo|mimir. service_name = the provider's endpoint service (com.amazonaws.vpce.<region>.vpce-svc-<id>). ports = the TCP ports the connector may use through the endpoint. Each kind needs its <kind>_vpc_enabled flag and integrations_enabled. Default {} → no-op."

  validation {
    condition     = alltrue([for k, _ in var.privatelink_endpoints : can(regex("^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$", k))])
    error_message = "privatelink_endpoints keys must be 1-31 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit."
  }
  validation {
    condition     = alltrue([for _, e in var.privatelink_endpoints : contains(["clickhouse", "prometheus", "loki", "tempo", "mimir"], e.kind)])
    error_message = "privatelink_endpoints kind must be one of clickhouse, prometheus, loki, tempo, mimir."
  }
  validation {
    condition     = alltrue([for _, e in var.privatelink_endpoints : can(regex("^com\\.amazonaws\\.vpce\\.${var.region}\\.vpce-svc-[0-9a-f]+$", e.service_name))])
    error_message = "privatelink_endpoints service_name must be an endpoint service name in this stack's region: com.amazonaws.vpce.<region>.vpce-svc-<hex id> (cross-region PrivateLink is not supported)."
  }
  validation {
    condition     = alltrue([for _, e in var.privatelink_endpoints : length(e.ports) > 0 && length(e.ports) <= 4 && length(distinct(e.ports)) == length(e.ports) && alltrue([for p in e.ports : p >= 1 && p <= 65535 && p == floor(p)])])
    error_message = "privatelink_endpoints ports must list 1-4 distinct integer TCP ports between 1 and 65535."
  }
  validation {
    condition = alltrue([for _, e in var.privatelink_endpoints : (
      e.kind == "clickhouse" ? var.clickhouse_vpc_enabled :
      e.kind == "prometheus" ? var.prometheus_vpc_enabled :
      e.kind == "loki" ? var.loki_vpc_enabled :
      e.kind == "tempo" ? var.tempo_vpc_enabled :
      e.kind == "mimir" ? var.mimir_vpc_enabled : true
    )])
    error_message = "Every kind in privatelink_endpoints needs its <kind>_vpc_enabled flag (the connector Lambda must be attached to the VPC)."
  }
  validation {
    condition     = length(var.privatelink_endpoints) == 0 || (var.agentcore_enabled && var.integrations_enabled)
    error_message = "privatelink_endpoints requires agentcore_enabled and integrations_enabled."
  }
}

variable "privatelink_zone_name" {
  type        = string
  default     = ""
  nullable    = false
  description = "Optional private DNS zone name (for example obs.awsops.internal) that gives each PrivateLink endpoint a short, stable name <key>.<zone>. Empty (default) → no zone; the endpoint's regional vpce DNS name is used directly. Only takes effect when privatelink_endpoints is non-empty. Lowercase, at least two labels, no trailing dot. Setting or clearing it plans Route 53 changes, which the CI DNS gate refuses unless both the plan and the apply dispatch pass allow_dns_changes=true on a full (non-domain-rollout) plan; read the saved plan and confirm only the PrivateLink zone and records change (see docs/runbooks/privatelink-observability.md)."

  validation {
    condition     = var.privatelink_zone_name == "" || (length(var.privatelink_zone_name) <= 253 && can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.privatelink_zone_name)))
    error_message = "privatelink_zone_name must be a lowercase DNS name with at least two labels and no trailing dot."
  }
  validation {
    condition = var.privatelink_zone_name == "" || (
      var.privatelink_zone_name != var.domain_name &&
      var.privatelink_zone_name != var.hosted_zone_name &&
      !endswith(var.domain_name, ".${var.privatelink_zone_name}") &&
      !endswith(var.hosted_zone_name, ".${var.privatelink_zone_name}") &&
      !endswith(var.privatelink_zone_name, ".${var.domain_name}") &&
      !endswith(var.privatelink_zone_name, ".${var.hosted_zone_name}")
    )
    error_message = "privatelink_zone_name must not equal, be a parent of, or be a subdomain of domain_name or hosted_zone_name: a private zone with a public service name shadows the public DNS records inside the VPC."
  }
  validation {
    condition     = var.privatelink_zone_name == "" || (var.privatelink_zone_name != "amazonaws.com" && !endswith(var.privatelink_zone_name, ".amazonaws.com"))
    error_message = "privatelink_zone_name must not be amazonaws.com or end in .amazonaws.com: a private zone there shadows AWS service endpoint names inside the VPC."
  }
  validation {
    condition     = var.privatelink_zone_name != "${var.project}.internal"
    error_message = "privatelink_zone_name must not equal the Cloud Map namespace name (<project>.internal); use a separate zone name."
  }
}

variable "privatelink_zone_records_enabled" {
  type        = bool
  default     = false
  nullable    = false
  description = "Create the <key>.<privatelink_zone_name> CNAME records. Leave false on the first apply: an endpoint that still awaits the provider's acceptance has no DNS name yet. After accepting the connections, set true and apply again. Needs privatelink_zone_name. Every apply that adds or removes the zone or records needs allow_dns_changes=true (see docs/runbooks/privatelink-observability.md)."

  validation {
    condition     = !var.privatelink_zone_records_enabled || var.privatelink_zone_name != ""
    error_message = "privatelink_zone_records_enabled requires a non-empty privatelink_zone_name."
  }
}

locals {
  privatelink_enabled      = length(var.privatelink_endpoints) > 0
  privatelink_zone_enabled = local.privatelink_enabled && var.privatelink_zone_name != ""
  # Kinds that have an endpoint. The connector Lambda "<kind>-mcp" (ai.tf local.agent_lambdas) gets
  # that kind's dedicated client security group below, and no other function does.
  # Regional DNS name per endpoint: the entry whose first label has no availability-zone suffix (AWS does not document
  # dns_entry ordering); falls back to the first entry. Empty while the endpoint has no DNS entry yet (pending acceptance); the CNAME records stay behind privatelink_zone_records_enabled and refuse an empty value.
  privatelink_dns = {
    for key, ep in aws_vpc_endpoint.privatelink : key => try(
      [for d in ep.dns_entry : d.dns_name if !can(regex("^[^.]+-[a-z]{2}-[a-z]+-[0-9][a-z]\\.", d.dns_name))][0],
      try(ep.dns_entry[0].dns_name, "")
    )
  }
  privatelink_kinds = toset([for _, e in var.privatelink_endpoints : e.kind])
}

# Dedicated, empty client groups, one per connector kind. A client group carries no rules of its own:
# it exists only as the SINGLE source that kind's endpoint security groups admit. ai.tf attaches it (in
# addition to the shared `service` group, which still provides egress) to that kind's connector Lambda
# and to nothing else. The web tasks, workers and every other Lambda share `service` but not these
# groups, so they cannot reach a PrivateLink datasource, and one kind's connector cannot reach another
# kind's endpoint. The description is immutable once created.
resource "aws_security_group" "privatelink_clients" {
  for_each    = local.privatelink_kinds
  name        = "${var.project}-privatelink-clients-${each.key}"
  description = "Connector Lambdas allowed to use PrivateLink datasource endpoints"
  vpc_id      = local.vpc_id
  tags        = { Name = "${var.project}-privatelink-clients-${each.key}", Kind = each.key }
}

# One endpoint security group per entry, so each entry's port list is its own ceiling. Ingress only from
# that entry's kind client group, only on its ports. No CIDR rules and no egress rule (an endpoint ENI
# never initiates connections).
resource "aws_security_group" "privatelink" {
  for_each    = var.privatelink_endpoints
  name        = "${var.project}-privatelink-${each.key}"
  description = "PrivateLink interface endpoint for a cross-account datasource"
  vpc_id      = local.vpc_id
  tags        = { Name = "${var.project}-privatelink-${each.key}" }
}

resource "aws_vpc_security_group_ingress_rule" "privatelink" {
  for_each = {
    for pair in flatten([
      for key, e in var.privatelink_endpoints : [
        for port in e.ports : { id = "${key}-${port}", key = key, kind = e.kind, port = port }
      ]
    ]) : pair.id => pair
  }

  security_group_id            = aws_security_group.privatelink[each.value.key].id
  referenced_security_group_id = aws_security_group.privatelink_clients[each.value.kind].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  description                  = "PrivateLink clients ${each.key}"
}

resource "aws_vpc_endpoint" "privatelink" {
  for_each = var.privatelink_endpoints

  vpc_id              = local.vpc_id
  vpc_endpoint_type   = "Interface"
  service_name        = each.value.service_name
  subnet_ids          = local.private_subnet_ids
  security_group_ids  = [aws_security_group.privatelink[each.key].id]
  private_dns_enabled = false

  tags = {
    Name    = "${var.project}-privatelink-${each.key}"
    Purpose = "${var.project}-privatelink"
    Kind    = each.value.kind
  }
}

# Optional private zone: short, stable names for the datasource registrations. It is associated
# with this stack's VPC only and is separate from the Cloud Map namespace in steampipe.tf.
# The raw vpce DNS name works without it; the connector keeps the original hostname for Host/SNI.
resource "aws_route53_zone" "privatelink" {
  count   = local.privatelink_zone_enabled ? 1 : 0
  name    = var.privatelink_zone_name
  comment = "${var.project} PrivateLink datasource names"
  vpc {
    vpc_id = local.vpc_id
  }
  tags = { Name = "${var.project}-privatelink-zone" }
}

resource "aws_route53_record" "privatelink" {
  for_each = { for key, e in var.privatelink_endpoints : key => e if local.privatelink_zone_enabled && var.privatelink_zone_records_enabled }

  zone_id = aws_route53_zone.privatelink[0].zone_id
  name    = "${each.key}.${var.privatelink_zone_name}"
  type    = "CNAME"
  ttl     = 60
  records = [local.privatelink_dns[each.key]]

  lifecycle {
    precondition {
      condition     = local.privatelink_dns[each.key] != ""
      error_message = "Endpoint ${each.key} has no DNS name yet (still pending acceptance?). Accept the connection on the provider side, then apply again."
    }
  }
}

# First regional DNS name per endpoint. Register it as the datasource host,
# e.g. http://<value>:<port>. It stays valid while the endpoint exists.
output "privatelink_endpoint_dns" {
  description = "Regional DNS name of each PrivateLink endpoint, keyed by privatelink_endpoints label. Empty until the provider accepts the connection."
  value = {
    for key, ep in aws_vpc_endpoint.privatelink : key => local.privatelink_dns[key]
  }
}

output "privatelink_datasource_hosts" {
  description = "Friendly datasource host per endpoint (<key>.<privatelink_zone_name>); empty when no zone is configured."
  value       = { for key, _ in var.privatelink_endpoints : key => "${key}.${var.privatelink_zone_name}" if local.privatelink_zone_enabled }
}
