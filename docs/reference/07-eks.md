# 07. EKS Onboarding — v2 Reference

## Runtime cross-account registration

The web EKS pages support read-only queries for enabled accounts already registered
in `/accounts`. The Terraform onboarding sections below describe the original
host-account provisioning path; its host-only limitation does not apply to manual
runtime registration through the web API.

Account registration and Kubernetes authorization are separate. EKS management API
reads (`ListClusters`, `DescribeCluster`, and `DescribeAccessEntry`) use the selected
account's registered read-only role. For member clusters, the default Kubernetes
bearer also uses that **registered member role's temporary credentials**. Its
`STANDARD` Access Entry and required read policy must exist on the member cluster.
Host clusters retain the web task role as their default identity. Host task-role
bearers are not sent to member endpoints: EKS tokens bind the cluster name, which
does not by itself distinguish same-named clusters in different accounts.
An explicitly saved AssumeRole override for a member must belong to that same
member account; historical out-of-account overrides fail closed. Registering an account
or a cluster in AWSops does not create IAM roles, Access Entries, access policy
associations, or network connectivity.

Existing member configurations that registered only the host web task-role
principal need an Access Entry/read policy for the registered member role before
default member queries can succeed. The generated guide names the required role;
the owner applies it. The app does not add or remove AWS access entries.

Kubernetes access alone does not enable the adjacent data panels. CloudWatch
diagnostics require `cloudwatch:GetMetricData` and `cloudwatch:ListMetrics` on the
selected read role, and Container Insights must actually publish its series.
Node ENI details require the account/region to be in the enabled inventory scan
scope with a completed EC2 inventory collection. A denied query, absent metric
series, and inventory not yet collected are distinct operational conditions.

The cluster list, registration, and subsequent resource reads retain the selected
account and region. Member-account and nondefault-region clusters use their EKS
ARN as the API and registry identifier; the visible cluster name remains separate.
The existing `eks_registrations.cluster_name` text key stores that qualified
identifier, including any authentication override. Existing bare-name registrations
and `ONBOARDED_EKS_CLUSTERS` entries retain their host/deployment-region meaning.
This prevents a same-named host cluster from granting access to, overwriting, or
unregistering a member cluster. It requires no schema migration.

The registration endpoint accepts either a URL-encoded cluster ARN or a bare name
with `?account=<TARGET_ACCOUNT_ID>&region=<REGION>`. It describes that exact target
before checking its Access Entry, rather than searching the first page of the host
account's cluster list. A `404 unknown cluster` therefore means the selected target
was not found; an absent or unverifiable entry remains a separate registration
failure. Invalid or disabled target accounts do not fall back to the host.

The account/region selector refreshes EKS lists and fleet aggregates without a
registration side effect. Queries wait for the persisted selection and discard
responses from an earlier selection. Discovery is bounded to 12 account/region
targets and 25 cluster descriptions per target. Wildcard all-region discovery
includes configured and already-registered regions and explicitly reports that this
is not exhaustive AWS-region discovery; select a specific region to query another
region directly. Fleet selection includes all authorized registered regions under
wildcard scope, with a separate 100-cluster cap. Registration-store failures return
an unavailable result instead of a successful empty fleet. Partial failures and
truncation are returned separately from a successful empty result. Kubernetes
endpoints must still be reachable from the web task, and downstream collectors can
report unsupported scopes separately.

## Terraform host-account provisioning

`make configure` uses `scripts/v2/configure.mjs` to discover host clusters and offer
an EKS multi-select. Its authentication-mode preflight selects clusters using `API`
or `API_AND_CONFIG_MAP`; `CONFIG_MAP`-only clusters require an operator handoff.
The selection becomes `onboard_eks_clusters` in `terraform.tfvars`.

`terraform/foundation/eks.tf` iterates that list to create a `STANDARD` Access Entry
for the web task role and associate a cluster-scoped AWS-managed view policy. It
supplies the `onboarded_eks_clusters` endpoint/ARN/CA output. The always-on task-role
discovery permissions are defined separately in `terraform/foundation/workload.tf`. The CA value comes from
`certificate_authority[0].data`. An empty selection creates no onboarding resources.
This Terraform path provisions host clusters only; it does not provision member
roles, member Access Entries, or cross-account network connectivity.

An operator can separately create an Access Entry and read-policy association.
For host/deployment-region events, the optional `eks_auto_register_enabled` observer
(`scripts/v2/eks/auto_register.py`) can reflect the event into the app registry.
The member/nondefault-region web guide requires manual query registration and does
not promise that the host EventBridge observer will see those events.

## Principal and governance boundaries

The web workflow inherits read-only multi-account discovery from ADR-011. It does
not relax ADR-005: AWS-resource mutation and autonomy remain frozen. Generated
Access Entry commands and OpenCost installation bundles are operator handoffs;
returning a bundle does not execute it or enable an in-app mutation tool.

Host web queries use the web task role; member web queries use the registered
member role by default.
[Network Path Check EKS access](../runbooks/network-path-eks-access.md) describes the
separate worker/target-role principal, and
[Istio agent EKS access](../runbooks/istio-agent-eks-access.md) describes an agent
Lambda principal. An entry for one actor does not grant access to the others.
An explicit saved web AssumeRole override also needs authorization for its own role.

## Key files

| File | Responsibility |
|---|---|
| `terraform/foundation/eks.tf` | Host Terraform onboarding and endpoint/CA output |
| `terraform/foundation/workload.tf` | Always-on web task-role EKS discovery permissions |
| `scripts/v2/configure.mjs` | Host discovery and authentication-mode preflight |
| `web/lib/eks-cluster-id.ts` | Strict name/ARN parsing and display labels |
| `web/lib/eks-context.ts` | Canonical account/region identity, selector conflicts, enabled member scope |
| `web/lib/eks-role.ts` | Registered member-role ARN and same-account authentication checks |
| `web/lib/eks-registry.ts` | Legacy host and qualified runtime registrations, cached read quality, saved auth |
| `web/lib/eks-scope.ts` | Collection selection, wildcard disclosure, discovery and fleet limits |
| `web/lib/eks-access.ts` | Target metadata and Access Entry checks for the applicable host/member principal |
| `web/lib/eks-incluster.ts` | Scoped endpoint/CA cache, bearer construction, read-only Kubernetes transport |
| `web/app/api/eks/` | Discovery, registration, fleet, summary, and detail routes |
| `web/app/eks/`, `web/components/eks/` | Scope-aware views, qualified requests, stale-response protection |

See the [API reference](../api-reference.md#eks-10) for response status and metadata
contracts, including conditional envelope `region`, partial `errors`, and `truncated`.
NFM pod-transfer attribution remains host/deployment-region only; member and other
region requests return explicit unavailability rather than a host namesake's data.

## Verification and historical scope

P1e originally established host Access Entry/view-policy onboarding and exposed
connection metadata for later Kubernetes views. Those views and runtime query
registration are now implemented; the original P3 deferral is historical.

The 2026-08-11 assessment recorded four host-role Access Entries, including clusters
added outside Terraform. That dated snapshot is not a current inventory or an
exhaustive statement of Terraform ownership. Compare the actual Access Entries,
policy associations, `ONBOARDED_EKS_CLUSTERS`, and `eks_registrations` to establish
current state. Source support and unit/browser checks do not prove a deployed
role's permissions, API-server reachability, or completed rollout.
