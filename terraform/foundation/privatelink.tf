# Private connectivity from the connector Lambdas to observability datasources that run in
# ANOTHER AWS account, over AWS PrivateLink interface endpoints. Default-off: an empty
# `privatelink_endpoints` map creates nothing (plan = no changes, $0).
#
# The provider account exposes each datasource's internal NLB as a VPC endpoint service
# (docs/runbooks/privatelink-observability.md). This file only creates the CONSUMER side.
# No provider-side resource, route table, peering or private hosted zone is involved:
# the connector uses the endpoint's regional DNS name (output below) as the datasource address.

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
    condition     = alltrue([for k, _ in var.privatelink_endpoints : can(regex("^[a-z0-9][a-z0-9-]{0,30}$", k))])
    error_message = "privatelink_endpoints keys must be 1-31 characters: lowercase letters, digits and hyphens, starting with a letter or digit."
  }
  validation {
    condition     = alltrue([for _, e in var.privatelink_endpoints : contains(["clickhouse", "prometheus", "loki", "tempo", "mimir"], e.kind)])
    error_message = "privatelink_endpoints kind must be one of clickhouse, prometheus, loki, tempo, mimir."
  }
  validation {
    condition     = alltrue([for _, e in var.privatelink_endpoints : can(regex("^com\\.amazonaws\\.vpce\\.[a-z0-9-]+\\.vpce-svc-[0-9a-f]+$", e.service_name))])
    error_message = "privatelink_endpoints service_name must be an endpoint service name: com.amazonaws.vpce.<region>.vpce-svc-<hex id>."
  }
  validation {
    condition     = alltrue([for _, e in var.privatelink_endpoints : length(e.ports) > 0 && length(e.ports) <= 4 && alltrue([for p in e.ports : p >= 1 && p <= 65535 && p == floor(p)])])
    error_message = "privatelink_endpoints ports must list 1-4 integer TCP ports between 1 and 65535."
  }
  validation {
    condition = alltrue([for _, e in var.privatelink_endpoints : (
      e.kind == "clickhouse" ? var.clickhouse_vpc_enabled :
      e.kind == "prometheus" ? var.prometheus_vpc_enabled :
      e.kind == "loki" ? var.loki_vpc_enabled :
      e.kind == "tempo" ? var.tempo_vpc_enabled :
      var.mimir_vpc_enabled
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
  description = "Optional private DNS zone name (for example obs.awsops.internal) that gives each PrivateLink endpoint a short, stable name <key>.<zone>. Empty (default) → no zone; the endpoint's regional vpce DNS name is used directly. Only takes effect when privatelink_endpoints is non-empty. Lowercase, at least two labels, no trailing dot."

  validation {
    condition     = var.privatelink_zone_name == "" || (length(var.privatelink_zone_name) <= 253 && can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.privatelink_zone_name)))
    error_message = "privatelink_zone_name must be a lowercase DNS name with at least two labels and no trailing dot."
  }
  validation {
    condition     = var.privatelink_zone_name != "${var.project}.internal"
    error_message = "privatelink_zone_name must not equal the Cloud Map namespace name (<project>.internal); use a separate zone name."
  }
}

locals {
  privatelink_enabled      = length(var.privatelink_endpoints) > 0
  privatelink_zone_enabled = local.privatelink_enabled && var.privatelink_zone_name != ""
  # Connector Lambda keys (ai.tf local.agent_lambdas) for the kinds that have an endpoint. Only these
  # functions get the dedicated client security group below.
  privatelink_client_connectors = toset([for _, e in var.privatelink_endpoints : "${e.kind}-mcp"])
}

# Dedicated, empty client group. It carries no rules of its own: it exists only as the SINGLE source
# the endpoint security group admits. ai.tf attaches it (in addition to the shared `service` group,
# which still provides egress) to the connector Lambdas whose kind has an endpoint, and to nothing else.
# The web tasks, workers and every other Lambda share `service` but not this group, so they cannot
# reach a PrivateLink datasource. The description is immutable once created.
resource "aws_security_group" "privatelink_clients" {
  count       = local.privatelink_enabled ? 1 : 0
  name        = "${var.project}-privatelink-clients"
  description = "Connector Lambdas allowed to use PrivateLink datasource endpoints"
  vpc_id      = local.vpc_id
  tags        = { Name = "${var.project}-privatelink-clients" }
}

# The endpoint ENIs accept traffic only from the dedicated client group, only on the listed
# ports. No CIDR rules and no egress rule (an endpoint ENI never initiates connections).
resource "aws_security_group" "privatelink" {
  count       = local.privatelink_enabled ? 1 : 0
  name        = "${var.project}-privatelink-sg"
  description = "PrivateLink interface endpoints for cross-account datasources"
  vpc_id      = local.vpc_id
  tags        = { Name = "${var.project}-privatelink-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "privatelink" {
  for_each = {
    for pair in flatten([
      for key, e in var.privatelink_endpoints : [
        for port in e.ports : { id = "${key}-${port}", port = port }
      ]
    ]) : pair.id => pair.port
  }

  security_group_id            = aws_security_group.privatelink[0].id
  referenced_security_group_id = aws_security_group.privatelink_clients[0].id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
  description                  = "PrivateLink clients ${each.key}"
}

resource "aws_vpc_endpoint" "privatelink" {
  for_each = var.privatelink_endpoints

  vpc_id              = local.vpc_id
  vpc_endpoint_type   = "Interface"
  service_name        = each.value.service_name
  subnet_ids          = local.private_subnet_ids
  security_group_ids  = [aws_security_group.privatelink[0].id]
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
  for_each = { for key, e in var.privatelink_endpoints : key => e if local.privatelink_zone_enabled }

  zone_id = aws_route53_zone.privatelink[0].zone_id
  name    = "${each.key}.${var.privatelink_zone_name}"
  type    = "CNAME"
  ttl     = 60
  records = [aws_vpc_endpoint.privatelink[each.key].dns_entry[0].dns_name]
}

# First regional DNS name per endpoint. Register it as the datasource host,
# e.g. http://<value>:<port>. It stays valid while the endpoint exists.
output "privatelink_endpoint_dns" {
  description = "Regional DNS name of each PrivateLink endpoint, keyed by privatelink_endpoints label."
  value = {
    for key, ep in aws_vpc_endpoint.privatelink : key => ep.dns_entry[0].dns_name
  }
}

output "privatelink_datasource_hosts" {
  description = "Friendly datasource host per endpoint (<key>.<privatelink_zone_name>); empty when no zone is configured."
  value       = { for key, _ in var.privatelink_endpoints : key => "${key}.${var.privatelink_zone_name}" if local.privatelink_zone_enabled }
}
