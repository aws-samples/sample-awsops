# VPC connectivity

## Feature contract and navigation

This bounded, read-only viewer stays within ADR-005. It enables no AWS-resource
mutation or autonomous action and needs no new ADR or exception.

On `/inventory/vpc`, the header's **Inter-VPC connections** shortcut jumps to
`#vpc-connectivity`; the section remains available while the inventory table loads
or fails. **View inter-VPC connections** loads VPC choices from the current
account/region inventory scope. Select a **Source VPC**, then **Fetch connections**;
opening the inventory page does not query connectivity. The choice list is capped
at 500 rows, with a notice to narrow scope when the cap is reached. Rows with
unusable identity metadata or unsupported regions are excluded with a notice.
Refreshing the choices preserves the selected VPC if it is still available. A
failed refresh shows an error without claiming that the scope has no VPCs.

The VPC page's **Open resource graph** link opens `/topology/infra`, whose default
view is the layout graph. Individual resource graphs use
`/topology/resource/<encoded type:id>` (encode the whole `type:id` path segment).
The existing VPC row detail **Open resource map** action remains available.
**Open network path check** links to `/network-paths`; its feature and live-query
gates still apply.

## API, authorization and owner disclosure

`GET /api/vpc-connectivity?account=self&region=<REGION>&vpcId=<VPC_ID>` calls
`verifyUser(request.headers.get('cookie'))` before validating scope or reading data.
Supply exactly one `account` (`self` or a 12-digit account ID), `region` and `vpcId`.
Input regions must pass `isVpcConnectivityRegion`, shared by the picker and API
validation in `web/lib/vpc-connectivity-scope.ts`. Its current allowlist contains
34 commercial regions; aggregate scopes, unlisted regions, China and GovCloud
regions are rejected.
Missing, repeated or invalid scope parameters return `invalid_request`/400.
The [API index](../api-reference.md#vpc-connectivity-1) lists every stable
code-to-status mapping. All responses use `Cache-Control: private, no-store`.

Authorization uses the enabled account registry and an exact match on the indexed
`inventory_resources.account_id`, `region`, `resource_id` and `resource_type='vpc'`.
The indexed account is the **collecting account**. A selected host account, whether
specified as `self` or its actual account ID, maps to the inventory key `self`;
`source.accountId` contains the resolved account ID. Host reads use the web task's
credentials; member reads use that collecting account's registered read role.

Results contain the source VPC, `checkedAt`, peering records, TGW attachment groups
and two required arrays: `limitations: Array<'shared-vpc' | 'owner-unknown' |
'shared-tgw'>` and `incompleteSources: string[]`. Structural visibility limits are
separate from operational read gaps:

| Signal | Meaning |
|--------|---------|
| `limitations: ['shared-vpc']` | The disclosed VPC owner differs from the collecting account. |
| `limitations: ['owner-unknown']` | The VPC owner is unknown. |
| `limitations: ['shared-tgw']` | A source attachment belongs to a TGW owned by another account; the collecting account's attachment view may be limited. |
| Nonempty `incompleteSources` | Reads failed, were denied or truncated, or contained conflicting or malformed evidence. Usable records can still be returned. |

Limitations can occur together. Neither structural limits nor missing optional
peer fields alone mark an operational read as incomplete. Either nonempty array
prevents a definitive "no connections" claim, including when both record lists
are empty.

`source.ownerId: string | null` comes solely from validated inventory
`data.owner_id`; missing or invalid owner metadata becomes `null`. It is a
disclosure signal only, never an authorization key or a credential selector.
JSON owner metadata cannot change the indexed collecting-account scope. The UI
shows the owner account or **unknown** and explains shared-VPC visibility limits.
A participant-visible shared VPC does not authorize reads in its owner's account.
The viewer keeps the selected collecting account's credentials and does not query
another owner automatically; owner-side inspection requires a separately
authorized scope.

## Connection records and lifecycle

Peerings retain their connection ID and state even when remote details are
reduced, including pending records. Each of `peer.vpcId`, `peer.accountId`,
`peer.region` and `peer.cidr` is `string | null`; absent optional fields remain
unknown without marking the whole read incomplete. Present but malformed metadata
marks the affected source in `incompleteSources`. Provider-reported peer regions
are validated syntactically, independently of the input-region allowlist, so a
valid future peer region can be displayed without enabling queries in that region.

The UI labels `active` peerings and `available` TGW attachments as active connection
records. Other states remain visible with **current connection not confirmed**
guidance; only active peerings show a connection arrow. TGW groups show the source
attachment and **VPC attachment records on this TGW**, with each attachment's state
qualified. This list is not an assertion that every listed VPC is currently connected.

Source and peer attachments both expose `routeTableId: string | null` and
`associationState: string | null`. **Associated TGW route table** is shown only when
the attachment state is `available` and `associationState` is `associated`. Every
other combination is labeled as a TGW route-table association record, showing the
table ID and association state or **unknown**. Pending and historical records are
retained as configuration evidence; they do not prove a current connection or a
working network path.

## Limits and permissions

| Bound | Behavior |
|-------|----------|
| Global lookup deadline | 18 seconds shared by registry and inventory reads, credential acquisition, SDK retries and every page. |
| In-flight lookups | At most 8 distinct connectivity reads per process; admission beyond that limit returns `lookup_failed`/502. Requests for the same key share the pending read. |
| Cache | At most 64 results with no operational read gaps per process, each reusable for four minutes from `checkedAt`, including results with structural limitations. |
| Paginated reads | At most 5 pages and 500 rows per read: each peering direction, source TGW attachments and TGW neighbors. The neighbor limit is shared across all selected TGWs, not allocated per gateway. |
| Source TGWs | At most 10 source attachments are retained, bounding the neighbor query to at most 10 source TGWs; excess evidence is marked incomplete. |

The cache and in-flight keys include collecting account, region, VPC ID and owner
identity, including unknown ownership. A changed owner cannot reuse evidence from
a previous owner identity. Cache admission requires `incompleteSources` to be empty;
`limitations` does not prevent caching when operational reads are complete.
Results with operational gaps are never cached, so a retry reads AWS again and can
recover after a transient failure or permission change. A retry can still be
incomplete if that gap persists; structural visibility limits alone do not imply
that another read will reveal more records. `checkedAt` is stamped at read
completion and is preserved when a cached result is returned. This process-local
cache does not change the HTTP `private, no-store` policy.

- These are configuration observations. Peering state, shared TGW membership and
  route-table association do not establish reachability. Check actual routes,
  security groups (SGs) and network ACLs (NACLs) separately.
- Choices and source names/CIDRs come from collected inventory. Connection reads
  may reuse cached evidence with structural limitations; `checkedAt` is the
  read-completion time, not proof of fresh inventory or continuous connectivity.
- Failed, denied, truncated, conflicting or malformed source reads can retain
  usable results with `incompleteSources`; total lookup failure is an error.
  Missing optional metadata remains unknown. An empty or partial view does not
  prove that no connections exist outside its readable scope.
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
`Condition = local.runtime_read_condition` uses the requested-region allowlist in
[`runtime-read-scope.tf`](../../terraform/foundation/runtime-read-scope.tf). When
`core_runtime_enabled=false`, this new host-role grant permits only `var.region`
and `us-east-1`. The existing `ec2:DescribeTransitGatewayAttachments` action predates
this feature and remains unconditioned in `task_metrics`; it does not inherit the
new peering statement's region condition. A valid input region outside those two
can therefore return TGW evidence while peering reads are denied and disclosed as
incomplete. Effective member-account access depends on that member's registered
role and trust, not this host-role grant.

An operator must review a saved Terraform plan and apply that same plan through the
approved rollout process before relying on the new grant. Keep generated plans and
environment-specific evidence private. Then deploy the web change through the
[web release runbook](../runbooks/web-release.md).

After deployment, check scoped selection and refresh retention, the 500-row and
unsupported-choice notices, owner/unknown and shared-TGW guidance, caching with
structural limits, and fresh reads after operational failures. Check reduced peer
details, lifecycle and association labels, all four UI languages and navigation
while the inventory table loads or fails. Source changes and local validation
alone do not establish a completed IAM apply or live deployment.

Implementation: [component](../../web/components/inventory/VpcConnectivitySection.tsx),
[API route](../../web/app/api/vpc-connectivity/route.ts),
[query layer](../../web/lib/vpc-connectivity.ts).
