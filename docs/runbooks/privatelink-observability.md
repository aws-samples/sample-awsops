# Runbook: PrivateLink to observability datasources in another account

Connect the AgentCore datasource connector Lambdas (ClickHouse, Prometheus, Loki, Tempo, Mimir)
to datasources that run in a **different AWS account**, without a public path, VPC peering or
Transit Gateway. The provider account exposes each datasource's internal NLB as a VPC endpoint
service; this stack creates the consumer interface endpoints (`terraform/foundation/privatelink.tf`).
Governed by ADR-007 (external data governance); nothing here mutates AWS resources through
the product, and the provider-side commands below are operator actions.

## Why PrivateLink

- **Per-service exposure.** The consumer reaches only the exposed NLB listeners, not the provider
  VPC. Each connection needs the provider's explicit acceptance.
- **No route-level trust between accounts.** No peering or Transit Gateway attachment, no route
  table change on either side, and no dependence on the two VPCs' address plans.
- **Private path.** Traffic stays on the AWS network; no NAT, internet gateway or public IP.

## What is out of scope

- The provider account is configured by an operator with the AWS CLI (below), not by this repository.
- Managed Prometheus (AMP) needs SigV4 request signing and is not supported by the datasource
  connectors. Use an in-cluster Prometheus behind an NLB.
- The connector kinds `opensearch`, `jaeger` and `dynatrace` have `*_vpc_enabled` flags but are not accepted by
  `privatelink_endpoints` (supported kinds: clickhouse, prometheus, loki, tempo, mimir).
- Custom MCP over PrivateLink (ADR-007 governed `custom_mcp`; activation is separately gated).
- A datasource in a different **region** than this stack needs cross-region PrivateLink and is not covered.

## Prerequisites

1. The provider datasource runs behind an **internal** NLB (for example created by the AWS Load
   Balancer Controller for a Kubernetes `Service`) with healthy targets.
2. This stack's private subnets sit in distinct Availability Zones (an interface endpoint takes one subnet per AZ).
   The NLB's Availability Zones include the AZs of this stack's private subnets, compared by
   **AZ ID** (for example `apne2-az1`), not by name. Names map differently per account.
3. The provider NLB's security group admits the consumer endpoint's traffic. With security-group
   enforcement for PrivateLink traffic on, admit a **private** range that contains this stack's
   private subnets; never a public CIDR. Prefer the exact subnet CIDRs over a broad range such as `10.0.0.0/8`.
4. This stack has `agentcore_enabled`, `integrations_enabled` and the connector's
   `<kind>_vpc_enabled` flag (`clickhouse_vpc_enabled`, `prometheus_vpc_enabled`, ...) set.

## Provider side (operator, provider account)

Placeholders: `<PROVIDER_NLB_ARN>`, `<CONSUMER_ACCOUNT_ID>`, `<SERVICE_ID>`.

1. Create the endpoint service on the existing internal NLB. Acceptance stays required:

   ```bash
   aws ec2 create-vpc-endpoint-service-configuration --region ap-northeast-2 \
     --network-load-balancer-arns <PROVIDER_NLB_ARN> --acceptance-required \
     --tag-specifications 'ResourceType=vpc-endpoint-service,Tags=[{Key=Name,Value=awsops-<kind>}]'
   ```

2. Allow only the consumer account:

   ```bash
   aws ec2 modify-vpc-endpoint-service-permissions --region ap-northeast-2 \
     --service-id <SERVICE_ID> --add-allowed-principals arn:aws:iam::<CONSUMER_ACCOUNT_ID>:root
   ```

3. Note the service name `com.amazonaws.vpce.<region>.vpce-svc-<id>` from the output. It is not a
   secret, but keep it in the deployment's private Terraform inputs, not in this repository.

An endpoint service exposes **every listener** of the NLB. Ports other than the one the connector
uses stay reachable through the endpoint only if the consumer security group allows them; this
stack opens only the ports listed in `privatelink_endpoints`.

## Consumer side (this stack)

Add to the deployment's private Terraform inputs (placeholders shown; the real service names stay
out of the repository):

```hcl
integrations_enabled   = true
clickhouse_vpc_enabled = true
prometheus_vpc_enabled = true

privatelink_endpoints = {
  clickhouse = { kind = "clickhouse", service_name = "com.amazonaws.vpce.<region>.vpce-svc-<id>", ports = [8123] }
  prometheus = { kind = "prometheus", service_name = "com.amazonaws.vpce.<region>.vpce-svc-<id>", ports = [9090] }
  tempo      = { kind = "tempo",      service_name = "com.amazonaws.vpce.<region>.vpce-svc-<id>", ports = [3200] }
}

# Optional: short, stable names. Leave unset to use the raw endpoint DNS names.
privatelink_zone_name = "obs.awsops.internal"
# Leave false on the first apply; set true after the provider accepts the connections (below).
privatelink_zone_records_enabled = false
```

The zone name must not equal, contain or sit under the deployment's `domain_name` or `hosted_zone_name`, and must not
end in `amazonaws.com`: a private zone with a public service name shadows the public DNS records inside the VPC.

Then plan and apply through the reviewed saved-plan flow (`docs/runbooks/dev-repo-setup.md`); never
`-auto-approve`. `privatelink_zone_name` plans Route 53 changes, which the CI DNS gate rejects by default: add or
remove the zone only on a full (non-domain-rollout) plan with `allow_dns_changes=true` on both the plan and the
apply dispatch. That input is an all-or-nothing DNS grant for that apply, so review the plan for unrelated DNS
changes first. Without a zone, no DNS change is planned. Terraform creates, per entry: one interface endpoint with private DNS **off**, one
endpoint security group (ingress only from a dedicated, rule-less `<project>-privatelink-clients-<kind>` group, only on that
entry's own ports, no CIDR rules). Each client group is attached only to the connector Lambda of its kind (for example
`clickhouse-mcp`); the web tasks, workers, other Lambdas and other kinds' connectors do not carry it, so one datasource's
port is never reachable on another datasource's endpoint, and with a zone name one private hosted zone plus a 60-second CNAME
per endpoint.

Each new endpoint starts in `pendingAcceptance` and has no DNS name yet, so the CNAME records are a second step:

1. **Apply 1** with `privatelink_zone_records_enabled = false`: creates the endpoints (and the zone, if a zone name is set), no records.
2. Accept each connection on the provider side:

   ```bash
   aws ec2 describe-vpc-endpoint-connections --region ap-northeast-2 \
     --filters Name=service-id,Values=<SERVICE_ID> --query 'VpcEndpointConnections[].[VpcEndpointId,VpcEndpointState]'
   aws ec2 accept-vpc-endpoint-connections --region ap-northeast-2 \
     --service-id <SERVICE_ID> --vpc-endpoint-ids <VPC_ENDPOINT_ID>
   ```

3. When every endpoint is `available`, set `privatelink_zone_records_enabled = true` and run **Apply 2**, which creates one CNAME per endpoint.
   A record whose endpoint still has no DNS name fails the plan with a clear message instead of writing an empty record.

With a zone name, each of these applies changes Route 53, so both the plan and the apply dispatch need `allow_dns_changes=true`
(see above). The CI DNS gate and the runtime-rollout policy also refuse Route 53 changes on a domain-rollout or runtime-rollout plan:
use a normal full plan.

## Registering the datasources

Terraform outputs `privatelink_endpoint_dns` (raw regional DNS names) and, with a zone,
`privatelink_datasource_hosts`. Register each datasource in the administrator UI with:

| Datasource | With the zone | Without the zone |
|---|---|---|
| ClickHouse | `http://clickhouse.obs.awsops.internal:8123` | `http://<endpoint DNS from output>:8123` |
| Prometheus | `http://prometheus.obs.awsops.internal:9090` | `http://<endpoint DNS from output>:9090` |
| Tempo | `http://tempo.obs.awsops.internal:3200` | `http://<endpoint DNS from output>:3200` |
| Loki, Mimir | `http://<key>.<zone>:<port>` | `http://<endpoint DNS from output>:<port>` |

- The raw endpoint DNS name works **without** a zone: the VPC resolver returns the endpoint ENIs'
  private IPs. The zone only gives stable, readable names.
- The connector resolves the host at call time, checks every address (private ranges are allowed,
  metadata/loopback/link-local are not), pins the checked IPs and keeps the **original hostname** for
  the HTTP `Host` header and SNI.
- The NLB listeners are plain TCP and the datasources speak HTTP, so there is no TLS on this path, and stored
  datasource credentials travel in cleartext headers inside PrivateLink. For a credentialed datasource, prefer a TLS
  listener on the NLB with a certificate for the registered hostname (use the zone name; the connector keeps the
  hostname for SNI) and register an `https://` address.
- Private targets need the per-account opt-in (`allowPrivate`) for the integrations that use the
  egress guard (`web/lib/agent-resolver.ts`, `web/lib/ssrf-guard.ts`). Datasource routes accept
  private addresses without it. Set the opt-in only for the accounts that need it.

## Verification

1. `terraform output privatelink_endpoint_dns` lists one name per entry, and each endpoint is
   `available` after acceptance.
2. In the administrator UI, run the datasource **connection test** (a bounded real query, not a
   health ping).
3. Invoke the connector once per kind (`SELECT 1`, a Prometheus `up` query, a Tempo search) and confirm data.
4. Security review: `aws ec2 describe-security-groups` shows no `0.0.0.0/0` or `::/0` on the
   endpoint security group; on the provider, `describe-vpc-endpoint-connections` lists only
   the consumer account.

## Troubleshooting

| Symptom | Check |
|---|---|
| Endpoint stays `pendingAcceptance` | Accept it on the provider side (above). |
| Connection test times out | Endpoint SG ports for that entry match `privatelink_endpoints.ports`; NLB targets are healthy; the NLB security group admits the consumer's private range. |
| Name does not resolve | The hosted zone is associated with this stack's VPC; the VPC has DNS support and hostnames enabled. |
| Works, then stops after a provider change | A recreated Kubernetes `Service` creates a **new NLB ARN**. Re-point the endpoint service: `aws ec2 modify-vpc-endpoint-service-configuration --service-id <SERVICE_ID> --add-network-load-balancer-arns <NEW_NLB_ARN> --remove-network-load-balancer-arns <OLD_NLB_ARN>`. |
| Plan rejects `privatelink_endpoints` | Each kind needs its `<kind>_vpc_enabled` flag, `integrations_enabled` and `agentcore_enabled`; the service name must match `com.amazonaws.vpce.<region>.vpce-svc-<hex>`. |

## Rollback

1. Set `privatelink_zone_records_enabled = false` and apply (removes the CNAMEs), then remove the zone name and apply
   again, then remove the entries and apply a third time (each zone/record apply needs `allow_dns_changes=true` as
   described above, on a normal full plan). Removing the entries last lets the connector Lambdas detach from the client
   security groups first; if a security group destroy reports `DependencyViolation` while the ENIs release, wait a few
   minutes and re-run the apply. The
   endpoints, security group, rules, zone and records are destroyed. The connectors keep working
   for every datasource that is still reachable another way.
2. On the provider, reject or delete the connection, then delete the endpoint service:
   `aws ec2 delete-vpc-endpoint-service-configurations --service-ids <SERVICE_ID>`.

## Related

ADR-007 (external data governance), ADR-017 (per-connector host pinning, which the connector's resolved-IP check complements); [datasource-credential-isolation.md](datasource-credential-isolation.md),
[tempo-query-generation.md](tempo-query-generation.md),
[source-sync-observability.md](source-sync-observability.md),
[dev-repo-setup.md](dev-repo-setup.md).
