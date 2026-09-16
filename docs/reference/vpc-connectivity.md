# VPC connectivity

## Feature contract and navigation

On `/inventory/vpc`, the header's **Inter-VPC connections** shortcut jumps to
`#vpc-connectivity`. **View inter-VPC connections** loads VPC choices from the
current account/region inventory scope. Select a **Source VPC**, then **Fetch
connections**; opening the inventory page does not query connectivity. The choice
list is capped at 500 rows, with a notice to narrow scope when the cap is reached.
Rows with unusable identity metadata are excluded with a notice.

The authenticated read-only endpoint is
`GET /api/vpc-connectivity?account=self|12digits&region=...&vpcId=...`.
Supply exactly one account (`self` or a 12-digit account ID), supported region and
VPC ID. The account must be enabled in the registry and the VPC must match that
account/region in inventory. Member accounts use their registered read role.

Results contain the source VPC, `checkedAt`, peering connections, TGW attachment
groups and `incompleteSources`. Peerings show connection state and the remote VPC
ID, account, region and available CIDR. TGW groups show the source attachment and
other VPC attachments on the same TGW, including attachment state and associated
route-table IDs where available.

The VPC page's **Open resource graph** link opens `/topology/infra`, whose default
view is the layout graph. Individual resource graphs use
`/topology/resource/<encoded type:id>` (encode the whole `type:id` path segment).
The existing VPC row detail **Open resource map** action remains available.
**Open network path check** links to `/network-paths`; its feature and live-query
gates still apply.

## Limits and permissions

- These are configuration observations. Peering state, shared TGW membership and
  route-table association do not establish reachability. Check actual routes,
  security groups (SGs) and network ACLs (NACLs) separately.
- Choices and source names/CIDRs come from collected inventory. Connection reads
  may reuse a four-minute cache; `checkedAt` is the connection lookup time, not
  proof of fresh inventory or continuous connectivity.
- Failed, denied, truncated or invalid source reads can retain usable results
  with `incompleteSources`; total lookup failure is an error. Missing metadata
  remains unknown. An empty or partial view does not prove that no connections
  exist outside its readable scope.
- TGW visibility depends on account ownership and sharing. Inspect the TGW owner
  account for the full attachment view; this viewer does not query other owners
  automatically. See AWS's [shared transit gateway considerations](https://docs.aws.amazon.com/vpc/latest/tgw/working-with-transit-gateways.html#transit-gateway-share).
- The effective read role needs `ec2:DescribeVpcPeeringConnections` and
  `ec2:DescribeTransitGatewayAttachments`. AWS documents the respective
  [peering filters and states](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeVpcPeeringConnections.html)
  and [attachment filters and associations](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeTransitGatewayAttachments.html).
  Member access also depends on the existing AssumeRole permissions and trust.

## Validation and rollout

From `web/`, feature validation commands are:

```bash
npx vitest run lib/vpc-connectivity.test.ts app/api/vpc-connectivity/route.test.ts components/inventory/VpcConnectivitySection.test.tsx
npm run build
```

The only infrastructure addition is `ec2:DescribeVpcPeeringConnections` in the
`task_metrics` policy's separate `VpcConnectivityRead` statement in
[`workload.tf`](../../terraform/foundation/workload.tf). Its
`Condition = local.runtime_read_condition` reuses the existing requested-region
allowlist; the existing TGW read action is reused. An operator must review a saved
Terraform plan and apply that same plan through the approved rollout process
before relying on the new grant. Keep generated plans and environment-specific
evidence private. Then deploy the web change through the
[web release runbook](../runbooks/web-release.md).

After deployment, check scoped selection, the 500-row notice, failed/partial reads,
peering and TGW details, all four UI languages and both navigation links. Source
changes and local validation alone do not establish a completed IAM apply or live
deployment.

Implementation: [component](../../web/components/inventory/VpcConnectivitySection.tsx),
[API route](../../web/app/api/vpc-connectivity/route.ts),
[query layer](../../web/lib/vpc-connectivity.ts).
